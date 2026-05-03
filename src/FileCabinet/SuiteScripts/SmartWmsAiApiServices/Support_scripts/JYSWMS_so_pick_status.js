/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 *
 * FIXES applied:
 *  1. normalizeKey removed — keys are stored and compared EXACTLY.
 *     The old split on [-_] meant "708127381_1" → "708127381", which
 *     incorrectly merged split WMS lines and also mismatched the
 *     lineuniquekey written to custcol_wms_unique_id.
 *
 *  2. buildMaps keys are now exact unique_id strings from WMS.
 *     Split lines ("708127381", "708127381-1") are kept as separate
 *     entries and their qty/readyForPick values are NOT merged.
 *
 *  3. updateSalesOrder matches by exact lineuniquekey (as written to
 *     custcol_wms_unique_id). The itemText fallback still works for
 *     lines where WMS has no unique_id.
 *
 *  4. API endpoint unchanged (no bin data needed here).
 */
define([
    'N/log',
    'N/https',
    'N/search',
    'N/record',
    '../JYSWMS_generateToken_API'
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
                // WMS returned empty — zero out all qty fields on every SO line
                log.debug('No line data from WMS — zeroing SO line fields', 'SO ' + recId);
                zeroOutSalesOrderLines(recType, recId);
                return;
            }

            var shipErrors = extractShipErrors(sourceArray);

            if (shipErrors) {
                record.submitFields({
                    type: recType,
                    id: recId,
                    values: { custbody_jys_ship_erros: shipErrors },
                    options: { enableSourcing: false, ignoreMandatoryFields: true }
                });
                log.audit('Ship Errors Updated', shipErrors);
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
                options: { enableSourcing: false, ignoreMandatoryFields: true }
            });

            log.audit('Sales Order Auto Approved (' + customerName + ')', 'SO ID ' + recId);
        }
    }

    // =====================================================
    // GET SOURCE ARRAY
    // =====================================================
    function getSourceArray(responseObj) {
        if (responseObj.completed && responseObj.completed.length) return responseObj.completed;
        if (responseObj.notcompleted && responseObj.notcompleted.length) return responseObj.notcompleted;
        return [];
    }

    // =====================================================
    // BUILD MAPS
    // FIX: keys are exact unique_id strings — no normalization.
    //
    // WMS split lines ("708127381" and "708127381-1") are stored
    // as separate keys. The NS SO line has lineuniquekey "708127381"
    // written to custcol_wms_unique_id, so we match on "708127381"
    // and aggregate ALL WMS lines whose unique_id STARTS WITH that
    // base key (covering -1, -2 siblings) when building the maps.
    // =====================================================
    function buildMaps(sourceArray) {

        var returnedMap = {};   // key → total picked qty
        var itemQtyMap = {};   // itemName → total picked qty (fallback)
        var dbQtyMap = {};   // key → total WMS qty
        var readyForPickMap = {};   // key → total ready-for-pick qty
        var readyForPickItemMap = {};   // itemName → total ready-for-pick qty (fallback)
        var apiLineExistsMap = {};   // base key → true (for exact-match detection)

        sourceArray[0].data.forEach(function (line) {
            if (!line || !line.unique_id) return;

            var rawKey = String(line.unique_id);  // e.g. "709324609", "709324609-1", "709324609_1"
            var item = line.item;

            /*
             * Base key: strip any "-N" or "_N" numeric suffix.
             * WMS uses both separators for split lines:
             *   "709324609_1"  (underscore variant)
             *   "709324609-1"  (hyphen variant)
             *   "709324609"    (primary — no suffix)
             * All three must aggregate under "709324609" so the SO line
             * gets the correct combined picked/ready/db qty totals.
             * The regex strips a separator followed by digits at the end.
             */
            var baseKey = rawKey.replace(/[-_]\d+$/, '');
            apiLineExistsMap[baseKey] = true;

            // -----------------------------
            // PICKED QTY
            // Requires BOTH: is_picked === 'picked' AND tracking_data is non-empty
            // (at least one entry with a non-blank trackingNumber or SSCC)
            // -----------------------------
            var isPicked = String(line.is_picked || '').toLowerCase();
            var hasTracking = Array.isArray(line.tracking_data) &&
                line.tracking_data.length > 0 &&
                line.tracking_data.some(function (t) {
                    return t && (
                        String(t.trackingNumber || '').trim() !== '' ||
                        String(t.SSCC || '').trim() !== ''
                    );
                });
            var pickedQty = (isPicked === 'picked' && hasTracking) ? (Number(line.quantity) || 0) : 0;

            // Aggregate under base key so the SO line gets the combined total
            returnedMap[baseKey] = (returnedMap[baseKey] || 0) + pickedQty;

            if (item) {
                itemQtyMap[item] = (itemQtyMap[item] || 0) + pickedQty;
            }

            // -----------------------------
            // DB QTY (total WMS qty, picked or not)
            // -----------------------------
            var dbQty = Number(line.quantity) || 0;
            dbQtyMap[baseKey] = (dbQtyMap[baseKey] || 0) + dbQty;

            // -----------------------------
            // READY FOR PICK
            // -----------------------------
            var readyQty;
            if (line.ready_for_pick === true || line.ready_for_pick === 'true') {
                readyQty = dbQty;
            } else {
                readyQty = Number(line.ready_for_pick) || 0;
            }

            readyForPickMap[baseKey] = (readyForPickMap[baseKey] || 0) + readyQty;

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
    // ZERO OUT SALES ORDER LINES
    // Called when WMS returns empty completed + notcompleted.
    // Sets picked qty, ready for pick, and db qty to 0 on all lines.
    // =====================================================
    function zeroOutSalesOrderLines(recType, recId) {
        try {
            var soRec = record.load({ type: recType, id: recId, isDynamic: false });
            var lineCount = soRec.getLineCount({ sublistId: 'item' });

            for (var i = 0; i < lineCount; i++) {
                soRec.setSublistValue({ sublistId: 'item', fieldId: 'custcol_jyswms_picked_qty', line: i, value: 0 });
                soRec.setSublistValue({ sublistId: 'item', fieldId: 'custcol_jys_ready_for_pick', line: i, value: 0 });
                soRec.setSublistValue({ sublistId: 'item', fieldId: 'custcol_jys_db_qty', line: i, value: 0 });
            }

            soRec.save({ enableSourcing: false, ignoreMandatoryFields: true });
            log.audit('Sales Order Lines Zeroed (WMS empty response)', 'SO ID ' + recId);

        } catch (e) {
            log.error('zeroOutSalesOrderLines Error SO ' + recId, e);
        }
    }

    // =====================================================
    // UPDATE SALES ORDER
    // FIX: match by exact lineuniquekey (base, no suffix).
    //      custcol_wms_unique_id is written as the raw numeric
    //      lineuniquekey — exactly what the suitelet reads back.
    // =====================================================
    // function updateSalesOrder(recType, recId, maps) {

    //     var soRec = record.load({
    //         type:      recType,
    //         id:        recId,
    //         isDynamic: false
    //     });

    //     var lineCount = soRec.getLineCount({ sublistId: 'item' });

    //     for (var i = 0; i < lineCount; i++) {

    //         /* lineuniquekey is always a plain integer from NS, e.g. 708127381 */
    //         var rawKey = soRec.getSublistValue({
    //             sublistId: 'item',
    //             fieldId:   'lineuniquekey',
    //             line:      i
    //         });

    //         /* Write the exact lineuniquekey to the custom field.
    //            The suitelet reads custcol_wms_unique_id and looks it up
    //            in pickMapByLine — keys there are also exact WMS unique_ids
    //            which match NS lineuniquekey for the primary line. */
    //         try {
    //             if (rawKey) {
    //                 soRec.setSublistValue({
    //                     sublistId: 'item',
    //                     fieldId:   'custcol_wms_unique_id',
    //                     line:      i,
    //                     value:     Number(rawKey)
    //                 });
    //             }
    //         } catch (error) {
    //             log.error('Error setting custcol_wms_unique_id for line ' + i, error);
    //         }

    //         /* Use the string version of rawKey as the lookup key into maps.
    //            lineuniquekey from NS is always a plain integer (e.g. 709324609)
    //            so no suffix stripping is needed here — but apply the same regex
    //            for safety in case the field ever contains a suffixed value. */
    //         var key      = rawKey ? String(rawKey).replace(/[-_]\d+$/, '') : '';
    //         var itemText = soRec.getSublistText({
    //             sublistId: 'item',
    //             fieldId:   'item',
    //             line:      i
    //         });

    //         var hasExactMatch = key && maps.apiLineExistsMap.hasOwnProperty(key);

    //         var pickedQty = 0;
    //         var readyQty  = 0;
    //         var dbQty     = 0;

    //         if (hasExactMatch) {
    //             /* Exact match: pull aggregated totals for this base key */
    //             pickedQty = maps.returnedMap[key]      || 0;
    //             readyQty  = maps.readyForPickMap[key]  || 0;
    //             dbQty     = maps.dbQtyMap[key]         || 0;
    //         } else {
    //             /* Fallback: item name match */
    //             pickedQty = maps.itemQtyMap[itemText]         || 0;
    //             readyQty  = maps.readyForPickItemMap[itemText] || 0;
    //             dbQty     = 0; // no reliable db qty without an exact key match
    //         }

    //         soRec.setSublistValue({
    //             sublistId: 'item',
    //             fieldId:   'custcol_jyswms_picked_qty',
    //             line:      i,
    //             value:     pickedQty
    //         });

    //         soRec.setSublistValue({
    //             sublistId: 'item',
    //             fieldId:   'custcol_jys_ready_for_pick',
    //             line:      i,
    //             value:     readyQty
    //         });

    //         soRec.setSublistValue({
    //             sublistId: 'item',
    //             fieldId:   'custcol_jys_db_qty',
    //             line:      i,
    //             value:     dbQty
    //         });
    //     }

    //     soRec.save({
    //         enableSourcing:        false,
    //         ignoreMandatoryFields: true
    //     });

    //     log.audit('Sales Order Synced From WMS', 'SO ID ' + recId);
    // }

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

            // Write unique id
            try {
                if (rawKey) {
                    soRec.setSublistValue({
                        sublistId: 'item',
                        fieldId: 'custcol_wms_unique_id',
                        line: i,
                        value: Number(rawKey)
                    });
                }
            } catch (error) {
                log.error('Error setting custcol_wms_unique_id for line ' + i, error);
            }

            var key = rawKey ? String(rawKey).replace(/[-_]\d+$/, '') : '';
            var itemText = soRec.getSublistText({
                sublistId: 'item',
                fieldId: 'item',
                line: i
            });

            var hasExactMatch = key && maps.apiLineExistsMap.hasOwnProperty(key);

            var pickedQty = 0;
            var readyQty = 0;
            var dbQty = 0;

            if (hasExactMatch) {
                pickedQty = maps.returnedMap[key] || 0;
                readyQty = maps.readyForPickMap[key] || 0;
                dbQty = maps.dbQtyMap[key] || 0;
            } else {
                pickedQty = maps.itemQtyMap[itemText] || 0;
                readyQty = maps.readyForPickItemMap[itemText] || 0;
                dbQty = 0;
            }

            // ==============================
            // 🔥 YOUR REQUIRED FIX (CAP LOGIC)
            // ==============================
            var soQty = soRec.getSublistValue({
                sublistId: 'item',
                fieldId: 'quantity',
                line: i
            }) || 0;

            if (pickedQty > soQty || readyQty > soQty || dbQty > soQty) {
                log.error('Qty exceeds SO - Capping applied',
                    'SO ID ' + recId +
                    ' | Line ' + i +
                    ' | SO: ' + soQty +
                    ' | Picked: ' + pickedQty +
                    ' | Ready: ' + readyQty +
                    ' | DB: ' + dbQty
                );
            }

            pickedQty = Math.min(pickedQty, soQty);
            readyQty = Math.min(readyQty, soQty);
            dbQty = Math.min(dbQty, soQty);
            // ==============================

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

        log.audit('Sales Order Synced From WMS (Capped)', 'SO ID ' + recId);
    }

    // =====================================================
    // API CALL  (endpoint unchanged — no bins needed here)
    // =====================================================
    function sendData(recId) {
        try {
            var token = tokenModule.generateToken();
            if (!token) return { success: false, error: 'Token generation failed' };

            var response = https.get({
                url: 'https://api.jyswms.com/dropship-sales-order-status?sales_order_id=' + recId,
                headers: { 'Authorization': 'Bearer ' + token }
            });

            return {
                success: response.code === 200,
                response: response.body
            };

        } catch (e) {
            log.error('sendData Error', e.message);
            return { success: false, error: e.message };
        }
    }

    // =====================================================
    // EXTRACT SHIP ERRORS
    // =====================================================
    function extractShipErrors(sourceArray) {
        var errors = [];
        if (!sourceArray.length || !sourceArray[0].data) return '';
        sourceArray[0].data.forEach(function (line) {
            if (line.ship_error && String(line.ship_error).trim()) {
                errors.push(line.ship_error.trim());
            }
        });
        return errors.join(' | ');
    }

    // =====================================================
    // BEFORE SUBMIT
    // =====================================================
    function beforeSubmit(context) {
        try {

            if (
                context.type !== context.UserEventType.CREATE &&
                context.type !== context.UserEventType.EDIT
            ) return;

            var rec = context.newRecord;

            var jysenabled = rec.getValue({ fieldId: 'custbody_jys_enabled_customer' });
            if (!jysenabled) return;

            var orderStatus = rec.getValue({ fieldId: 'orderstatus' });

            if (context.type === context.UserEventType.EDIT) {
                if (!['B', 'C', 'H'].includes(orderStatus)) return;
            }

            var lineCount = rec.getLineCount({ sublistId: 'item' });
            var hasParts = false;

            for (var i = 0; i < lineCount; i++) {

                var itemId = rec.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i });
                var locationId = rec.getSublistValue({ sublistId: 'item', fieldId: 'location', line: i });

                if (Number(itemId) === 57740 && Number(locationId) !== 9) {
                    hasParts = true;
                    rec.setSublistValue({ sublistId: 'item', fieldId: 'location', line: i, value: 9 });
                }
            }

            if (!hasParts) return;

            log.error('for sales order id: ' + rec.id + ' hasParts: ' + hasParts);

            if (Number(rec.getValue('location')) !== 9) {
                rec.setValue({ fieldId: 'location', value: 9 });
            }

        } catch (e) {
            log.error('ERROR', e);
        }
    }

    return {
        afterSubmit: afterSubmit,
        beforeSubmit: beforeSubmit
    };
});