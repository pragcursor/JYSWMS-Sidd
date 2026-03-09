/**
 *@NApiVersion 2.1
 *@NScriptType UserEventScript
 */
define(['N/log', 'N/https', '../JYSWMS_generateToken_API.js', '../Orders/orderUtils.js',], function (log, https, tokenModule, autoLocUtil) {

    // =========================================================
    // SEND DATA
    // =========================================================
    const sendData = (payload) => {

        // log.audit('SEND DATA - START', JSON.stringify(payload));

        const token = tokenModule.generateToken();
        if (!token) {
            log.error('SEND DATA - Token Failed', 'Token generation failed');
            return;
        }

        try {
            const response = https.post({
                url: 'https://api.jyswms.com/netsuite/dropship/store-orders',
                headers: {
                    'Authorization': 'Bearer ' + token,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            // log.audit('SEND DATA - RESPONSE', {
            //     code: response.code,
            //     body: response.body
            // });

            return {
                success: response.code === 200,
                response: response.body || ''
            };

        } catch (e) {
            log.error('SEND DATA - ERROR', e);
            return { success: false, error: e.message };
        }
    };

    function afterSubmit(context) {
        var rec = context.newRecord;
        var type = context.type;
        var oldRec = context.oldRecord;

        if (type === context.UserEventType.EDIT) {
            var soId = rec.id;
            
            var jsysEnabled = rec.getValue('custbody_jys_enabled_customer');
            if (!jsysEnabled) {
                return;
            }
            var tranId = rec.getValue('tranid');
            var shipaddress = rec.getValue('shipaddress');
            var oldShipAddress = oldRec.getValue('shipaddress');
            var shipvia = rec.getValue('shipmethod');
            var oldShipVia = oldRec.getValue('shipmethod');
            if (shipaddress !== oldShipAddress || shipvia !== oldShipVia) {
                var logMsg = 'SO ID: ' + soId + ', Tran ID: ' + tranId + ', Old Ship Address: ' + oldShipAddress + ', New Ship Address: ' + shipaddress + ', Old Ship Via: ' + oldShipVia + ', New Ship Via: ' + shipvia;
                log.audit('Shipping Address or Ship Via Changed', logMsg);

                var lineCount = rec.getLineCount({ sublistId: 'item' });
                var updatedItemIds = new Set();

                for (var i = 0; i < lineCount; i++) {

                    var itemId = rec.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'item',
                        line: i
                    });

                    var closed = rec.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'isclosed',
                        line: i
                    });

                    var qtyFulfilled = parseFloat(rec.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'quantityfulfilled',
                        line: i
                    })) || 0;

                    // ✅ Skip closed lines
                    if (closed === true || closed === 'T') {
                        continue;
                    }

                    // ✅ Skip fulfilled (partial or full)
                    if (qtyFulfilled > 0) {
                        continue;
                    }

                    // Only open & unfulfilled items
                    updatedItemIds.add(itemId);
                }

                const payload = {
                    salesOrderHeaderId: soId,
                    salesOrderItemId: Array.from(updatedItemIds)
                };
                const responseJson = autoLocUtil.getOrdersDUP(payload);
                if (responseJson && responseJson.success) {
                    log.audit('API Response Success', JSON.stringify(responseJson));
                    sendData(responseJson);
                }

            }
        }
    }
    return {
        afterSubmit: afterSubmit
    }
});
