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

        if (context.type !== context.UserEventType.EDIT) {
            return;
        }

        var recId, recType;

        try {

            var newRecord = context.newRecord;
            recId = newRecord.id;
            recType = newRecord.type;

            var customerId = newRecord.getValue({ fieldId: 'entity' });
            if (!customerId) return;

            var customerLookup = search.lookupFields({
                type: record.Type.CUSTOMER,
                id: customerId,
                columns: ['custentity_jyswms_enable', 'entityid']
            });

            if (!customerLookup.custentity_jyswms_enable) return;

            var customerName = customerLookup.entityid;

            // -----------------------------
            // AUTO APPROVAL
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

                log.audit('Sales Order Auto Approved (' + customerName + ')', 'SO ID ' + recId);
            }

            // -----------------------------
            // CALL WMS API
            // -----------------------------

            var apiResult = sendData(recId);

            if (!apiResult || !apiResult.success || !apiResult.response) {
                log.error('API Call Failed', apiResult ? apiResult.error : 'No response');
                return;
            }

            // var responseObj = JSON.parse(apiResult.response || '{}');

            var responseObj;

            try {
                responseObj = JSON.parse(apiResult.response || '{}');
            } catch (e) {
                log.error('Invalid JSON Response', apiResult.response);
                return;
            }

            var sourceArray = [];

            if (responseObj.completed && responseObj.completed.length) {
                sourceArray = responseObj.completed;
            } else if (responseObj.notcompleted && responseObj.notcompleted.length) {
                sourceArray = responseObj.notcompleted;
            }

            if (!sourceArray.length || !sourceArray[0].data || !sourceArray[0].data.length) {
                log.debug('No line data returned from WMS', 'SO ID ' + recId);
                return;
            }

            // -----------------------------
            // MAP API RESPONSE
            // -----------------------------

            var returnedMap = {};        // lineuniquekey → picked qty
            var itemQtyMap = {};         // fallback
            var readyForPickMap = {};    // lineuniquekey → ready for pick qty
            var shipErrorHeaderArray = [];
            var dbQtyMap = {};           // NEW → quantity from API

            try {

                // sourceArray[0].data.forEach(function (line) {

                //     if (!line.unique_id) return;

                //     // var key = String(line.unique_id);
                //     var key = String(line.unique_id.split('_')[0]);


                //     // -----------------------------
                //     // PICKED QTY
                //     // -----------------------------

                //     var pickedQty = 0;

                //     if (line.is_picked === 'picked') {
                //         pickedQty = parseFloat(line.quantity) || 0;
                //     }

                //     if (!returnedMap[key]) {
                //         returnedMap[key] = 0;
                //     }

                //     returnedMap[key] += pickedQty;

                //     // -----------------------------
                //     // DB QTY (FROM API quantity)
                //     // -----------------------------

                //     var dbQty = parseFloat(line.quantity) || 0;

                //     if (!dbQtyMap[key]) {
                //         dbQtyMap[key] = 0;
                //     }

                //     dbQtyMap[key] += dbQty;


                //     // fallback by item
                //     if (line.item) {

                //         if (!itemQtyMap[line.item]) {
                //             itemQtyMap[line.item] = 0;
                //         }

                //         itemQtyMap[line.item] += pickedQty;
                //     }

                //     // -----------------------------
                //     // READY FOR PICK QTY
                //     // -----------------------------

                //     var readyQty = parseFloat(line.ready_for_pick) || 0;
                //    // log.debug('Line Ready For Pick', 'Line ' + key + ' | Ready Qty: ' + readyQty);

                //     if (!readyForPickMap[key]) {
                //         readyForPickMap[key] = 0;
                //     }

                //     readyForPickMap[key] += readyQty;

                // });

                sourceArray[0].data.forEach(function (line) {

                    if (!line.unique_id) return;

                    // remove "_1"
                    var key = String(line.unique_id.split('_')[0]);

                    // -----------------------------
                    // PICKED QTY
                    // -----------------------------

                    var pickedQty = 0;

                    if (line.is_picked === 'picked') {
                        pickedQty = parseFloat(line.quantity) || 0;
                    }

                    if (!returnedMap[key]) {
                        returnedMap[key] = 0;
                    }

                    returnedMap[key] += pickedQty;

                    // -----------------------------
                    // DB QTY (FROM API quantity)
                    // -----------------------------

                    var dbQty = parseFloat(line.quantity) || 0;

                    if (!dbQtyMap[key]) {
                        dbQtyMap[key] = 0;
                    }

                    dbQtyMap[key] += dbQty;

                    // -----------------------------
                    // READY FOR PICK
                    // -----------------------------

                    var readyQty = parseFloat(line.ready_for_pick) || 0;

                    if (!readyForPickMap[key]) {
                        readyForPickMap[key] = 0;
                    }

                    readyForPickMap[key] += readyQty;

                });
            } catch (e) {

                log.error('JSON Mapping Error SO ' + recId, e);
            }
            // log.debug('readyForPickMap', JSON.stringify(readyForPickMap));
            // log.debug('readyForPickMap Keys', Object.keys(readyForPickMap));
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

                var itemText = soRec.getSublistText({
                    sublistId: 'item',
                    fieldId: 'item',
                    line: i
                });

                var key = String(lineUniqueKey);


                var newQty = 0;

                // -----------------------------
                // PRIMARY MATCH (lineuniquekey)
                // -----------------------------

                if (returnedMap.hasOwnProperty(key)) {

                    newQty = returnedMap[key];

                } else {

                    // -----------------------------
                    // FALLBACK MATCH (item)
                    // -----------------------------

                    if (itemQtyMap.hasOwnProperty(itemText)) {

                        newQty = itemQtyMap[itemText];

                        log.debug('Fallback Item Match',
                            'Item: ' + itemText + ' | Qty: ' + newQty);
                    }
                }

                var currentQtyRaw = soRec.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'custcol_jyswms_picked_qty',
                    line: i
                });

                var currentQty = Number(currentQtyRaw) || 0;

                if (currentQtyRaw === '' || currentQtyRaw === null || Number(currentQty) !== Number(newQty)) {

                    soRec.setSublistValue({
                        sublistId: 'item',
                        fieldId: 'custcol_jyswms_picked_qty',
                        line: i,
                        value: newQty
                    });

                    hasChanges = true;


                    log.debug('Picked Qty Updated',
                        'SO ' + recId +
                        ' | Item ' + itemText +
                        ' | Old ' + currentQty +
                        ' | New ' + newQty);
                }

                // -----------------------------
                // READY FOR PICK UPDATE
                // -----------------------------

                if (readyForPickMap.hasOwnProperty(key)) {

                    var readyQty = readyForPickMap[key];

                    var currentReadyQty = soRec.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'custcol_jys_ready_for_pick',
                        line: i
                    }) || 0;

                    if (Number(currentReadyQty) !== Number(readyQty)) {

                        soRec.setSublistValue({
                            sublistId: 'item',
                            fieldId: 'custcol_jys_ready_for_pick',
                            line: i,
                            value: readyQty
                        });

                        hasChanges = true;

                        log.debug(
                            'Ready For Pick Updated',
                            'SO ' + recId +
                            ' | Item ' + itemText +
                            ' | Ready Qty ' + readyQty
                        );
                    }
                }

                // -----------------------------
                // DB QTY UPDATE
                // -----------------------------

                if (dbQtyMap.hasOwnProperty(key)) {

                    var dbQty = dbQtyMap[key];

                    var currentDbQty = soRec.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'custcol_jys_db_qty',
                        line: i
                    }) || 0;

                    if (Number(currentDbQty) !== Number(dbQty)) {

                        soRec.setSublistValue({
                            sublistId: 'item',
                            fieldId: 'custcol_jys_db_qty',
                            line: i,
                            value: dbQty
                        });

                        hasChanges = true;

                        log.debug(
                            'DB Qty Updated',
                            'SO ' + recId +
                            ' | Item ' + itemText +
                            ' | DB Qty ' + dbQty
                        );
                    }
                }
            }

            // -----------------------------
            // SHIP ERROR HEADER
            // -----------------------------

            if (shipErrorHeaderArray.length > 0) {

                soRec.setValue({
                    fieldId: 'custbody_jys_ship_erros',
                    value: shipErrorHeaderArray.join(', ')
                });

            } else {

                soRec.setValue({
                    fieldId: 'custbody_jys_ship_erros',
                    value: ''
                });
            }

            // -----------------------------
            // SAVE RECORD
            // -----------------------------

            if (hasChanges) {

                soRec.save({
                    enableSourcing: false,
                    ignoreMandatoryFields: true
                });

                log.audit('Sales Order Updated From WMS', 'SO ID ' + recId);
            }

        } catch (e) {

            log.error('afterSubmit Error SO ' + recId, e);
        }
    }

    // -----------------------------
    // CALL WMS API
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