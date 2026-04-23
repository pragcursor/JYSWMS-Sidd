/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 *
 * Changes from original working script:
 *  1. Fulfillment lines matched by custcol_wms_unique_id (primary),
 *     item name fallback — so multi-line same-item orders resolve correctly.
 *  2. L74 / L74-FTZ (loc 23 & 24): fulfill directly from WMS picked bin,
 *     no stage bin, no positive adjustment.
 *     If qty unavailable → skip line and write note to custbody_jyswms_fufilment_error.
 *  3. Everything else is untouched from the original.
 */
define([
    'N/ui/serverWidget',
    'N/record',
    'N/https',
    'N/log',
    'N/search',
    '../JYSWMS_generateToken_API.js'
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

            /*
             * Build TWO pick maps from WMS data:
             *   pickMapByLine — keyed by unique_id  (primary match)
             *   pickMapByItem — keyed by item name  (fallback match)
             * Both also store pickedBin (bin_number from WMS) for L74.
             */
            var pickMapByLine = buildPickMapByLine(wmsLines);
            var pickMapByItem = buildPickMapByItem(wmsLines);

            /* Idempotency: strip tracking numbers already fulfilled in NS */
            var allTracking      = extractTrackingNumbers(wmsLines);
            var existingTracking = getExistingTrackingNumbers(allTracking);

            pickMapByLine = filterPickedTracking(pickMapByLine, existingTracking);
            pickMapByItem = filterPickedTracking(pickMapByItem, existingTracking);

            if (!Object.keys(pickMapByLine).length && !Object.keys(pickMapByItem).length) {
                throw 'No picked lines returned from WMS.';
            }

            /* ========= LOAD SO ========= */
            var salesOrderRecord = record.load({
                type:      record.Type.SALES_ORDER,
                id:        soId,
                isDynamic: true
            });

            var orderStatus = salesOrderRecord.getValue({ fieldId: 'status' });
            var customer    = salesOrderRecord.getValue({ fieldId: 'entity' });

            if (orderStatus == 'Billed') throw 'Sales Order is Billed. Cannot be processed.';
            if (customer == 476 || customer == 1807) throw 'Customer is Amazon. Cannot be processed.';

            var headerLocationId = salesOrderRecord.getValue({ fieldId: 'location' });
            var singleIf         = salesOrderRecord.getValue({ fieldId: 'custbody_wms_so_single_if' });

            /* ========= SINGLE-IF: gate + collect non-header lines ========= */
            var nonHeaderLocationItems = [];

            if (singleIf) {
                var notPicked = wmsLines.filter(function (line) {
                    return line.is_picked !== 'picked';
                });
                if (notPicked.length) throw 'Single IF requires ALL items picked.';

                var lineCount = salesOrderRecord.getLineCount({ sublistId: 'item' });
                for (var i = 0; i < lineCount; i++) {
                    salesOrderRecord.selectLine({ sublistId: 'item', line: i });
                    var soItemId  = salesOrderRecord.getCurrentSublistValue({ sublistId: 'item', fieldId: 'item' });
                    var soLocId   = salesOrderRecord.getCurrentSublistValue({ sublistId: 'item', fieldId: 'location' });
                    var soQty     = salesOrderRecord.getCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity' });

                    if (soLocId !== headerLocationId) {
                        nonHeaderLocationItems.push({
                            itemId:           soItemId,
                            locationId:       soLocId,
                            headerLocationId: headerLocationId,
                            quantity:         soQty
                        });
                    }
                }
            }

            /* ========= SINGLE-IF: INVENTORY TRANSFERS ========= */
            nonHeaderLocationItems.forEach(function (item) {
                // L74 lines never get inventory transfers
                if (L74_LOCS[Number(item.locationId)]) return;

                var stageBinId       = getStageBinByLocation(item.locationId);
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

            /* ========= TRANSFORM SO → ITEM FULFILLMENT ========= */
            var fulfillment = record.transform({
                fromType:  record.Type.SALES_ORDER,
                fromId:    soId,
                toType:    record.Type.ITEM_FULFILLMENT,
                isDynamic: true
            });

            fulfillment.setValue({ fieldId: 'shipstatus', value: 'C' });

            var itemLineCount    = fulfillment.getLineCount({ sublistId: 'item' });
            var hasFulfillLines  = false;
            var packageIndexMap  = {};
            var allTrackingArray = [];
            var l74ErrorNotes    = [];   // collected, written to SO field after save

            /* ========= PROCESS EACH FULFILLMENT LINE ========= */
            for (var i = 0; i < itemLineCount; i++) {

                fulfillment.selectLine({ sublistId: 'item', line: i });

                /* -- Single-IF: remap line location to header -- */
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
                var itemText       = getItemNameById(itemIdInternal) || String(itemIdInternal);
                var remainingQty   = Number(fulfillment.getCurrentSublistValue({
                    sublistId: 'item', fieldId: 'quantityremaining'
                })) || 0;

                var rawLineLocId   = Number(fulfillment.getCurrentSublistValue({
                    sublistId: 'item', fieldId: 'location'
                }));
                var lineLocationId = singleIf ? Number(headerLocationId) : rawLineLocId;
                var isL74          = !!L74_LOCS[lineLocationId];

                /* ─────────────────────────────────────────────────────────
                   RESOLVE QTY, TRACKING & PICKED BIN FROM WMS
                   Primary  → match by custcol_wms_unique_id
                   Fallback → match by item name
                ───────────────────────────────────────────────────────── */
                var uniqueId      = fulfillment.getCurrentSublistValue({
                    sublistId: 'item', fieldId: 'custcol_wms_unique_id'
                });

                var qtyToFulfill  = 0;
                var trackingList  = [];
                var pickedBinName = null;   // WMS bin_number string (needed for L74)

                if (uniqueId && pickMapByLine[uniqueId]) {
                    /* Primary: exact unique_id match */
                    var ld        = pickMapByLine[uniqueId];
                    qtyToFulfill  = Math.min(ld.qty, remainingQty);
                    trackingList  = ld.tracking.slice(0, qtyToFulfill);
                    pickedBinName = ld.pickedBin;
                    ld.qty       -= qtyToFulfill;
                    if (ld.qty <= 0) delete pickMapByLine[uniqueId];

                } else if (pickMapByItem[itemText]) {
                    /* Fallback: item name match */
                    var imd       = pickMapByItem[itemText];
                    qtyToFulfill  = Math.min(imd.qty, remainingQty);
                    trackingList  = imd.tracking.slice(0, qtyToFulfill);
                    pickedBinName = imd.pickedBin;
                    imd.qty      -= qtyToFulfill;
                    if (imd.qty <= 0) delete pickMapByItem[itemText];
                }

                log.debug('Processing Item Line', {
                    item: itemText, remainingQty: remainingQty, qtyToFulfill: qtyToFulfill
                });

                /* ========= SAFETY CHECK ========= */
                if (qtyToFulfill <= 0 || remainingQty <= 0) {
                    fulfillment.setCurrentSublistValue({ sublistId: 'item', fieldId: 'itemreceive', value: false });
                    fulfillment.commitLine({ sublistId: 'item' });
                    continue;
                }

                /* ─────────────────────────────────────────────────────────
                   DETERMINE EFFECTIVE BIN
                   L74          → WMS picked bin directly, no adjustment ever
                   All others   → stage bin via getStageBinByLocation;
                                  getInventoryByItemAndBin auto-adjusts if short
                ───────────────────────────────────────────────────────── */
                var effectiveBinId = null;

                if (isL74) {

                    /* ── L74: direct picked bin, no adjustment ── */
                    if (!pickedBinName) {
                        var errA = 'L74 SKIP (no bin): item=' + itemText
                            + ' loc=' + lineLocationId;
                        log.error('L74_BIN_MISSING', errA);
                        l74ErrorNotes.push(errA);
                        fulfillment.setCurrentSublistValue({ sublistId: 'item', fieldId: 'itemreceive', value: false });
                        fulfillment.commitLine({ sublistId: 'item' });
                        continue;
                    }

                    effectiveBinId = getInternalBinId(pickedBinName);
                    if (!effectiveBinId) {
                        var errB = 'L74 SKIP (bin resolve fail): item=' + itemText
                            + ' bin=' + pickedBinName;
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

                    /* ── All other locations: stage bin + auto-adjust if short ── */
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
                var itemWeight  = getItemWeight(itemIdInternal);

                /* ========= SET FULFILLMENT VALUES ========= */
                fulfillment.setCurrentSublistValue({ sublistId: 'item', fieldId: 'itemreceive', value: true });
                fulfillment.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity',    value: qtyToFulfill });

                assignInventoryDetail(fulfillment, qtyToFulfill, effectiveBinId);

                fulfillment.commitLine({ sublistId: 'item' });

                /* ========= CREATE PACKAGE LINES ========= */
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
                        SSCC:           trackObj.SSCC,
                        itemName:       itemText
                    });
                });

            } // end line loop

            if (!hasFulfillLines) throw 'No lines qualified for fulfillment.';

            /* ========= SAVE FULFILLMENT ========= */
            var fulfillmentId = fulfillment.save({
                enableSourcing:        true,
                ignoreMandatoryFields: true
            });

            /* ========= CUSTOM PACKAGE CONTENT ========= */
            createCustomPackageContents(fulfillmentId, allTrackingArray);

            /* ========= WRITE L74 ERROR NOTES TO SO ========= */
            if (l74ErrorNotes.length) {
                record.submitFields({
                    type:   record.Type.SALES_ORDER,
                    id:     soId,
                    values: {
                        custbody_jyswms_fufilment_error:
                            '[IF#' + fulfillmentId + '] ' + l74ErrorNotes.join(' | ')
                    }
                });
            }

            form.addField({
                id:    'custpage_success',
                type:  ui.FieldType.INLINEHTML,
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

            var now       = new Date();
            var estOffset = -5 * 60 * 60 * 1000;
            var estDate   = new Date(now.getTime() + estOffset);

            form.addField({
                id:    'custpage_error',
                type:  ui.FieldType.INLINEHTML,
                label: ' '
            }).defaultValue =
                '<h3 style="color:red">Error</h3>' +
                '<p>' + e + '</p>';
        }

        context.response.writePage(form);
    }

    /* ======================================
       BUILD PICK MAP BY UNIQUE_ID  (primary)
       Keyed by WMS line.unique_id.
       Stores pickedBin (bin_number from WMS) for L74 direct-bin use.
    ====================================== */
    function buildPickMapByLine(wmsLines) {
        var map = {};
        wmsLines.forEach(function (line) {
            if (!line.unique_id || line.is_picked !== 'picked') return;
            var qty = Number(line.quantity) || 0;
            if (!qty) return;

            map[line.unique_id] = {
                qty:      qty,
                tracking: [],
                pickedBin: line.bin_number || line.binnumber || line.binNumber || null
            };

            if (line.tracking_data && line.tracking_data.length) {
                line.tracking_data.forEach(function (track) {
                    map[line.unique_id].tracking.push({
                        trackingNumber: track.trackingNumber || '',
                        SSCC:           track.SSCC           || ''
                    });
                });
            }
        });
        return map;
    }

    /* ======================================
       BUILD PICK MAP BY ITEM NAME  (fallback)
       Keyed by item name. Captures first non-null picked bin per item.
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
                        SSCC:           track.SSCC           || ''
                    });
                });
            }
        });
        return map;
    }

    /* ======================================
       FILTER ALREADY-FULFILLED TRACKING NUMBERS
    ====================================== */
    function filterPickedTracking(pickMap, existingTracking) {
        Object.keys(pickMap).forEach(function (key) {
            var filtered = pickMap[key].tracking.filter(function (t) {
                return !existingTracking[t.trackingNumber];
            });
            pickMap[key].tracking = filtered;
            pickMap[key].qty      = filtered.length;
            if (pickMap[key].qty <= 0) delete pickMap[key];
        });
        return pickMap;
    }

    /* ======================================
       STAGE BIN BY LOCATION  (L41 & L60 only)
    ====================================== */
    function getStageBinByLocation(locationId) {
        if (Number(locationId) === 9)  return 4859;   // L41 – Flemington
        if (Number(locationId) === 15) return 16692;  // L60 – Hardeeville SC
        return null;
    }

    /* ======================================
       RESOLVE BIN NAME → NS INTERNAL ID
       Used for L74 WMS picked bin names (e.g. "L7402200102").
    ====================================== */
    function getInternalBinId(binName) {
        if (!binName) return null;
        var parsed = Number(binName);
        if (!isNaN(parsed) && parsed > 0) return parsed;
        try {
            var results = search.create({
                type:    'bin',
                filters: [['binnumber', 'is', String(binName)]],
                columns: [search.createColumn({ name: 'internalid' })]
            }).run().getRange({ start: 0, end: 1 });

            if (results && results.length) {
                var id = Number(results[0].getValue({ name: 'internalid' }));
                log.audit('getInternalBinId', '"' + binName + '" → ' + id);
                return id;
            }
            log.error('getInternalBinId', 'No bin found: ' + binName);
        } catch (e) {
            log.error('getInternalBinId', e);
        }
        return null;
    }

    /* ======================================
       CHECK INVENTORY — READ-ONLY  (L74 only)
       Returns true/false. Does NOT create an adjustment.
    ====================================== */
    function checkInventoryAvailableOnly(itemId, binId, qty, locationId) {
        var found = false;
        try {
            search.create({
                type: 'inventorybalance',
                filters: [
                    ['item',     'anyof',                itemId],
                    'AND',
                    ['binnumber','anyof',                binId],
                    'AND',
                    ['location', 'anyof',                locationId],
                    'AND',
                    ['onhand',   'greaterthanorequalto', qty]
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
       Original behaviour preserved exactly:
       if not found → creates positive adjustment, returns true.
    ====================================== */
    function getInventoryByItemAndBin(itemId, binId, quantity, locationId) {
        log.error('Getting Inventory by Item and Bin', {
            itemId: itemId, binId: binId, quantity: quantity, locationId: locationId
        });

        var inventorybalanceSearchObj = search.create({
            type: 'inventorybalance',
            filters: [
                ['item',     'anyof',      itemId],
                'AND',
                ['binnumber','anyof',       binId],
                'AND',
                ['onhand',   'greaterthan', quantity]
            ],
            columns: [
                search.createColumn({ name: 'onhand',    label: 'On Hand' }),
                search.createColumn({ name: 'available', label: 'Available' }),
                search.createColumn({ name: 'binnumber', label: 'Bin Number' }),
                search.createColumn({ name: 'location',  label: 'Location' }),
                search.createColumn({ name: 'internalid', join: 'binNumber', label: 'Internal ID' })
            ]
        });

        var invExists         = false;
        var searchResultCount = inventorybalanceSearchObj.runPaged().count;
        log.debug('inventorybalanceSearchObj result count', searchResultCount);

        inventorybalanceSearchObj.run().each(function (result) {
            invExists = true;
            return true;
        });

        if (!invExists) {
            var adjustmentObj    = {};
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

            invTransferRec.setValue({ fieldId: 'location',         value: fromLocation });
            invTransferRec.setValue({ fieldId: 'transferlocation', value: toLocation });
            invTransferRec.setValue({ fieldId: 'memo',
                value: 'Inventory Transfer for Fulfillment - SO: ' + soId });

            invTransferRec.selectNewLine({ sublistId: 'inventory' });
            invTransferRec.setCurrentSublistValue({ sublistId: 'inventory', fieldId: 'item',        value: itemId });
            invTransferRec.setCurrentSublistValue({ sublistId: 'inventory', fieldId: 'adjustqtyby', value: quantity });

            var invDetail = invTransferRec.getCurrentSublistSubrecord({
                sublistId: 'inventory', fieldId: 'inventorydetail'
            });
            invDetail.selectNewLine({ sublistId: 'inventoryassignment' });
            invDetail.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'binnumber',   value: fromBin });
            invDetail.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'tobinnumber', value: toBin });
            invDetail.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'quantity',    value: quantity });
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
            adjRec.setValue({ fieldId: 'subsidiary',  value: 1 });
            adjRec.setValue({ fieldId: 'memo',        value: 'Inventory Adj for Fulfillment' });
            adjRec.setValue({ fieldId: 'account',     value: 464 });
            adjRec.setValue({ fieldId: 'adjlocation', value: locationId });

            log.debug('Adjustment Object', adjustmentObj);
            log.debug('Location ID', locationId);
            log.debug('Bin ID', binId);

            for (var itemId in adjustmentObj) {
                var qty = adjustmentObj[itemId];
                adjRec.selectNewLine({ sublistId: 'inventory' });
                adjRec.setCurrentSublistValue({ sublistId: 'inventory', fieldId: 'item',        value: itemId });
                adjRec.setCurrentSublistValue({ sublistId: 'inventory', fieldId: 'location',    value: locationId });
                adjRec.setCurrentSublistValue({ sublistId: 'inventory', fieldId: 'adjustqtyby', value: qty });

                var inventoryDetail = adjRec.getCurrentSublistSubrecord({
                    sublistId: 'inventory', fieldId: 'inventorydetail'
                });
                inventoryDetail.selectNewLine({ sublistId: 'inventoryassignment' });
                inventoryDetail.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'binnumber', value: binId });
                inventoryDetail.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'quantity',  value: qty });
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
            var invDetail       = fulfillment.getCurrentSublistSubrecord({
                sublistId: 'item', fieldId: 'inventorydetail'
            });
            var assignmentCount = invDetail.getLineCount({ sublistId: 'inventoryassignment' });
            for (var i = assignmentCount - 1; i >= 0; i--) {
                invDetail.removeLine({ sublistId: 'inventoryassignment', line: i, ignoreRecalc: true });
            }
            invDetail.selectNewLine({ sublistId: 'inventoryassignment' });
            invDetail.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'binnumber', value: stageBinId });
            invDetail.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'quantity',  value: qty });
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

            var customerId      = fulfillmentRec.getValue({ fieldId: 'entity' });
            var LOWES_CUSTOMERS = [1952, 639];
            var isLowesCustomer = LOWES_CUSTOMERS.indexOf(Number(customerId)) !== -1;
            var sublistId       = 'recmachcustrecord_hj_packagecontents_sublist';

            var existingCount = fulfillmentRec.getLineCount({ sublistId: sublistId });
            for (var i = existingCount - 1; i >= 0; i--) {
                fulfillmentRec.removeLine({ sublistId: sublistId, line: i, ignoreRecalc: true });
            }

            var packageBoxNumber = 0;
            var seenTracking     = {};

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

                // Set UCC/SSCC when present; Lowes always gets it even if blank
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
       HELPERS
    ====================================== */
    function callWmsApi(soId) {
        var token    = tokenModule.generateToken();
        var response = https.get({
            url: 'https://api.jyswms.com/dropship-sales-order-status-with-bins?sales_order_id=' + soId,
            headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }
        });
        if (response.code !== 200) throw 'WMS API returned ' + response.code;
        var body        = JSON.parse(response.body || '{}');
        var sourceArray = (body.completed && body.completed.length) ? body.completed : body.notcompleted;
        return sourceArray[0].data || [];
    }

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
                ['type',     'anyof', 'ItemShip'],
                'AND',
                ['mainline', 'is',    'T'],
                'AND'
            ];
            var trackingFilter = [];
            trackingNumbers.forEach(function (num, index) {
                if (index > 0) trackingFilter.push('OR');
                trackingFilter.push(['shipmentpackage.trackingnumber', 'is', num]);
            });
            filters = filters.concat(trackingFilter);

            var fulfillmentSearch = search.create({
                type:    'itemfulfillment',
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