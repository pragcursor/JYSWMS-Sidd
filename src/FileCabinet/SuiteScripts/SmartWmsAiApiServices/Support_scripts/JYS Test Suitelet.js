/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 *
 * ORIGINAL FIXES (all preserved, untouched):
 *  FIX 1 — buildPickMapByLine: exact unique_id, no normalization.
 *  FIX 2 — filterPickedTracking: only removes tracking rows, reduces qty by removed count.
 *  FIX 3 — Single-IF gate runs AFTER filtering with checks (a) + (b).
 *
 * PERFORMANCE — SuiteQL replaces every search() call where possible:
 *  SQL 1 — resolveItemsBySuiteQL:      items + weights in one SQL query             (replaces per-line lookupFields × N)
 *  SQL 2 — resolveBinsBySuiteQL:       bin names → internal IDs in one SQL query    (replaces per-line bin search × N)
 *  SQL 3 — getExistingTrackingSQL:     existing tracking numbers in one SQL query   (replaces batched OR-filter searches)
 *  SQL 4 — checkInventorySQL:          inventory balance check in one SQL query     (replaces runPaged + run().each double-execution)
 *  SQL 5 — checkInventoryAvailSQL:     L74 inventory check via SQL                  (replaces per-line inventorybalance search)
 *
 * OTHER OPTIMIZATIONS:
 *  OPT 1 — createCustomPackageContents: isDynamic:false + setSublistValue (no select/commit overhead)
 *  OPT 2 — Package content lines cleared via isDynamic:false removeLine (avoids dynamic overhead)
 *  OPT 3 — customerId passed in — no second record.load of fulfillment
 *  OPT 4 — Governance checkpoints at key stages
 *  OPT 5 — getInventoryByItemAndBin: single SQL replaces double search execution
 */

define([
    'N/ui/serverWidget',
    'N/record',
    'N/https',
    'N/log',
    'N/search',
    'N/query',
    'N/runtime',
    '../JYSWMS_generateToken_API.js'
], function (ui, record, https, log, search, query, runtime, tokenModule) {

    /* ======================================
       CONSTANTS
    ====================================== */
    var L74_LOCS            = { 23: true, 24: true };
    var GOVERNANCE_WARN     = 300;

    /* ======================================
       GOVERNANCE HELPER
    ====================================== */
    function checkGovernance(label) {
        var rem = runtime.getCurrentScript().getRemainingUsage();
        log.audit('GOV [' + label + ']', rem + ' units remaining');
        if (rem < GOVERNANCE_WARN) log.error('GOV_LOW [' + label + ']', rem + ' units remaining');
    }

    /* ======================================
       ENTRY
    ====================================== */
    function onRequest(context) {

        var soId = context.request.parameters.custpage_soid;
        var form = ui.createForm({ title: 'WMS Fulfillment Result' });

        try {

            if (!soId) throw 'Sales Order Internal ID required.';

            checkGovernance('start');

            /* ========= CALL WMS ========= */
            var wmsLines = callWmsApi(soId);

            /* ========= SQL 1: resolve ALL items (name + weight) in one query ========= */
            var itemCache = resolveItemsBySuiteQL(wmsLines);   // { itemId: { name, weight } }

            /* ========= SQL 2: resolve ALL L74 bin names in one query ========= */
            var binCache = resolveBinsBySuiteQL(wmsLines);     // { binName: internalId }

            checkGovernance('after-cache');

            var pickMapByLine = buildPickMapByLine(wmsLines);
            var pickMapByItem = buildPickMapByItem(wmsLines);

            /* ========= SQL 3: existing tracking numbers via SuiteQL ========= */
            var allTracking      = extractTrackingNumbers(wmsLines);
            var existingTracking = getExistingTrackingSQL(allTracking);

            /* FIX 2 */
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

            var orderStatus      = salesOrderRecord.getValue({ fieldId: 'status' });
            var customer         = salesOrderRecord.getValue({ fieldId: 'entity' });
            var headerLocationId = salesOrderRecord.getValue({ fieldId: 'location' });
            var singleIf         = salesOrderRecord.getValue({ fieldId: 'custbody_wms_so_single_if' });

            if (orderStatus == 'Billed')             throw 'Sales Order is Billed. Cannot be processed.';
            if (customer == 476 || customer == 1807) throw 'Customer is Amazon. Cannot be processed.';

            /* ======================================================
               FIX 3 — SINGLE-IF GATE (runs after filtering)
            ====================================================== */
            if (singleIf) {

                /* (a) All positive-qty WMS lines must be picked */
                var notPicked = wmsLines.filter(function (line) {
                    return Number(line.quantity) > 0 && line.is_picked !== 'picked';
                });
                if (notPicked.length) {
                    throw 'Single IF requires ALL items to be picked. '
                        + notPicked.length + ' line(s) not yet picked.';
                }

                /* (b) Every SO line must resolve in the pick maps with qty > 0 */
                var soLineCountCheck = salesOrderRecord.getLineCount({ sublistId: 'item' });
                for (var g = 0; g < soLineCountCheck; g++) {
                    salesOrderRecord.selectLine({ sublistId: 'item', line: g });

                    var soUniqueId = salesOrderRecord.getCurrentSublistValue({
                        sublistId: 'item', fieldId: 'custcol_wms_unique_id'
                    });
                    var soItemIdChk   = salesOrderRecord.getCurrentSublistValue({
                        sublistId: 'item', fieldId: 'item'
                    });
                    var soItemNameChk = (itemCache[soItemIdChk] && itemCache[soItemIdChk].name)
                                        || getItemNameById(soItemIdChk)
                                        || String(soItemIdChk);

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
                    var soLocId  = salesOrderRecord.getCurrentSublistValue({ sublistId: 'item', fieldId: 'location' });
                    var soQty    = salesOrderRecord.getCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity' });

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

            checkGovernance('before-transform');

            /* ========= TRANSFORM SO -> ITEM FULFILLMENT ========= */
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
            var l74ErrorNotes    = [];

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

                /* SQL 1 cache — no per-line search */
                var itemText   = (itemCache[itemIdInternal] && itemCache[itemIdInternal].name)
                                  || getItemNameById(itemIdInternal)
                                  || String(itemIdInternal);
                var itemWeight = (itemCache[itemIdInternal] && itemCache[itemIdInternal].weight) || 0;

                var remainingQty   = Number(fulfillment.getCurrentSublistValue({
                    sublistId: 'item', fieldId: 'quantityremaining'
                })) || 0;
                var rawLineLocId   = Number(fulfillment.getCurrentSublistValue({
                    sublistId: 'item', fieldId: 'location'
                }));
                var lineLocationId = singleIf ? Number(headerLocationId) : rawLineLocId;
                var isL74          = !!L74_LOCS[lineLocationId];

                /* FIX 1: exact unique_id — no normalization */
                var uniqueId = fulfillment.getCurrentSublistValue({
                    sublistId: 'item', fieldId: 'custcol_wms_unique_id'
                });

                var qtyToFulfill  = 0;
                var trackingList  = [];
                var pickedBinName = null;

                if (uniqueId && pickMapByLine[uniqueId] && pickMapByLine[uniqueId].qty > 0) {

                    var ld        = pickMapByLine[uniqueId];
                    qtyToFulfill  = Math.min(ld.qty, remainingQty);
                    trackingList  = ld.tracking.slice(0, qtyToFulfill);
                    pickedBinName = ld.pickedBin;
                    ld.qty       -= qtyToFulfill;
                    if (ld.qty <= 0) delete pickMapByLine[uniqueId];

                    /*
                     * SPLIT-LINE DRAIN
                     *
                     * WMS generates siblings in TWO patterns:
                     *
                     * Pattern A — sequential numbers (original assumption):
                     *   "709707101"   "709707101-1"   "709707101-2"   "709707101-3"
                     *
                     * Pattern B — nested -1 chains (this order):
                     *   "709963759"   "709963759-1"   "709963759-1-1"   "709963759-1-1-1" ...
                     *
                     * Strategy: try BOTH patterns at each depth until remainingQty is satisfied.
                     * Walk the -1 chain first (append "-1" to last consumed key),
                     * then fall back to sequential increment off the original uniqueId.
                     * This handles mixed orders correctly.
                     */
                    var lastKey    = uniqueId;   // tracks end of the -1 chain
                    var sibIdx     = 1;          // tracks sequential counter
                    var maxDepth   = 50;         // safety cap — prevents infinite loop
                    var depth      = 0;

                    while (qtyToFulfill < remainingQty && depth < maxDepth) {
                        depth++;

                        /* Try Pattern B first: extend the -1 chain from lastKey */
                        var chainKey = lastKey + '-1';
                        /* Try Pattern A next: sequential off original uniqueId */
                        var seqKey   = uniqueId + '-' + sibIdx;

                        var foundKey = null;
                        if (pickMapByLine[chainKey] && pickMapByLine[chainKey].qty > 0) {
                            foundKey = chainKey;
                            lastKey  = chainKey;   // advance chain pointer
                        } else if (chainKey !== seqKey && pickMapByLine[seqKey] && pickMapByLine[seqKey].qty > 0) {
                            foundKey = seqKey;
                            lastKey  = seqKey;     // advance chain pointer to seq key
                        }

                        if (!foundKey) break;      // neither pattern has more siblings

                        var sib    = pickMapByLine[foundKey];
                        var sibQty = Math.min(sib.qty, remainingQty - qtyToFulfill);
                        trackingList  = trackingList.concat(sib.tracking.slice(0, sibQty));
                        if (!pickedBinName) pickedBinName = sib.pickedBin;
                        qtyToFulfill += sibQty;
                        sib.qty      -= sibQty;
                        if (sib.qty <= 0) delete pickMapByLine[foundKey];

                        sibIdx++;   // always advance seq counter regardless of which pattern matched
                    }

                    /* Drain item-name fallback for residual qty */
                    if (qtyToFulfill < remainingQty && pickMapByItem[itemText] && pickMapByItem[itemText].qty > 0) {
                        var imdExtra  = pickMapByItem[itemText];
                        var extraQty  = Math.min(imdExtra.qty, remainingQty - qtyToFulfill);
                        trackingList  = trackingList.concat(imdExtra.tracking.splice(0, extraQty));
                        if (!pickedBinName) pickedBinName = imdExtra.pickedBin;
                        qtyToFulfill += extraQty;
                        imdExtra.qty -= extraQty;
                        if (imdExtra.qty <= 0) delete pickMapByItem[itemText];
                    }

                } else if (pickMapByItem[itemText] && pickMapByItem[itemText].qty > 0) {

                    var imd       = pickMapByItem[itemText];
                    qtyToFulfill  = Math.min(imd.qty, remainingQty);
                    trackingList  = imd.tracking.slice(0, qtyToFulfill);
                    pickedBinName = imd.pickedBin;
                    imd.qty      -= qtyToFulfill;
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

                    /* SQL 2 cache — no per-line bin search */
                    effectiveBinId = (binCache[pickedBinName] !== undefined)
                                      ? binCache[pickedBinName]
                                      : getInternalBinId(pickedBinName);

                    if (!effectiveBinId) {
                        var errB = 'L74 SKIP (bin resolve fail): item=' + itemText + ' bin=' + pickedBinName;
                        log.error('L74_BIN_RESOLVE', errB);
                        l74ErrorNotes.push(errB);
                        fulfillment.setCurrentSublistValue({ sublistId: 'item', fieldId: 'itemreceive', value: false });
                        fulfillment.commitLine({ sublistId: 'item' });
                        continue;
                    }

                    /* SQL 5: L74 inventory check via SuiteQL */
                    var l74hasStock = checkInventoryAvailSQL(
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

                    /* SQL 4: single SQL replaces double search execution */
                    var checkBinExists = getInventoryByItemAndBin(
                        itemIdInternal, stageBinId, remainingQty, lineLocationId
                    );
                    if (!checkBinExists) {
                        throw 'Inventory not found for item: ' + itemText + ' in bin: ' + stageBinId;
                    }
                    effectiveBinId = stageBinId;
                }

                hasFulfillLines = true;

                fulfillment.setCurrentSublistValue({ sublistId: 'item', fieldId: 'itemreceive', value: true });
                fulfillment.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity',    value: qtyToFulfill });

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
                        SSCC:           trackObj.SSCC,
                        itemName:       itemText
                    });
                });

            } // end line loop

            if (!hasFulfillLines) throw 'No lines qualified for fulfillment.';

            checkGovernance('before-fulfillment-save');

            var fulfillmentId = fulfillment.save({
                enableSourcing:        true,
                ignoreMandatoryFields: true
            });

            checkGovernance('after-fulfillment-save');

            /* OPT 3: pass customer — no second record.load */
            createCustomPackageContents(fulfillmentId, allTrackingArray, customer);

            checkGovernance('after-package-contents');

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

            form.addField({
                id:    'custpage_error',
                type:  ui.FieldType.INLINEHTML,
                label: ' '
            }).defaultValue = '<h3 style="color:red">Error</h3><p>' + e + '</p>';
        }

        context.response.writePage(form);
    }

    /* ======================================
       SQL 1 — RESOLVE ITEMS VIA SUITEQL
       Single query fetches name + weight for ALL unique items in wmsLines.
       Returns cache keyed by both internalId AND itemName for flexible lookup.
    ====================================== */
    function resolveItemsBySuiteQL(wmsLines) {

        var cache     = {};
        var itemNames = [];
        var seen      = {};

        wmsLines.forEach(function (line) {
            if (line.item && !seen[line.item]) {
                seen[line.item] = true;
                itemNames.push(line.item);
            }
        });

        if (!itemNames.length) return cache;

        /* Build quoted IN list: 'ITEM1','ITEM2',... */
        var inList = itemNames.map(function (n) {
            return "'" + n.replace(/'/g, "''") + "'";
        }).join(',');

        try {
            var sql = "SELECT id, itemid, weight FROM item WHERE itemid IN (" + inList + ")";
            var results = query.runSuiteQL({ query: sql }).asMappedResults();

            results.forEach(function (row) {
                var id     = String(row.id);
                var name   = row.itemid;
                var weight = Number(row.weight) || 0;
                /* Index by both internal ID and item name */
                cache[id]   = { name: name, weight: weight };
                cache[name] = { name: name, weight: weight, id: id };
            });

        } catch (e) {
            log.error('resolveItemsBySuiteQL', e);
        }

        log.audit('SQL_ITEMS', 'Resolved ' + Object.keys(cache).length + ' entries for ' + itemNames.length + ' items');
        return cache;
    }

    /* ======================================
       SQL 2 — RESOLVE BIN NAMES VIA SUITEQL
       Single query for all non-numeric bin names from wmsLines.
       Returns { binName: internalId }
    ====================================== */
    function resolveBinsBySuiteQL(wmsLines) {

        var cache    = {};
        var toSearch = [];
        var seen     = {};

        wmsLines.forEach(function (line) {
            var bin = line.bin_number || line.binnumber || line.binNumber || null;
            if (!bin || seen[bin]) return;
            seen[bin] = true;

            var parsed = Number(bin);
            if (!isNaN(parsed) && parsed > 0) {
                /* Numeric bin name IS the internal ID */
                cache[bin] = parsed;
            } else {
                toSearch.push(bin);
            }
        });

        if (!toSearch.length) return cache;

        var inList = toSearch.map(function (b) {
            return "'" + b.replace(/'/g, "''") + "'";
        }).join(',');

        try {
            var sql = "SELECT id, binnumber FROM bin WHERE binnumber IN (" + inList + ")";
            var results = query.runSuiteQL({ query: sql }).asMappedResults();

            results.forEach(function (row) {
                cache[row.binnumber] = Number(row.id);
            });

        } catch (e) {
            log.error('resolveBinsBySuiteQL', e);
        }

        log.audit('SQL_BINS', 'Resolved ' + Object.keys(cache).length + ' bin entries');
        return cache;
    }

    /* ======================================
       SQL 3 — EXISTING TRACKING NUMBERS VIA SUITEQL
       Replaces batched OR-filter search with a single SQL IN query.
       Handles any order size without governance concerns.
    ====================================== */
    function getExistingTrackingSQL(trackingNumbers) {

        var existingTracking = {};

        if (!trackingNumbers || !trackingNumbers.length) return existingTracking;

        try {
            /* Build IN list in chunks — SuiteQL handles large IN lists efficiently */
            var CHUNK = 500;
            for (var start = 0; start < trackingNumbers.length; start += CHUNK) {

                var batch  = trackingNumbers.slice(start, start + CHUNK);
                var inList = batch.map(function (t) {
                    return "'" + String(t).replace(/'/g, "''") + "'";
                }).join(',');

                /*
                 * ItemFulfillmentPackage joins to ItemFulfillment.
                 * type = 'ItemShip' equivalent is the record type filter on parent.
                 */
                var sql =
                    "SELECT ifp.trackingnumber " +
                    "FROM ItemFulfillmentPackage ifp " +
                    "INNER JOIN ItemFulfillment iff ON iff.id = ifp.itemfulfillment " +
                    "WHERE ifp.trackingnumber IN (" + inList + ")";

                var results = query.runSuiteQL({ query: sql }).asMappedResults();

                results.forEach(function (row) {
                    if (row.trackingnumber) existingTracking[String(row.trackingnumber)] = true;
                });
            }

        } catch (e) {
            log.error('getExistingTrackingSQL', e);
        }

        log.audit('SQL_TRACKING', 'Found ' + Object.keys(existingTracking).length + ' already-fulfilled tracking numbers');
        return existingTracking;
    }

    /* ======================================
       SQL 4 — INVENTORY CHECK + AUTO-ADJUST (non-L74)
       Replaces runPaged().count + run().each() double execution
       with a single SuiteQL COUNT query.
    ====================================== */
    function getInventoryByItemAndBin(itemId, binId, quantity, locationId) {

        log.error('Getting Inventory by Item and Bin', {
            itemId: itemId, binId: binId, quantity: quantity, locationId: locationId
        });

        var invExists = false;

        try {
            /*
             * InventoryBalance view: item, binnumber (id), location, quantityonhand
             * Note: binnumber column in InventoryBalance is the bin internal ID.
             */
            var sql =
                "SELECT COUNT(*) AS cnt " +
                "FROM InventoryBalance ib " +
                "WHERE ib.item        = " + Number(itemId)   + " " +
                "AND   ib.binnumber   = " + Number(binId)    + " " +
                "AND   ib.location    = " + Number(locationId) + " " +
                "AND   ib.quantityonhand > " + Number(quantity);

            var results = query.runSuiteQL({ query: sql }).asMappedResults();
            invExists   = results.length > 0 && Number(results[0].cnt) > 0;

        } catch (e) {
            log.error('getInventoryByItemAndBin SQL', e);
        }

        if (!invExists) {
            var adjustmentObj    = {};
            adjustmentObj[itemId] = quantity;
            createPositiveAdjustment(adjustmentObj, locationId, binId);
            invExists = true;
        }

        return invExists;
    }

    /* ======================================
       SQL 5 — L74 INVENTORY CHECK VIA SUITEQL
       Replaces search.create inventorybalance with a SQL COUNT.
    ====================================== */
    function checkInventoryAvailSQL(itemId, binId, qty, locationId) {

        try {
            var sql =
                "SELECT COUNT(*) AS cnt " +
                "FROM InventoryBalance ib " +
                "WHERE ib.item             = " + Number(itemId)    + " " +
                "AND   ib.binnumber        = " + Number(binId)     + " " +
                "AND   ib.location         = " + Number(locationId) + " " +
                "AND   ib.quantityonhand  >= " + Number(qty);

            var results = query.runSuiteQL({ query: sql }).asMappedResults();
            return results.length > 0 && Number(results[0].cnt) > 0;

        } catch (e) {
            log.error('checkInventoryAvailSQL', e);
            return false;
        }
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

            var key = String(line.unique_id);

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
                        SSCC:           track.SSCC           || ''
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
                        SSCC:           track.SSCC           || ''
                    });
                });
            }
        });
        return map;
    }

    /* ======================================
       FILTER ALREADY-FULFILLED TRACKING
       FIX 2: Only strips tracking rows. Reduces qty by removed count.
    ====================================== */
    function filterPickedTracking(pickMap, existingTracking) {
        Object.keys(pickMap).forEach(function (key) {
            var before   = pickMap[key].tracking.length;
            var filtered = pickMap[key].tracking.filter(function (t) {
                return !existingTracking[t.trackingNumber];
            });
            var removed           = before - filtered.length;
            pickMap[key].tracking = filtered;
            pickMap[key].qty     -= removed;

            if (pickMap[key].qty <= 0) {
                delete pickMap[key];
            }
        });
        return pickMap;
    }

    /* ======================================
       STAGE BIN BY LOCATION  (L41 & L60 only)
    ====================================== */
    function getStageBinByLocation(locationId) {
        if (Number(locationId) === 9)  return 4859;
        if (Number(locationId) === 15) return 16692;
        return null;
    }

    /* ======================================
       RESOLVE BIN NAME -> NS INTERNAL ID  (fallback for cache miss)
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
       INVENTORY TRANSFER
    ====================================== */
    function createInventoryTransfer(itemId, quantity, fromLocation, toLocation, fromBin, toBin, soId) {
        try {
            log.error('Creating Inventory Transfer', {
                itemId: itemId, quantity: quantity,
                fromLocation: fromLocation, toLocation: toLocation,
                fromBin: fromBin, toBin: toBin, soId: soId
            });

            var invTransferRec = record.create({ type: record.Type.INVENTORY_TRANSFER, isDynamic: true });
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
            var adjRec = record.create({ type: record.Type.INVENTORY_ADJUSTMENT, isDynamic: true });
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
       OPT 1 — CREATE CUSTOM PACKAGE CONTENTS
       isDynamic:false + direct setSublistValue (no select/commit per row).
       customerId passed in — no second record.load.
       seenTracking dedup logic unchanged.
    ====================================== */
    function createCustomPackageContents(fulfillmentId, trackingArray, customerId) {
        try {

            var LOWES_CUSTOMERS = [1952, 639];
            var isLowesCustomer = LOWES_CUSTOMERS.indexOf(Number(customerId)) !== -1;
            var sublistId       = 'recmachcustrecord_hj_packagecontents_sublist';

            /* Non-dynamic: bulk write without select/commit overhead */
            var fulfillmentRec = record.load({
                type:      record.Type.ITEM_FULFILLMENT,
                id:        fulfillmentId,
                isDynamic: false
            });

            /* Clear existing lines from end to avoid index shifting */
            var existingCount = fulfillmentRec.getLineCount({ sublistId: sublistId });
            for (var d = existingCount - 1; d >= 0; d--) {
                fulfillmentRec.removeLine({ sublistId: sublistId, line: d, ignoreRecalc: true });
            }

            var packageBoxNumber = 0;
            var seenTracking     = {};
            var lineIdx          = 0;

            trackingArray.forEach(function (line) {
                if (!line.trackingNumber) return;
                if (seenTracking[line.trackingNumber]) return;

                seenTracking[line.trackingNumber] = true;
                packageBoxNumber++;

                fulfillmentRec.setSublistValue({ sublistId: sublistId, fieldId: 'custrecordhj_pkgbox',                  line: lineIdx, value: packageBoxNumber     });
                fulfillmentRec.setSublistValue({ sublistId: sublistId, fieldId: 'custrecordhj_pkg_trackingnumber',      line: lineIdx, value: line.trackingNumber   });
                fulfillmentRec.setSublistValue({ sublistId: sublistId, fieldId: 'custrecordhj_pkg_desc',                line: lineIdx, value: line.itemName + '/1' });
                fulfillmentRec.setSublistValue({ sublistId: sublistId, fieldId: 'custrecord_jyswms_createdfrom',        line: lineIdx, value: true                 });
                fulfillmentRec.setSublistValue({ sublistId: sublistId, fieldId: 'custrecord_jyswms_item_not_populated', line: lineIdx, value: true                 });
                fulfillmentRec.setSublistValue({ sublistId: sublistId, fieldId: 'custrecord_jyswms_fulfillment_link',   line: lineIdx, value: true                 });

                if (line.SSCC || isLowesCustomer) {
                    fulfillmentRec.setSublistValue({ sublistId: sublistId, fieldId: 'custrecordhj_ucc', line: lineIdx, value: line.SSCC || '' });
                }

                lineIdx++;
            });

            fulfillmentRec.save({ enableSourcing: true, ignoreMandatoryFields: true });
            log.audit('PACKAGE_CONTENTS_SAVED', packageBoxNumber + ' records written');

        } catch (e) {
            log.error('Custom Package Content Error', e);
        }
    }

    /* ======================================
       WMS API
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

    /* ======================================
       HELPERS — kept as fallback
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