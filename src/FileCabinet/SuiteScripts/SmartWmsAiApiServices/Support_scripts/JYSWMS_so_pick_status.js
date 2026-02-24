/**
 * @NApiVersion 2.x
 * @NScriptType UserEventScript
 */
define([
    'N/log',
    'N/https',
    'N/search',
    'N/record',
    '../JYSWMS_generateToken_API.js'
], function (log, https, search, record, tokenModule) {

    function afterSubmit(context) {

        if (context.type !== context.UserEventType.CREATE &&
            context.type !== context.UserEventType.EDIT) {
            return;
        }

        var recId, recType;

        try {

            var newRecord = context.newRecord;
            recId = newRecord.id;
            recType = newRecord.type;

            var customerId = newRecord.getValue({ fieldId: 'entity' });
            if (!customerId) return;

            // Skip excluded customers
            // if (customerId == 476 || customerId == 1807) {
            //     return;
            // }

            // Lookup customer WMS flag
            var customerLookup = search.lookupFields({
                type: record.Type.CUSTOMER,
                id: customerId,
                columns: ['custentity_jyswms_enable', 'entityid']
            });

            var isEnabled = customerLookup.custentity_jyswms_enable;
            if (!isEnabled) return;

            var customerName = customerLookup.entityid;

            // -----------------------------
            // AUTO APPROVAL LOGIC
            // -----------------------------

            var approvalDone = newRecord.getValue('custbody_jyswms_approval_processed');
            var orderStatus = newRecord.getValue('orderstatus');

            if (!approvalDone && orderStatus === 'A' && (customerId != 476 && customerId != 1807)) {

                record.submitFields({
                    type: record.Type.SALES_ORDER,
                    id: recId,
                    values: {
                        orderstatus: 'B',
                        custbody_reason_approval: 'JYS WMS Auto Approval',
                        custbody_jyswms_approval_processed: true
                    },
                    options: {
                        enableSourcing: false,
                        ignoreMandatoryFields: true
                    }
                });

                log.audit(
                    'Sales Order Auto Approved (' + customerName + ')',
                    'SO ID ' + recId
                );
            }

            // -----------------------------
            // CALL EXTERNAL API
            // -----------------------------

            var apiResult = sendData(recId);

            if (!apiResult || !apiResult.success || !apiResult.response) {
                log.error('API Call Failed', apiResult ? apiResult.error : 'No response');
                return;
            }

            var responseObj = JSON.parse(apiResult.response || '{}');

            var sourceArray = [];

            if (responseObj.completed && responseObj.completed.length > 0) {
                sourceArray = responseObj.completed;
            } else if (responseObj.notcompleted && responseObj.notcompleted.length > 0) {
                sourceArray = responseObj.notcompleted;
            }

            if (!sourceArray.length || !sourceArray[0].data || !sourceArray[0].data.length) {
                return;
            }

            // -----------------------------
            // BUILD RETURN MAP
            // lineuniquekey → qty (0 if not picked)
            // -----------------------------

            var returnedMap = {};

            sourceArray[0].data.forEach(function (line) {

                if (!line.unique_id) return;

                var cleanUniqueId = line.unique_id.split('_')[0];
                var key = String(cleanUniqueId);

                if (line.is_picked === 'picked') {
                    returnedMap[key] = parseFloat(line.quantity) || 0;
                } else {
                    returnedMap[key] = 0;
                }

            });

            if (!Object.keys(returnedMap).length) return;

            // -----------------------------
            // LOAD SALES ORDER
            // -----------------------------

            var soRec = record.load({
                type: recType,
                id: recId,
                isDynamic: false
            });

            var lineCount = soRec.getLineCount({ sublistId: 'item' });
            var hasChanges = false;
            
            for (var i = 0; i < lineCount; i++) {

                var lineUniqueKey = soRec.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'lineuniquekey',
                    line: i
                });

                if (!lineUniqueKey) continue;

                var key = String(lineUniqueKey);

                // Only update if line exists in JSON
                if (!returnedMap.hasOwnProperty(key)) continue;

                var newQty = returnedMap[key];

                var currentQty = soRec.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'custcol_jyswms_picked_qty',
                    line: i
                }) || 0;

              //  if (Number(currentQty) !== Number(newQty)) 
                    {

                    soRec.setSublistValue({
                        sublistId: 'item',
                        fieldId: 'custcol_jyswms_picked_qty',
                        line: i,
                        value: newQty
                    });

                    hasChanges = true;

                    log.debug('Line Updated',
                        'LineUniqueKey: ' + key +
                        ' | Item: ' + soRec.getSublistText({ sublistId: 'item', fieldId: 'item', line: i }) +
                        ' | Old: ' + currentQty +
                        ' | New: ' + newQty
                    );
                }
            }

            // -----------------------------
            // SAVE ONLY IF CHANGED
            // -----------------------------

            if (hasChanges) {

                soRec.save({
                    enableSourcing: false,
                    ignoreMandatoryFields: true
                });

                log.audit('Picked quantities updated', 'SO ID ' + recId);

            } else {
               // log.debug('No changes detected — skipping save()', 'SO ID ' + recId);
            }

        } catch (e) {

            log.error('afterSubmit Error for SO ID ' + recId, e);
        }
    }

    // -----------------------------
    // SEND DATA TO JYS WMS API
    // -----------------------------

    function sendData(recId) {

        try {

            var token = tokenModule.generateToken();
            if (!token) {
                return { success: false, error: 'Token generation failed' };
            }

            var response = https.get({
                url: 'https://api.jyswms.com/dropship-sales-order-status?sales_order_id=' + recId,
                headers: {
                    'Authorization': 'Bearer ' + token,
                    'Content-Type': 'application/json'
                }
            });

            return {
                success: response.code === 200,
                response: response.body || ''
            };

        } catch (e) {

            log.error('sendData Error', e.message);

            return {
                success: false,
                error: e.message
            };
        }
    }

    return {
        afterSubmit: afterSubmit
    };
});