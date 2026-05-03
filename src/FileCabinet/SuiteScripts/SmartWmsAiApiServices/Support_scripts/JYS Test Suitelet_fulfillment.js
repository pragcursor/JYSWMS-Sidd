/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 *
 * FIXES applied to the previous version:
 *
 *  FIX 1 — buildPickMapByLine: key is the EXACT unique_id string from WMS.
 *           Previous version split on [-_] so "709707101_1" became "709707101",
 *           which never matched custcol_wms_unique_id on the NS fulfillment line,
 *           always falling back to item-name and losing pickedBin for L74.
 *
 *  FIX 2 — filterPickedTracking: only removes already-fulfilled tracking rows.
 *           Does NOT delete entries or reset qty to tracking.length.
 *           qty is reduced only by the count of removed tracking rows.
 *           Previous version deleted the entire entry if all tracking was filtered,
 *           even when qty was still outstanding — causing single-IF to pass the
 *           gate but then skip every fulfillment line.
 *
 *  FIX 3 — Single-IF gate now runs AFTER filtering and does TWO checks:
 *           (a) All WMS lines with qty > 0 must be is_picked = "picked".
 *           (b) Every SO item line must resolve to a pick-map entry with qty > 0.
 *           Previous version only checked raw wmsLines before filtering, so
 *           partial orders slipped through and created multiple fulfillments.
 */
define([
    'N/ui/serverWidget',
    'N/record',
    'N/https',
    'N/log',
    'N/search',
    '../JYSWMS_generateToken_API'
], function (ui, record, https, log, search, tokenModule) {

    /* ======================================
       CONSTANTS
    ====================================== */
    var L74_LOCS = { 23: true, 24: true };

    /* ======================================
       ENTRY
    ====================================== */
    function onRequest(context) {

        var soId = context.request.parameters.custpage_soid;
        var form = ui.createForm({ title: 'WMS Fulfillment Result' });

        try {

            if (!soId) throw 'Sales Order Internal ID required.';

            /* ========= CALL WMS ========= */
            var wmsLines = callWmsApi(soId);

            var pickMapByLine = buildPickMapByLine(wmsLines);
            var pickMapByItem = buildPickMapByItem(wmsLines);

            var allTracking = extractTrackingNumbers(wmsLines);
            var existingTracking = getExistingTrackingNumbers(allTracking);

            // FIX 2: filter only removes tracking rows, does not delete entries
            pickMapByLine = filterPickedTracking(pickMapByLine, existingTracking);
            pickMapByItem = filterPickedTracking(pickMapByItem, existingTracking);

            if (!Object.keys(pickMapByLine).length && !Object.keys(pickMapByItem).length) {
                throw 'No picked lines returned from WMS.';
            }

            /* ========= LOAD SO ========= */
            var salesOrderRecord = record.load({
                type: record.Type.SALES_ORDER,
                id: soId,
                isDynamic: true
            });

            var orderStatus = salesOrderRecord.getValue({ fieldId: 'status' });
            var customer = salesOrderRecord.getValue({ fieldId: 'entity' });
            var headerLocationId = salesOrderRecord.getValue({ fieldId: 'location' });
            var singleIf = salesOrderRecord.getValue({ fieldId: 'custbody_wms_so_single_if' });

            if (orderStatus == 'Billed') throw 'Sales Order is Billed. Cannot be processed.';
            if (customer == 476 || customer == 1807) throw 'Customer is Amazon. Cannot be processed.';

            /* ======================================================
               FIX 3 — SINGLE-IF GATE (runs after filtering)
               Check (a): all WMS lines with qty > 0 must be picked.
               Check (b): every SO item line must exist in pick maps.
            ====================================================== */
            if (singleIf) {

                // (a) All positive-qty WMS lines must be picked
                var notPicked = wmsLines.filter(function (line) {
                    return Number(line.quantity) > 0 && line.is_picked !== 'picked';
                });
                if (notPicked.length) {
                    throw 'Single IF requires ALL items to be picked. '
                    + notPicked.length + ' line(s) not yet picked.';
                }

                // (b) Every SO line must resolve in the pick maps with qty > 0
                var soLineCountCheck = salesOrderRecord.getLineCount({ sublistId: 'item' });
                for (var g = 0; g < soLineCountCheck; g++) {
                    salesOrderRecord.selectLine({ sublistId: 'item', line: g });

                    var soUniqueId = salesOrderRecord.getCurrentSublistValue({
                        sublistId: 'item', fieldId: 'custcol_wms_unique_id'
                    });
                    var soItemIdChk = salesOrderRecord.getCurrentSublistValue({
                        sublistId: 'item', fieldId: 'item'
                    });
                    var soItemNameChk = getItemNameById(soItemIdChk) || String(soItemIdChk);

                    var inPickMap =
                        (soUniqueId && pickMapByLine[soUniqueId] && pickMapByLine[soUniqueId].qty > 0) ||
                        (pickMapByItem[soItemNameChk] && pickMapByItem[soItemNameChk].qty > 0);

                    if (!inPickMap) {
                        throw 'Single IF: item ' + soItemNameChk
                        + ' (unique_id: ' + soUniqueId + ') is not fully picked yet. '
                        + 'Cannot create fulfillment until all lines are ready.';
                    }
                }
            }

            /* ========= SINGLE-IF: collect non-header lines for transfer ========= */
            var nonHeaderLocationItems = [];

            if (singleIf) {
                var soLineCount = salesOrderRecord.getLineCount({ sublistId: 'item' });
                for (var i = 0; i < soLineCount; i++) {
                    salesOrderRecord.selectLine({ sublistId: 'item', line: i });
                    var soItemId = salesOrderRecord.getCurrentSublistValue({ sublistId: 'item', fieldId: 'item' });
                    var soLocId = salesOrderRecord.getCurrentSublistValue({ sublistId: 'item', fieldId: 'location' });
                    var soQty = salesOrderRecord.getCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity' });

                    if (soLocId !== headerLocationId) {
                        nonHeaderLocationItems.push({
                            itemId: soItemId,
                            locationId: soLocId,
                            headerLocationId: headerLocationId,
                            quantity: soQty
                        });
                    }
                }
            }

            /* ========= SINGLE-IF: INVENTORY TRANSFERS ========= */
            nonHeaderLocationItems.forEach(function (item) {
                if (L74_LOCS[Number(item.locationId)]) return;

                var stageBinId = getStageBinByLocation(item.locationId);
                var headerStageBinId = getStageBinByLocation(item.headerLocationId);
                if (!stageBinId || !headerStageBinId) return;

                var checkBinExists = getInventoryByItemAndBin(
                    item.itemId, stageBinId, item.quantity, item.locationId
                );
                if (checkBinExists) {
                    createInventoryTransfer(
                        item.itemId, item.quantity,
                        item.locationId, item.headerLocationId,
                        stageBinId, headerStageBinId,
                        soId
                    );
                }
            });

            /* ========= TRANSFORM SO -> ITEM FULFILLMENT ========= */
            var fulfillment = record.transform({
                fromType: record.Type.SALES_ORDER,
                fromId: soId,
                toType: record.Type.ITEM_FULFILLMENT,
                isDynamic: true
            });

            fulfillment.setValue({ fieldId: 'shipstatus', value: 'C' });

            var itemLineCount = fulfillment.getLineCount({ sublistId: 'item' });
            var hasFulfillLines = false;
            var packageIndexMap = {};
            var allTrackingArray = [];
            var l74ErrorNotes = [];

            /* ========= PROCESS EACH FULFILLMENT LINE ========= */
            for (var i = 0; i < itemLineCount; i++) {

                fulfillment.selectLine({ sublistId: 'item', line: i });

                if (singleIf) {
                    var lineLocVal = fulfillment.getCurrentSublistValue({
                        sublistId: 'item', fieldId: 'location'
                    });
                    if (lineLocVal != headerLocationId) {
                        fulfillment.setCurrentSublistValue({
                            sublistId: 'item', fieldId: 'location', value: headerLocationId
                        });
                    }
                }

                var itemIdInternal = fulfillment.getCurrentSublistValue({ sublistId: 'item', fieldId: 'item' });
                var itemText = getItemNameById(itemIdInternal) || String(itemIdInternal);
                var remainingQty = Number(fulfillment.getCurrentSublistValue({
                    sublistId: 'item', fieldId: 'quantityremaining'
                })) || 0;
                var rawLineLocId = Number(fulfillment.getCurrentSublistValue({
                    sublistId: 'item', fieldId: 'location'
                }));
                var lineLocationId = singleIf ? Number(headerLocationId) : rawLineLocId;
                var isL74 = !!L74_LOCS[lineLocationId];

                // FIX 1: exact unique_id match — no normalization
                var uniqueId = fulfillment.getCurrentSublistValue({
                    sublistId: 'item', fieldId: 'custcol_wms_unique_id'
                });

                var qtyToFulfill = 0;
                var trackingList = [];
                var pickedBinName = null;

                if (uniqueId && pickMapByLine[uniqueId] && pickMapByLine[uniqueId].qty > 0) {
                    /* Primary: exact unique_id match */
                    var ld = pickMapByLine[uniqueId];
                    qtyToFulfill = Math.min(ld.qty, remainingQty);
                    trackingList = ld.tracking.slice(0, qtyToFulfill);
                    pickedBinName = ld.pickedBin;
                    ld.qty -= qtyToFulfill;
                    if (ld.qty <= 0) delete pickMapByLine[uniqueId];

                    /*
                     * SPLIT-LINE DRAIN
                     * WMS splits one NS line into siblings keyed as:
                     *   "708127381"    qty 2   (matches NS unique_id)
                     *   "708127381-1"  qty 1   (no NS line — orphaned)
                     *   "708127381-2"  qty 1   ...etc
                     * After consuming the primary, keep draining siblings
                     * (-1, -2, -3...) until remainingQty is satisfied.
                     */
                    var sibIdx = 1;
                    while (qtyToFulfill < remainingQty) {
                        var sibKey = uniqueId + '-' + sibIdx;
                        if (!pickMapByLine[sibKey] || pickMapByLine[sibKey].qty <= 0) break;
                        var sib = pickMapByLine[sibKey];
                        var sibQty = Math.min(sib.qty, remainingQty - qtyToFulfill);
                        trackingList = trackingList.concat(sib.tracking.slice(0, sibQty));
                        if (!pickedBinName) pickedBinName = sib.pickedBin;
                        qtyToFulfill += sibQty;
                        sib.qty -= sibQty;
                        if (sib.qty <= 0) delete pickMapByLine[sibKey];
                        sibIdx++;
                    }

                    /* Also drain item-name fallback map for any residual qty */
                    if (qtyToFulfill < remainingQty && pickMapByItem[itemText] && pickMapByItem[itemText].qty > 0) {
                        var imdExtra = pickMapByItem[itemText];
                        var extraQty = Math.min(imdExtra.qty, remainingQty - qtyToFulfill);
                        trackingList = trackingList.concat(imdExtra.tracking.splice(0, extraQty));
                        if (!pickedBinName) pickedBinName = imdExtra.pickedBin;
                        qtyToFulfill += extraQty;
                        imdExtra.qty -= extraQty;
                        if (imdExtra.qty <= 0) delete pickMapByItem[itemText];
                    }

                } else if (pickMapByItem[itemText] && pickMapByItem[itemText].qty > 0) {
                    /* Fallback: item name match (no unique_id on NS line) */
                    var imd = pickMapByItem[itemText];
                    qtyToFulfill = Math.min(imd.qty, remainingQty);
                    trackingList = imd.tracking.slice(0, qtyToFulfill);
                    pickedBinName = imd.pickedBin;
                    imd.qty -= qtyToFulfill;
                    if (imd.qty <= 0) delete pickMapByItem[itemText];
                }

                log.debug('Processing Item Line', {
                    item: itemText, remainingQty: remainingQty,
                    qtyToFulfill: qtyToFulfill, uniqueId: uniqueId,
                    pickedBin: pickedBinName, isL74: isL74
                });

                if (qtyToFulfill <= 0 || remainingQty <= 0) {
                    fulfillment.setCurrentSublistValue({ sublistId: 'item', fieldId: 'itemreceive', value: false });
                    fulfillment.commitLine({ sublistId: 'item' });
                    continue;
                }

                var effectiveBinId = null;

                if (isL74) {

                    if (!pickedBinName) {
                        var errA = 'L74 SKIP (no bin): item=' + itemText + ' loc=' + lineLocationId;
                        log.error('L74_BIN_MISSING', errA);
                        l74ErrorNotes.push(errA);
                        fulfillment.setCurrentSublistValue({ sublistId: 'item', fieldId: 'itemreceive', value: false });
                        fulfillment.commitLine({ sublistId: 'item' });
                        continue;
                    }

                    effectiveBinId = getInternalBinId(pickedBinName);
                    if (!effectiveBinId) {
                        var errB = 'L74 SKIP (bin resolve fail): item=' + itemText + ' bin=' + pickedBinName;
                        log.error('L74_BIN_RESOLVE', errB);
                        l74ErrorNotes.push(errB);
                        fulfillment.setCurrentSublistValue({ sublistId: 'item', fieldId: 'itemreceive', value: false });
                        fulfillment.commitLine({ sublistId: 'item' });
                        continue;
                    }

                    var l74hasStock = checkInventoryAvailableOnly(
                        itemIdInternal, effectiveBinId, qtyToFulfill, lineLocationId
                    );
                    if (!l74hasStock) {
                        var errC = 'L74 SKIP (no stock): item=' + itemText
                            + ' bin=' + pickedBinName
                            + ' need=' + qtyToFulfill
                            + ' loc=' + lineLocationId;
                        log.error('L74_INVENTORY', errC);
                        l74ErrorNotes.push(errC);
                        fulfillment.setCurrentSublistValue({ sublistId: 'item', fieldId: 'itemreceive', value: false });
                        fulfillment.commitLine({ sublistId: 'item' });
                        continue;
                    }

                } else {

                    var stageBinId = getStageBinByLocation(lineLocationId);
                    var checkBinExists = getInventoryByItemAndBin(
                        itemIdInternal, stageBinId, remainingQty, lineLocationId
                    );
                    if (!checkBinExists) {
                        throw 'Inventory not found for item: ' + itemText + ' in bin: ' + stageBinId;
                    }
                    effectiveBinId = stageBinId;
                }

                hasFulfillLines = true;
                var itemWeight = getItemWeight(itemIdInternal);

                fulfillment.setCurrentSublistValue({ sublistId: 'item', fieldId: 'itemreceive', value: true });
                fulfillment.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity', value: qtyToFulfill });

                assignInventoryDetail(fulfillment, qtyToFulfill, effectiveBinId);

                fulfillment.commitLine({ sublistId: 'item' });

                trackingList.forEach(function (trackObj) {
                    var trackingNumber = trackObj.trackingNumber;
                    if (!trackingNumber) return;

                    if (!packageIndexMap[trackingNumber]) {
                        fulfillment.selectNewLine({ sublistId: 'package' });
                        fulfillment.setCurrentSublistValue({
                            sublistId: 'package', fieldId: 'packagetrackingnumber', value: trackingNumber
                        });
                        fulfillment.setCurrentSublistValue({
                            sublistId: 'package', fieldId: 'packageweight',
                            value: itemWeight > 0 ? itemWeight : 1
                        });
                        fulfillment.commitLine({ sublistId: 'package' });
                        packageIndexMap[trackingNumber] = true;
                    }

                    allTrackingArray.push({
                        trackingNumber: trackingNumber,
                        SSCC: trackObj.SSCC,
                        itemName: itemText
                    });
                });

            } // end line loop

            if (!hasFulfillLines) throw 'No lines qualified for fulfillment.';

            var fulfillmentId = fulfillment.save({
                enableSourcing: true,
                ignoreMandatoryFields: true
            });

            createCustomPackageContents(fulfillmentId, allTrackingArray);

            if (l74ErrorNotes.length) {
                record.submitFields({
                    type: record.Type.SALES_ORDER,
                    id: soId,
                    values: {
                        custbody_jyswms_fufilment_error:
                            '[IF#' + fulfillmentId + '] ' + l74ErrorNotes.join(' | ')
                    }
                });
            }

            form.addField({
                id: 'custpage_success',
                type: ui.FieldType.INLINEHTML,
                label: ' '
            }).defaultValue =
                '<h3 style="color:green">Fulfillment Created</h3>' +
                '<p>ID: ' + fulfillmentId + '</p>' +
                (l74ErrorNotes.length
                    ? '<p style="color:darkorange"><b>L74 Notes:</b><br>'
                    + l74ErrorNotes.join('<br>') + '</p>'
                    : '');

        } catch (e) {

            log.error('Fulfillment Error', e);

            form.addField({
                id: 'custpage_error',
                type: ui.FieldType.INLINEHTML,
                label: ' '
            }).defaultValue = '<h3 style="color:red">Error</h3><p>' + e + '</p>';
        }

        context.response.writePage(form);
    }

    /* ======================================
       BUILD PICK MAP BY UNIQUE_ID  (primary)
       FIX 1: exact unique_id — no splitting or normalization.
    ====================================== */
    function buildPickMapByLine(wmsLines) {
        var map = {};
        wmsLines.forEach(function (line) {
            if (!line.unique_id || line.is_picked !== 'picked') return;
            var qty = Number(line.quantity) || 0;
            if (!qty) return;

            var key = String(line.unique_id); // exact match

            if (!map[key]) {
                map[key] = { qty: 0, tracking: [], pickedBin: null };
            }
            map[key].qty += qty;

            if (!map[key].pickedBin) {
                map[key].pickedBin = line.bin_number || line.binnumber || line.binNumber || null;
            }

            if (line.tracking_data && line.tracking_data.length) {
                line.tracking_data.forEach(function (track) {
                    map[key].tracking.push({
                        trackingNumber: track.trackingNumber || '',
                        SSCC: track.SSCC || ''
                    });
                });
            }
        });
        return map;
    }

    /* ======================================
       BUILD PICK MAP BY ITEM NAME  (fallback)
    ====================================== */
    function buildPickMapByItem(wmsLines) {
        var map = {};
        wmsLines.forEach(function (line) {
            if (!line.item || line.is_picked !== 'picked') return;
            var qty = Number(line.quantity) || 0;
            if (!qty) return;

            if (!map[line.item]) {
                map[line.item] = { qty: 0, tracking: [], pickedBin: null };
            }
            map[line.item].qty += qty;

            if (!map[line.item].pickedBin) {
                map[line.item].pickedBin = line.bin_number || line.binnumber || line.binNumber || null;
            }

            if (line.tracking_data && line.tracking_data.length) {
                line.tracking_data.forEach(function (track) {
                    map[line.item].tracking.push({
                        trackingNumber: track.trackingNumber || '',
                        SSCC: track.SSCC || ''
                    });
                });
            }
        });
        return map;
    }

    /* ======================================
       FILTER ALREADY-FULFILLED TRACKING
       FIX 2: Only strips tracking rows. Reduces qty by removed count.
       Does NOT reset qty to tracking.length.
       Only deletes entry when qty truly hits zero.
    ====================================== */
    function filterPickedTracking(pickMap, existingTracking) {
        Object.keys(pickMap).forEach(function (key) {
            var before = pickMap[key].tracking.length;
            var filtered = pickMap[key].tracking.filter(function (t) {
                return !existingTracking[t.trackingNumber];
            });
            var removed = before - filtered.length;
            pickMap[key].tracking = filtered;
            pickMap[key].qty -= removed; // reduce only by what was removed

            if (pickMap[key].qty <= 0) {
                delete pickMap[key]; // fully fulfilled
            }
        });
        return pickMap;
    }

    /* ======================================
       STAGE BIN BY LOCATION  (L41 & L60 only)
    ====================================== */
    function getStageBinByLocation(locationId) {
        if (Number(locationId) === 9) return 4859;
        if (Number(locationId) === 15) return 16692;
        return null;
    }

    /* ======================================
       RESOLVE BIN NAME -> NS INTERNAL ID  (L74)
    ====================================== */
    function getInternalBinId(binName) {
        if (!binName) return null;
        var parsed = Number(binName);
        if (!isNaN(parsed) && parsed > 0) return parsed;
        try {
            var results = search.create({
                type: 'bin',
                filters: [['binnumber', 'is', String(binName)]],
                columns: [search.createColumn({ name: 'internalid' })]
            }).run().getRange({ start: 0, end: 1 });

            if (results && results.length) {
                var id = Number(results[0].getValue({ name: 'internalid' }));
                log.audit('getInternalBinId', '"' + binName + '" -> ' + id);
                return id;
            }
            log.error('getInternalBinId', 'No bin found: ' + binName);
        } catch (e) {
            log.error('getInternalBinId', e);
        }
        return null;
    }

    /* ======================================
       CHECK INVENTORY READ-ONLY  (L74 only)
    ====================================== */
    function checkInventoryAvailableOnly(itemId, binId, qty, locationId) {
        var found = false;
        try {
            search.create({
                type: 'inventorybalance',
                filters: [
                    ['item', 'anyof', itemId],
                    'AND',
                    ['binnumber', 'anyof', binId],
                    'AND',
                    ['location', 'anyof', locationId],
                    'AND',
                    ['onhand', 'greaterthanorequalto', qty]
                ],
                columns: ['onhand']
            }).run().each(function () { found = true; return false; });
        } catch (e) {
            log.error('checkInventoryAvailableOnly', e);
        }
        return found;
    }

    /* ======================================
       CHECK INVENTORY + AUTO-ADJUST  (non-L74)
    ====================================== */
    function getInventoryByItemAndBin(itemId, binId, quantity, locationId) {
        log.error('Getting Inventory by Item and Bin', {
            itemId: itemId, binId: binId, quantity: quantity, locationId: locationId
        });

        var inventorybalanceSearchObj = search.create({
            type: 'inventorybalance',
            filters: [
                ['item', 'anyof', itemId],
                'AND',
                ['binnumber', 'anyof', binId],
                'AND',
                ['onhand', 'greaterthan', quantity]
            ],
            columns: [
                search.createColumn({ name: 'onhand', label: 'On Hand' }),
                search.createColumn({ name: 'available', label: 'Available' }),
                search.createColumn({ name: 'binnumber', label: 'Bin Number' }),
                search.createColumn({ name: 'location', label: 'Location' }),
                search.createColumn({ name: 'internalid', join: 'binNumber', label: 'Internal ID' })
            ]
        });

        var invExists = false;
        var searchResultCount = inventorybalanceSearchObj.runPaged().count;
        log.debug('inventorybalanceSearchObj result count', searchResultCount);

        inventorybalanceSearchObj.run().each(function (result) {
            invExists = true;
            return true;
        });

        if (!invExists) {
            var adjustmentObj = {};
            adjustmentObj[itemId] = quantity;
            createPositiveAdjustment(adjustmentObj, locationId, binId);
            invExists = true;
        }

        return invExists;
    }

    /* ======================================
       INVENTORY TRANSFER
    ====================================== */
    function createInventoryTransfer(itemId, quantity, fromLocation, toLocation, fromBin, toBin, soId) {
        try {
            log.error('Creating Inventory Transfer', {
                itemId: itemId, quantity: quantity,
                fromLocation: fromLocation, toLocation: toLocation,
                fromBin: fromBin, toBin: toBin, soId: soId
            });

            var invTransferRec = record.create({
                type: record.Type.INVENTORY_TRANSFER, isDynamic: true
            });
            invTransferRec.setValue({ fieldId: 'location', value: fromLocation });
            invTransferRec.setValue({ fieldId: 'transferlocation', value: toLocation });
            invTransferRec.setValue({
                fieldId: 'memo',
                value: 'Inventory Transfer for Fulfillment - SO: ' + soId
            });

            invTransferRec.selectNewLine({ sublistId: 'inventory' });
            invTransferRec.setCurrentSublistValue({ sublistId: 'inventory', fieldId: 'item', value: itemId });
            invTransferRec.setCurrentSublistValue({ sublistId: 'inventory', fieldId: 'adjustqtyby', value: quantity });

            var invDetail = invTransferRec.getCurrentSublistSubrecord({
                sublistId: 'inventory', fieldId: 'inventorydetail'
            });
            invDetail.selectNewLine({ sublistId: 'inventoryassignment' });
            invDetail.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'binnumber', value: fromBin });
            invDetail.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'tobinnumber', value: toBin });
            invDetail.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'quantity', value: quantity });
            invDetail.commitLine({ sublistId: 'inventoryassignment' });
            invTransferRec.commitLine({ sublistId: 'inventory' });

            var transferId = invTransferRec.save({ enableSourcing: true, ignoreMandatoryFields: true });
            log.debug('Inventory Transfer Created', transferId);
            return transferId;
        } catch (e) {
            log.error('Inventory Transfer Error', e);
        }
    }

    /* ======================================
       POSITIVE INVENTORY ADJUSTMENT  (non-L74 only)
    ====================================== */
    function createPositiveAdjustment(adjustmentObj, locationId, binId) {
        try {
            var adjRec = record.create({
                type: record.Type.INVENTORY_ADJUSTMENT, isDynamic: true
            });
            adjRec.setValue({ fieldId: 'subsidiary', value: 1 });
            adjRec.setValue({ fieldId: 'memo', value: 'Inventory Adj for Fulfillment' });
            adjRec.setValue({ fieldId: 'account', value: 464 });
            adjRec.setValue({ fieldId: 'adjlocation', value: locationId });

            log.debug('Adjustment Object', adjustmentObj);
            log.debug('Location ID', locationId);
            log.debug('Bin ID', binId);

            for (var itemId in adjustmentObj) {
                var qty = adjustmentObj[itemId];
                adjRec.selectNewLine({ sublistId: 'inventory' });
                adjRec.setCurrentSublistValue({ sublistId: 'inventory', fieldId: 'item', value: itemId });
                adjRec.setCurrentSublistValue({ sublistId: 'inventory', fieldId: 'location', value: locationId });
                adjRec.setCurrentSublistValue({ sublistId: 'inventory', fieldId: 'adjustqtyby', value: qty });

                var inventoryDetail = adjRec.getCurrentSublistSubrecord({
                    sublistId: 'inventory', fieldId: 'inventorydetail'
                });
                inventoryDetail.selectNewLine({ sublistId: 'inventoryassignment' });
                inventoryDetail.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'binnumber', value: binId });
                inventoryDetail.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'quantity', value: qty });
                inventoryDetail.commitLine({ sublistId: 'inventoryassignment' });
                adjRec.commitLine({ sublistId: 'inventory' });
            }

            var recId = adjRec.save({ enableSourcing: true, ignoreMandatoryFields: true });
            log.debug('Inventory Adjustment Created', recId);
            return recId;
        } catch (e) {
            log.error('Error Creating Inventory Adjustment', e);
        }
    }

    /* ======================================
       ASSIGN INVENTORY DETAIL ON FULFILLMENT LINE
    ====================================== */
    function assignInventoryDetail(fulfillment, qty, stageBinId) {
        if (!stageBinId) return;
        try {
            var invDetail = fulfillment.getCurrentSublistSubrecord({
                sublistId: 'item', fieldId: 'inventorydetail'
            });
            var assignmentCount = invDetail.getLineCount({ sublistId: 'inventoryassignment' });
            for (var i = assignmentCount - 1; i >= 0; i--) {
                invDetail.removeLine({ sublistId: 'inventoryassignment', line: i, ignoreRecalc: true });
            }
            invDetail.selectNewLine({ sublistId: 'inventoryassignment' });
            invDetail.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'binnumber', value: stageBinId });
            invDetail.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'quantity', value: qty });
            invDetail.commitLine({ sublistId: 'inventoryassignment' });
        } catch (e) {
            log.error('Inventory Detail Error', e);
            throw e;
        }
    }

    /* ======================================
       CREATE CUSTOM PACKAGE CONTENT
    ====================================== */
    function createCustomPackageContents(fulfillmentId, trackingArray) {
        try {
            var fulfillmentRec = record.load({
                type: record.Type.ITEM_FULFILLMENT, id: fulfillmentId, isDynamic: true
            });

            var customerId = fulfillmentRec.getValue({ fieldId: 'entity' });
            var LOWES_CUSTOMERS = [1952, 639];
            var isLowesCustomer = LOWES_CUSTOMERS.indexOf(Number(customerId)) !== -1;
            var sublistId = 'recmachcustrecord_hj_packagecontents_sublist';

            var existingCount = fulfillmentRec.getLineCount({ sublistId: sublistId });
            for (var i = existingCount - 1; i >= 0; i--) {
                fulfillmentRec.removeLine({ sublistId: sublistId, line: i, ignoreRecalc: true });
            }

            var packageBoxNumber = 0;
            var seenTracking = {};

            trackingArray.forEach(function (line) {
                if (!line.trackingNumber) return;
                if (seenTracking[line.trackingNumber]) return;

                seenTracking[line.trackingNumber] = true;
                packageBoxNumber++;

                fulfillmentRec.selectNewLine({ sublistId: sublistId });
                fulfillmentRec.setCurrentSublistValue({
                    sublistId: sublistId, fieldId: 'custrecordhj_pkgbox', value: packageBoxNumber
                });
                fulfillmentRec.setCurrentSublistValue({
                    sublistId: sublistId, fieldId: 'custrecordhj_pkg_trackingnumber', value: line.trackingNumber
                });

                if (line.SSCC || isLowesCustomer) {
                    fulfillmentRec.setCurrentSublistValue({
                        sublistId: sublistId, fieldId: 'custrecordhj_ucc', value: line.SSCC || ''
                    });
                }

                fulfillmentRec.setCurrentSublistValue({
                    sublistId: sublistId, fieldId: 'custrecordhj_pkg_desc', value: line.itemName + '/1'
                });
                fulfillmentRec.setCurrentSublistValue({
                    sublistId: sublistId, fieldId: 'custrecord_jyswms_createdfrom', value: true
                });
                fulfillmentRec.setCurrentSublistValue({
                    sublistId: sublistId, fieldId: 'custrecord_jyswms_item_not_populated', value: true
                });
                fulfillmentRec.setCurrentSublistValue({
                    sublistId: sublistId, fieldId: 'custrecord_jyswms_fulfillment_link', value: true
                });

                fulfillmentRec.commitLine({ sublistId: sublistId });
            });

            fulfillmentRec.save({ enableSourcing: true, ignoreMandatoryFields: true });
        } catch (e) {
            log.error('Custom Package Content Error', e);
        }
    }

    /* ======================================
       WMS API
       
    ====================================== */
    function callWmsApi(soId) {
        var token = tokenModule.generateToken();
        var response = https.get({
            // url: 'https://api.jyswms.com/dropship-sales-order-status-with-bins?sales_order_id=' + soId,
            url: 'https://jyswms-pragva.up.railway.app/dropship-sales-order-status-with-bins?sales_order_id=' + soId,

            headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }
        });
        if (response.code !== 200) throw 'WMS API returned ' + response.code;
        var body = JSON.parse(response.body || '{}');
        var sourceArray = (body.completed && body.completed.length) ? body.completed : body.notcompleted;
        return sourceArray[0].data || [];
    }

    /* ======================================
       HELPERS
    ====================================== */
    function getItemWeight(itemId) {
        try {
            var itemData = search.lookupFields({
                type: search.Type.INVENTORY_ITEM, id: itemId, columns: ['weight']
            });
            return Number(itemData.weight) || 0;
        } catch (e) { return 0; }
    }

    function getItemNameById(itemId) {
        try {
            var itemRecord = search.lookupFields({
                type: search.Type.INVENTORY_ITEM, id: itemId, columns: ['itemid']
            });
            return itemRecord.itemid || null;
        } catch (error) {
            log.error('Item Lookup Failed', 'ID: ' + itemId + ' - ' + error);
            return null;
        }
    }

    function extractTrackingNumbers(wmsLines) {
        try {
            var trackingNumbers = [];
            wmsLines.forEach(function (line) {
                if (line.tracking_data && line.tracking_data.length) {
                    line.tracking_data.forEach(function (track) {
                        if (track.trackingNumber) trackingNumbers.push(track.trackingNumber);
                    });
                }
            });
            return trackingNumbers;
        } catch (error) {
            log.error('Error Extracting Tracking Numbers', error);
        }
    }

    function getExistingTrackingNumbers(trackingNumbers) {
        var existingTracking = {};
        try {
            if (!trackingNumbers || !trackingNumbers.length) return existingTracking;

            var filters = [
                ['type', 'anyof', 'ItemShip'],
                'AND',
                ['mainline', 'is', 'T'],
                'AND'
            ];
            var trackingFilter = [];
            trackingNumbers.forEach(function (num, index) {
                if (index > 0) trackingFilter.push('OR');
                trackingFilter.push(['shipmentpackage.trackingnumber', 'is', num]);
            });
            filters = filters.concat(trackingFilter);

            var fulfillmentSearch = search.create({
                type: 'itemfulfillment',
                filters: filters,
                columns: [search.createColumn({ name: 'trackingnumber', join: 'shipmentpackage' })]
            });
            fulfillmentSearch.run().each(function (result) {
                var tracking = result.getValue({ name: 'trackingnumber', join: 'shipmentpackage' });
                if (tracking) existingTracking[String(tracking)] = true;
                return true;
            });
        } catch (e) {
            log.error('Error Fetching Existing Tracking Numbers', e);
        }
        return existingTracking;
    }

    function buildForm(context) {
        var form = ui.createForm({ title: 'WMS Direct Fulfillment Processor' });
        form.addField({
            id: 'custpage_soid', type: ui.FieldType.TEXT, label: 'Sales Order Internal ID'
        }).isMandatory = true;
        form.addSubmitButton({ label: 'Process Fulfillment' });
        context.response.writePage(form);
    }

    return { onRequest: onRequest };
});