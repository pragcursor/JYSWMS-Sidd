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
            if (customerId == 476 || customerId == 1807) {
                log.debug('Skipping JYS WMS Logic', 'Customer excluded: ' + customerId);
                return;
            }

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
            var orderStatus = newRecord.getValue('orderstatus'); // A = Pending Approval

            if (!approvalDone && orderStatus === 'A' && (customerId !== 476 && customerId !== 1807)) {

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

            if (!sourceArray || sourceArray.length === 0) return;
            if (!sourceArray[0].data || sourceArray[0].data.length === 0) return;
            
            // -----------------------------
            // BUILD PICKED MAP (lineuniquekey → qty)
            // -----------------------------

            var pickedMap = {};

            sourceArray[0].data.forEach(function (line) {

                if (line.is_picked === 'picked' && line.unique_id) {

                    // Remove suffix after underscore
                    var cleanUniqueId = line.unique_id.split('_')[0];

                    var qty = parseFloat(line.quantity) || 0;

                    if (qty > 0) {
                        pickedMap[String(cleanUniqueId)] = qty;
                    }
                }
            });

            if (Object.keys(pickedMap).length === 0) {
               // log.debug('No picked lines returned from API');
                return;
            }

            // -----------------------------
            // LOAD SALES ORDER FOR UPDATE
            // -----------------------------

            var soRec = record.load({
                type: recType,
                id: recId,
                isDynamic: false
            });

            var lineCount = soRec.getLineCount({ sublistId: 'item' });

            for (var i = 0; i < lineCount; i++) {

                var lineUniqueKey = soRec.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'lineuniquekey',
                    line: i
                });

                if (!lineUniqueKey) continue;

                if (!pickedMap[String(lineUniqueKey)]) continue;

                var qtyToApply = pickedMap[String(lineUniqueKey)];

                soRec.setSublistValue({
                    sublistId: 'item',
                    fieldId: 'custcol_jyswms_picked_qty',
                    line: i,
                    value: qtyToApply
                });

                log.debug('Updated line',
                    'LineUniqueKey: ' + lineUniqueKey +
                    ' | Qty: ' + qtyToApply
                );
            }

            soRec.save({
                enableSourcing: false,
                ignoreMandatoryFields: true
            });

            log.audit('Picked quantities updated (by unique id)', 'SO ID ' + recId);

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