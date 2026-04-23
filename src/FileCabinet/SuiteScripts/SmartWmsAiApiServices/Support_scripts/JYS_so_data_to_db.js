/**
 *@NApiVersion 2.1
 *@NScriptType UserEventScript
 */

define([
    'N/log',
    'N/https',
    'N/record',
    '../JYSWMS_generateToken_API',
    '../Orders/orderUtils'
], function (log, https, record, tokenModule, autoLocUtil) {

    // =====================================================
    // SEND DATA TO WMS
    // =====================================================

    function sendData(payload) {
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

    function afterSubmit(context) {

        try {

            if (context.type !== context.UserEventType.EDIT) return;

            const newRec = context.newRecord;
            const oldRec = context.oldRecord;

            const soId = newRec.id;
            const tranId = newRec.getValue({ fieldId: 'tranid' });

            let shouldTrigger = false;

            // -------------------------------
            // Ensure shipdate exists
            // -------------------------------
            const shipdate = newRec.getValue({ fieldId: 'shipdate' });

            if (!shipdate) {
                const orderdate = newRec.getValue({ fieldId: 'trandate' });

                record.submitFields({
                    type: record.Type.SALES_ORDER,
                    id: soId,
                    values: { shipdate: orderdate }
                });

                log.debug('Shipdate Auto Set', tranId);
            }

            // -------------------------------
            // Status check
            // -------------------------------
            const status = newRec.getValue({ fieldId: 'status' });
            const exclude = ['closed', 'cancelled', 'billed'];

            if (exclude.includes(status.toLowerCase())) return;

            // =====================================================
            // CUSTOMER CHANGE
            // =====================================================
            const oldCustomer = oldRec.getValue({ fieldId: 'entity' });
            const newCustomer = newRec.getValue({ fieldId: 'entity' });

            if (oldCustomer !== newCustomer) {
                log.debug('Customer Changed', { tranId });
                shouldTrigger = true;
            }

            // =====================================================
            // SHIP METHOD CHANGE
            // =====================================================
            const oldShipMethod = oldRec.getValue({ fieldId: 'shipmethod' });
            const newShipMethod = newRec.getValue({ fieldId: 'shipmethod' });

            if (oldShipMethod && oldShipMethod !== newShipMethod) {
                log.debug('Ship Method Changed', { tranId });
                shouldTrigger = true;
            }

            // =====================================================
            // SHIPPING ADDRESS CHANGE
            // =====================================================
            const oldAddr = oldRec.getSubrecord({ fieldId: 'shippingaddress' });
            const newAddr = newRec.getSubrecord({ fieldId: 'shippingaddress' });

            if (oldAddr && newAddr) {

                const fields = ['addr1', 'addr2', 'city', 'state', 'zip', 'country'];

                for (let f of fields) {

                    const oldVal = oldAddr.getValue({ fieldId: f });
                    const newVal = newAddr.getValue({ fieldId: f });

                    if (oldVal !== newVal) {
                        log.debug('Shipping Address Changed', { field: f, tranId });
                        shouldTrigger = true;
                        break;
                    }
                }
            }

            // =====================================================
            // LINE-LEVEL CHANGE DETECTION (STRONG VERSION)
            // =====================================================

            const oldLineCount = oldRec.getLineCount({ sublistId: 'item' });
            const newLineCount = newRec.getLineCount({ sublistId: 'item' });

            // Quick check: line count change (item added/removed)
            if (oldLineCount !== newLineCount) {
                log.debug('Item Line Count Changed', { tranId });
                shouldTrigger = true;
            }

            // Build maps for comparison
            let oldLines = {};
            let newLines = {};

            for (let i = 0; i < oldLineCount; i++) {
                const item = oldRec.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i });
                const desc = oldRec.getSublistValue({ sublistId: 'item', fieldId: 'description', line: i });
                const type = oldRec.getSublistValue({ sublistId: 'item', fieldId: 'itemtype', line: i });

                oldLines[i] = { item, desc, type };
            }

            for (let i = 0; i < newLineCount; i++) {
                const item = newRec.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i });
                const desc = newRec.getSublistValue({ sublistId: 'item', fieldId: 'description', line: i });
                const type = newRec.getSublistValue({ sublistId: 'item', fieldId: 'itemtype', line: i });

                newLines[i] = { item, desc, type };
            }

            // Compare line by line
            const maxLines = Math.max(oldLineCount, newLineCount);

            for (let i = 0; i < maxLines; i++) {

                const oldLine = oldLines[i];
                const newLine = newLines[i];

                // Item added
                if (!oldLine && newLine) {
                    log.debug('Item Added', { line: i, tranId });
                    shouldTrigger = true;
                    break;
                }

                // Item removed
                if (oldLine && !newLine) {
                    log.debug('Item Removed', { line: i, tranId });
                    shouldTrigger = true;
                    break;
                }

                if (!oldLine || !newLine) continue;

                // Item changed
                if (oldLine.item !== newLine.item) {
                    log.debug('Item Changed', { line: i, tranId });
                    shouldTrigger = true;
                    break;
                }

                // -----------------------------------------
                // YOUR LOGIC (NonInvtPart description)
                // -----------------------------------------
                if (newLine.type === 'NonInvtPart') {

                    if (oldLine.desc !== newLine.desc) {
                        log.debug('NonInvtPart Description Changed', { line: i, tranId });
                        shouldTrigger = true;
                        emptystatus(soId);
                        break;
                    }
                }
            }

            // =====================================================
            // FINAL TRIGGER
            // =====================================================

            if (shouldTrigger) {
                processOrder(soId, tranId);
            }

        } catch (e) {
            log.error('afterSubmit Error', e);
            storeErrorOnSO(context.newRecord.id, e.message);
        }
    }


    // =====================================================
    // PROCESS ORDER
    // =====================================================

    function processOrder(soId, tranId) {

        try {

            log.debug('Processing Order for WMS', tranId);

            const payload = {
                salesOrderHeaderId: soId
            };

            const responseJson = autoLocUtil.getDropShipOrders_helperfunction(payload);

            if (!responseJson || responseJson.status !== 200) {
                log.error('Internal API Failed', responseJson);
            }

            const apiResponse = sendData(responseJson);

            if (!apiResponse.success) {
                log.error('WMS Sync Failed', apiResponse);
                storeErrorOnSO(soId, apiResponse.message);
                return;
            }

            log.audit('WMS Sync Success', tranId);

        } catch (e) {
            log.error('Process Order Error', e);
            storeErrorOnSO(soId, e.message);
        }
    }


    // =====================================================
    // UTIL FUNCTIONS
    // =====================================================

    function emptystatus(soId) {
        try {
            record.submitFields({
                type: record.Type.SALES_ORDER,
                id: soId,
                values: {
                    custbody_parts_jy_wms_status: ' '
                },
                options: {
                    enableSourcing: false,
                    ignoreMandatoryFields: true
                }
            });
        } catch (e) {
            log.error('Failed to empty error status on SO', e);
        }
    }

    function storeErrorOnSO(soId, message) {
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
    }

    return {
        afterSubmit
    };

});