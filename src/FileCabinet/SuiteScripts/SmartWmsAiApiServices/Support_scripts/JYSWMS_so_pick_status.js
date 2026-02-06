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

        try {
            var newRecord = context.newRecord;
            var recId = newRecord.id;
            var recType = newRecord.type;
            var customerId = newRecord.getValue({ fieldId: 'entity' });
            // if (recId !== 62395735) { // Test SO ID, remove this line in production
            //     return;
            // }
            // log.debug('afterSubmit', 'Record Type: ' + recType + ', Record ID: ' + recId);

            var isJysWmsEnabled = search.lookupFields({
                type: record.Type.CUSTOMER,
                id: customerId,
                columns: ['custentity_jyswms_enable']
            }).custentity_jyswms_enable;

            if (!isJysWmsEnabled) {
                return;
            }

            var apiResult = sendData(recId);
            if (!apiResult.success) {
                log.error('API Call Failed', apiResult.error || 'Unknown error');
                return;
            }

            if (!apiResult.response) {
               // log.error('API Error', 'Empty response');
                return;
            }

            var responseObj = JSON.parse(apiResult.response || '{}');
           log.debug('API Response for SO ID ' + recId, JSON.stringify(responseObj));
            var sourceArray = [];
            if (responseObj.completed && responseObj.completed.length > 0) {
                sourceArray = responseObj.completed;
            } else if (responseObj.notcompleted && responseObj.notcompleted.length > 0) {
                sourceArray = responseObj.notcompleted;
            }
            //log.debug('Source Array', JSON.stringify(sourceArray));
            if (sourceArray.length === 0) {
               // log.debug('No Data for Record ID ' + recId, 'No completed or notcompleted records found');
                return;
            }

            /** Build map: item => picked qty */
            var pickedQtyMap = {};

            sourceArray[0].data.forEach(function (line) {
                if (line.is_picked === 'picked') {
                    var qty = parseFloat(line.quantity) || 0;
                    pickedQtyMap[line.item] = (pickedQtyMap[line.item] || 0) + qty;
                }
            });
            log.debug('Picked Qty Map', JSON.stringify(pickedQtyMap));
            if (Object.keys(pickedQtyMap).length === 0) {
                log.debug('No Picked Items', 'No picked items found in API response');
                return;
            }

            /** Load Sales Order for update */
            var soRec = record.load({
                type: recType,
                id: recId,
                isDynamic: false
            });

            var lineCount = soRec.getLineCount({ sublistId: 'item' });

            for (var i = 0; i < lineCount; i++) {
                var itemText = soRec.getSublistText({
                    sublistId: 'item',
                    fieldId: 'item',
                    line: i
                });

                if (pickedQtyMap[itemText] != null) {
                    soRec.setSublistValue({
                        sublistId: 'item',
                        fieldId: 'custcol_jyswms_picked_qty',
                        line: i,
                        value: Number(pickedQtyMap[itemText])
                    });
                }
            }

            soRec.save({
                enableSourcing: false,
                ignoreMandatoryFields: true
            });

            log.debug('Success', 'Picked quantities updated successfully');

        } catch (e) {
            log.error('afterSubmit Error', e);
        }
    }

    /** Sends data to external API using parameters */
    function sendData(recId) {
        const token = tokenModule.generateToken();
        if (!token) {
            return;
        }


        try {
            const response = https.get({
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
            return { success: false, error: e.message };
        }
    }

    return {
        afterSubmit: afterSubmit
    };
});