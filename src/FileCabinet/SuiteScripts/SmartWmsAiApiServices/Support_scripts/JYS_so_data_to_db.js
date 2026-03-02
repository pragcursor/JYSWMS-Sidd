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
            var tranId = rec.getValue('tranid');
            var shipaddress = rec.getValue('shipaddress');
            var oldShipAddress = oldRec.getValue('shipaddress');
            if (shipaddress !== oldShipAddress) {
                var logMsg = 'SO ID: ' + soId + ', Tran ID: ' + tranId + ', Old Ship Address: ' + oldShipAddress + ', New Ship Address: ' + shipaddress;
                log.audit('Shipping Address Changed', logMsg);

                var lineCount = rec.getLineCount('item');
                var updatedItemIds = new Set();

                for (var i = 0; i < lineCount; i++) {
                    var itemId = rec.getSublistValue('item', 'id', i);
                    var closed = rec.getSublistValue('item', 'isclosed', i);

                    if (closed === true || closed === 'T') {
                        continue; // Skip closed lines
                    }
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
