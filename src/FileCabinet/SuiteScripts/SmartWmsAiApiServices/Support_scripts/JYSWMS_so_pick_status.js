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

        if (context.type !== context.UserEventType.EDIT) return;

        var recId, recType;

        try {

            var newRecord = context.newRecord;
            recId = newRecord.id;
            recType = newRecord.type;

            var customerId = newRecord.getValue({ fieldId: 'entity' });
            if (!customerId) return;

            // -----------------------------
            // CUSTOMER VALIDATION
            // -----------------------------
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
            handleAutoApproval(newRecord, recId, customerId, customerName);

            // -----------------------------
            // CALL WMS API
            // -----------------------------
            var apiResult = sendData(recId);

            if (!apiResult.success || !apiResult.response) {
                log.error('API Call Failed', apiResult.error || 'No response');
                return;
            }

            var responseObj;
            try {
                responseObj = JSON.parse(apiResult.response);
            } catch (e) {
                log.error('Invalid JSON Response', apiResult.response);
                return;
            }

            var sourceArray = getSourceArray(responseObj);

            if (!sourceArray.length || !sourceArray[0].data || !sourceArray[0].data.length) {
                log.debug('No line data from WMS', 'SO ' + recId);
                return;
            }

            // -----------------------------
            // BUILD MAPS
            // -----------------------------
            var maps = buildMaps(sourceArray);

            // -----------------------------
            // UPDATE SALES ORDER
            // -----------------------------
            updateSalesOrder(recType, recId, maps);

        } catch (e) {
            log.error('afterSubmit Error SO ' + recId, e);
        }
    }

    // =====================================================
    // NORMALIZE KEY
    // =====================================================
    function normalizeKey(val) {
        if (!val) return '';
        return String(val).split('_')[0]; // handles _1, _1_1, etc.
    }

    // =====================================================
    // AUTO APPROVAL
    // =====================================================
    function handleAutoApproval(newRecord, recId, customerId, customerName) {

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
    }

    // =====================================================
    // GET SOURCE ARRAY
    // =====================================================
    function getSourceArray(responseObj) {

        if (responseObj.completed && responseObj.completed.length) {
            return responseObj.completed;
        }

        if (responseObj.notcompleted && responseObj.notcompleted.length) {
            return responseObj.notcompleted;
        }

        return [];
    }

    // =====================================================
    // BUILD MAPS
    // =====================================================
    function buildMaps(sourceArray) {

        var returnedMap = {};
        var itemQtyMap = {};
        var dbQtyMap = {};
        var readyForPickMap = {};
        var readyForPickItemMap = {};
        var apiLineExistsMap = {};

        sourceArray[0].data.forEach(function (line) {

            if (!line || !line.unique_id) return;

            var key = normalizeKey(line.unique_id);
            var item = line.item;

            apiLineExistsMap[key] = true;

            // -----------------------------
            // PICKED QTY
            // -----------------------------
            var isPicked = String(line.is_picked || '').toLowerCase();

            var pickedQty = (isPicked === 'picked')
                ? Number(line.quantity) || 0
                : 0;

            returnedMap[key] = (returnedMap[key] || 0) + pickedQty;

            if (item) {
                itemQtyMap[item] = (itemQtyMap[item] || 0) + pickedQty;
            }

            // -----------------------------
            // DB QTY
            // -----------------------------
            var dbQty = Number(line.quantity) || 0;
            dbQtyMap[key] = (dbQtyMap[key] || 0) + dbQty;

            // -----------------------------
            // READY FOR PICK
            // -----------------------------
            var readyQty;

            if (line.ready_for_pick === true || line.ready_for_pick === 'true') {
                readyQty = dbQty;
            } else {
                readyQty = Number(line.ready_for_pick) || 0;
            }

            readyForPickMap[key] = (readyForPickMap[key] || 0) + readyQty;

            if (item) {
                readyForPickItemMap[item] = (readyForPickItemMap[item] || 0) + readyQty;
            }

        });

        return {
            returnedMap: returnedMap,
            itemQtyMap: itemQtyMap,
            dbQtyMap: dbQtyMap,
            readyForPickMap: readyForPickMap,
            readyForPickItemMap: readyForPickItemMap,
            apiLineExistsMap: apiLineExistsMap
        };
    }

    // =====================================================
    // UPDATE SALES ORDER (FIXED LOGIC)
    // =====================================================
    function updateSalesOrder(recType, recId, maps) {

        var soRec = record.load({
            type: recType,
            id: recId,
            isDynamic: false
        });

        var lineCount = soRec.getLineCount({ sublistId: 'item' });

        for (var i = 0; i < lineCount; i++) {

            var rawKey = soRec.getSublistValue({
                sublistId: 'item',
                fieldId: 'lineuniquekey',
                line: i
            });

            var key = normalizeKey(rawKey);

            var itemText = soRec.getSublistText({
                sublistId: 'item',
                fieldId: 'item',
                line: i
            });

            var hasExactMatch = maps.apiLineExistsMap.hasOwnProperty(key);

            var pickedQty = 0;
            var readyQty = 0;
            var dbQty = 0;

            // =============================
            // EXACT MATCH → ALWAYS UPDATE
            // =============================
            if (hasExactMatch) {

                pickedQty = maps.returnedMap[key] || 0;
                readyQty = maps.readyForPickMap[key] || 0;
                dbQty = maps.dbQtyMap[key] || 0;

            } 
            // =============================
            // FALLBACK (ONLY IF NO MATCH)
            // =============================
            else {

                pickedQty = maps.itemQtyMap[itemText] || 0;
                readyQty = maps.readyForPickItemMap[itemText] || 0;

                // dbQty stays 0 (no fallback)
            }

            // -----------------------------
            // SET VALUES (ALWAYS WRITE)
            // -----------------------------
            soRec.setSublistValue({
                sublistId: 'item',
                fieldId: 'custcol_jyswms_picked_qty',
                line: i,
                value: pickedQty
            });

            soRec.setSublistValue({
                sublistId: 'item',
                fieldId: 'custcol_jys_ready_for_pick',
                line: i,
                value: readyQty
            });

            soRec.setSublistValue({
                sublistId: 'item',
                fieldId: 'custcol_jys_db_qty',
                line: i,
                value: dbQty
            });
        }

        soRec.save({
            enableSourcing: false,
            ignoreMandatoryFields: true
        });

        log.audit('Sales Order Synced From WMS (Strict Line Logic)', 'SO ID ' + recId);
    }

    // =====================================================
    // API CALL
    // =====================================================
    function sendData(recId) {

        try {

            var token = tokenModule.generateToken();
            if (!token) {
                return { success: false, error: 'Token generation failed' };
            }

            var response = https.get({
                url: 'https://api.jyswms.com/dropship-sales-order-status?sales_order_id=' + recId,
                headers: {
                    'Authorization': 'Bearer ' + token
                }
            });

            return {
                success: response.code === 200,
                response: response.body
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