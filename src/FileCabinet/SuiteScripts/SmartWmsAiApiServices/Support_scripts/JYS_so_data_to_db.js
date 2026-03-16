/**
 *@NApiVersion 2.1
 *@NScriptType UserEventScript
 */

define([
    'N/log',
    'N/https',
    'N/record',
    '../JYSWMS_generateToken_API.js',
    '../Orders/orderUtils.js'
], function (log, https, record, tokenModule, autoLocUtil) {


    // =====================================================
    // SEND DATA TO WMS (YOUR ORIGINAL FUNCTION)
    // =====================================================

    const sendData = (payload) => {

        try {

            const token = tokenModule.generateToken();

            if (!token) {

                log.error('Token Generation Failed', 'WMS token missing');

                return { success: false };
            }

            const response = https.post({

                url: 'https://api.jyswms.com/update-dropship-lines?closed=false',

                headers: {
                    'Authorization': 'Bearer ' + token,
                    'Content-Type': 'application/json'
                },

                body: JSON.stringify(payload)

            });

            log.audit('WMS API Response', {
                code: response.code,
                body: response.body
            });

            return {
                success: response.code === 200,
                response: response.body
            };

        } catch (e) {

            log.error('WMS API Error', e);
            storeErrorOnSO(payload.salesOrderHeaderId, e.message);
            return {
                success: false,
                error: e.message
            };
        }
    };


    // =====================================================
    // MAIN USER EVENT
    // =====================================================

    const afterSubmit = (context) => {

        try {

            if (context.type !== context.UserEventType.EDIT) return;

            const newRec = context.newRecord;
            const oldRec = context.oldRecord;

            const soId = newRec.id;
            const tranId = newRec.getValue({ fieldId: 'tranid' });
            var status = newRec.getValue({ fieldId: 'status' });
            const exclude = ['closed', 'cancelled', 'billed'];

            if (exclude.includes(status.toLowerCase())) {
                // log.debug('Excluded Status', {
                //     tranId,
                //     status
                // });
                return;
            }

            // log.audit('SO Edit Triggered', tranId);

            // -------------------------------------------------
            // SHIP METHOD CHANGE CHECK
            // -------------------------------------------------

            const oldShipMethod = oldRec.getValue({ fieldId: 'shipmethod' });
            const newShipMethod = newRec.getValue({ fieldId: 'shipmethod' });

            // if(soId == 60122234){
            //     log.debug('Debug SO', {
            //         tranId,
            //         oldShipMethod,
            //         newShipMethod
            //     });
            // }

            if (oldShipMethod && oldShipMethod !== newShipMethod) {

                log.debug('Ship Method Changed', {
                    tranId,
                    oldShipMethod,
                    newShipMethod
                });

                processOrder(soId, tranId);
                return;
            }


            // -------------------------------------------------
            // SHIPPING ADDRESS CHANGE CHECK
            // -------------------------------------------------

            const oldAddr = oldRec.getSubrecord({ fieldId: 'shippingaddress' });
            const newAddr = newRec.getSubrecord({ fieldId: 'shippingaddress' });

            if (!oldAddr || !newAddr) {

                log.debug('Shipping Address Missing', tranId);
                return;
            }

            const fields = ['addr1', 'addr2', 'city', 'state', 'zip', 'country'];

            for (let f of fields) {

                const oldVal = oldAddr.getValue({ fieldId: f });
                const newVal = newAddr.getValue({ fieldId: f });

                if (!oldVal) continue;

                if (oldVal !== newVal) {

                    log.debug('Shipping Address Changed', {
                        field: f,
                        oldVal,
                        newVal,
                        tranId
                    });

                    processOrder(soId, tranId);
                    return;
                }
            }

            // log.debug('No Shipping Changes Detected', tranId);

        }

        catch (e) {

            log.error('afterSubmit Error', e);
            storeErrorOnSO(context.newRecord.id, e.message);
        }

    };


    // =====================================================
    // PROCESS ORDER
    // =====================================================

    const processOrder = (soId, tranId) => {

        try {

            log.debug('Processing Order for WMS', tranId);

            const payload = {
                salesOrderHeaderId: soId
            };

            const responseJson = autoLocUtil.getDropShipOrders_helperfunction(payload);

            if (!responseJson || !(responseJson.status == 200)) {

                log.error('Internal API Failed', responseJson);
                //return;
            }

            log.debug('Internal Util Response', responseJson);

            const apiResponse = sendData(responseJson);

            if (!apiResponse.success) {

                log.error('WMS Sync Failed', apiResponse);
                storeErrorOnSO(soId, apiResponse.message);
                return;
            }

            log.audit('WMS Sync Success', tranId);

        }

        catch (e) {

            log.error('Process Order Error', e);
            storeErrorOnSO(soId, e.message);

        }

    };


    const storeErrorOnSO = (soId, message) => {

        try {

            record.submitFields({
                type: record.Type.SALES_ORDER,
                id: soId,
                values: {
                    custbody_wms_sync_error: message
                },
                options: {
                    enableSourcing: false,
                    ignoreMandatoryFields: true
                }
            });

        } catch (e) {
            log.error('Failed to store error on SO', e);
        }

    };


    return {
        afterSubmit
    };

});