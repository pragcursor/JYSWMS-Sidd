/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 */
define([
    'N/log',
    'N/search',
    'N/https',
    'N/record',
    '../JYSWMS_generateToken_API.js'
], function (log, search, https, record, tokenModule) {

    const ADJUSTMENT_ACCOUNT = 464; // ⚠️ REQUIRED

    function onRequest(context) {
        try {
            var soId = context.request.parameters.custpage_soid;
            if (!soId) throw 'SO ID required';

            var apiRes = callWMSAPI(soId);
            var parsed = JSON.parse(apiRes.body);
            log.error('parsed', parsed);
            var pickedMap = extractPickedDetails(parsed);
            var filteredMap = filterPickedMap(pickedMap);
            log.error('filteredMap', filteredMap);

            var isSingleIF = getSingleIFFlag(soId);

            // ALWAYS compute from RAW pickedMap
            if (isSingleIF == true || isSingleIF == 'T') {

                // HARD STOP if not fully picked
                validateSingleIFFullPick(soId, pickedMap);

                // Only after validation → use filtered data
                var executionData = buildExecutionData(filteredMap);

                processFulfillment(soId, executionData, true);

            } else {

                // Partial allowed
                var executionData = buildExecutionData(filteredMap);
                log.error('executionData', executionData);
                processFulfillment(soId, executionData, isSingleIF);
            }

        } catch (e) {
            log.error('ERROR', e);
            context.response.write('ERROR: ' + e);
        }
        context.response.write('SUCCESS: Fulfillment created successfully for SO: ' + soId);
    }

    // -------------------------------
    // BUILD EXECUTION DATA
    // -------------------------------
    function buildExecutionData(pickedMap) {
        var lines = [];

        Object.keys(pickedMap).forEach(function (key) {
            pickedMap[key].forEach(function (l) {
                lines.push({
                    itemText: l.item,
                    qty: l.quantity,
                    binText: l.bin,
                    tracking: l.tracking
                });
            });
        });

        var itemMap = getItemInternalIds(lines.map(l => l.itemText));
        var binData = getBinData(lines.map(l => l.binText));

        lines.forEach(function (l) {
            l.itemId = itemMap[l.itemText];
            l.binId = binData[l.binText].id;
            l.location = binData[l.binText].location;
        });

        return lines;
    }

    // -------------------------------
    // MAIN PROCESSOR
    // -------------------------------
    function processFulfillment(soId, lines, isSingleIF) {

        var headerLocation = getSOLocation(soId);
        var stageBins = getStageBins();

        if (isSingleIF) {
            handleSingleIF(soId, lines, headerLocation, stageBins);
        } else {
            handleMultiIF(soId, lines);
        }
    }

    // -------------------------------
    // SINGLE IF
    // -------------------------------
    // function handleSingleIF(soId, lines, headerLocation, stageBins) {

    //     var stageBin = stageBins[headerLocation];

    //     lines.forEach(function (l) {

    //         if (l.location != headerLocation) {

    //             var available = getAvailableQty(l.itemId, l.binId);

    //             if (available >= l.qty) {
    //                 createInventoryTransfer(
    //                     l.itemId, l.qty,
    //                     l.location, headerLocation,
    //                     l.binId, stageBin
    //                 );
    //             } else {
    //                 createInventoryAdjustment(
    //                     l.itemId, headerLocation, stageBin, l.qty
    //                 );
    //             }

    //         } else {
    //             var available = getAvailableQty(l.itemId, l.binId);

    //             if (available < l.qty) {
    //                 createInventoryAdjustment(
    //                     l.itemId, headerLocation, stageBin, l.qty
    //                 );
    //             }
    //         }
    //     });

    //     createIF(soId, lines, headerLocation, stageBin);
    // }

    function handleSingleIF(soId, lines, headerLocation, stageBins) {

        var stageBin = stageBins[headerLocation];

        lines.forEach(function (l) {

            if (l.location != headerLocation) {

                // WARNING: N+1 Governance Bomb still exists here
                var sourceAvailable = getAvailableQty(l.itemId, l.binId);

                if (sourceAvailable >= l.qty) {
                    // Scenario 1: Perfect Inventory. Transfer the full amount.
                    createInventoryTransfer(
                        l.itemId, l.qty,
                        l.location, headerLocation,
                        l.binId, stageBin
                    );
                } else if (sourceAvailable > 0) {
                    // Scenario 2: Partial Shortage. Transfer what exists, adjust the delta.
                    var delta = l.qty - sourceAvailable;

                    createInventoryTransfer(
                        l.itemId, sourceAvailable,
                        l.location, headerLocation,
                        l.binId, stageBin
                    );

                    createInventoryAdjustment(
                        l.itemId, headerLocation, stageBin, delta
                    );
                } else {
                    // Scenario 3: Complete Shortage. Adjust the full amount at destination.
                    createInventoryAdjustment(
                        l.itemId, headerLocation, stageBin, l.qty
                    );
                }

            } else {

                // Item is already at the correct location, but we must verify bin quantity
                var destAvailable = getAvailableQty(l.itemId, l.binId);

                if (destAvailable < l.qty) {
                    // Calculate the delta to avoid fabricating the entire quantity
                    var delta = l.qty - destAvailable;

                    createInventoryAdjustment(
                        l.itemId, headerLocation, stageBin, delta
                    );
                }
            }
        });

        createIF(soId, lines, headerLocation, stageBin);
    }

    // -------------------------------
    // MULTI IF
    // -------------------------------
    function handleMultiIF(soId, lines) {

        lines.forEach(function (l) {
            var available = getAvailableQty(l.itemId, l.binId);

            if (available < l.qty) {
                createInventoryAdjustment(
                    l.itemId, l.location, l.binId, l.qty
                );
            }
        });

        createIFMultiLocation(soId, lines);
    }

    // -------------------------------
    // CREATE IF (Single Location)
    // -------------------------------
    function createIF(soId, lines, location, binId) {

        var ifRec = record.transform({
            fromType: record.Type.SALES_ORDER,
            fromId: soId,
            toType: record.Type.ITEM_FULFILLMENT,
            isDynamic: true
        });

        ifRec.setValue({ fieldId: 'location', value: location });

        var lineCount = ifRec.getLineCount({ sublistId: 'item' });
        var validLineCount = 0; // Guardrail against blind saves

        for (var i = 0; i < lineCount; i++) {

            var itemId = ifRec.getSublistValue({
                sublistId: 'item',
                fieldId: 'item',
                line: i
            });

            var matched = lines.filter(l => l.itemId == itemId);

            // MANDATORY: Select the line before doing anything dynamic
            ifRec.selectLine({ sublistId: 'item', line: i });
            ifRec.setCurrentSublistValue({
                sublistId: 'item',
                fieldId: 'location',
                value: location // The header location passed into the function
            });
            if (!matched.length) {
                ifRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'itemreceive', value: false });
                ifRec.commitLine({ sublistId: 'item' });
                continue;
            }

            // THE BLIND OVERRIDE: Calculate total picked from WMS payload
            var pickedQty = matched.reduce((sum, l) => sum + l.qty, 0);

            // Hard stop if WMS sent 0 for this matched item
            if (pickedQty <= 0) {
                ifRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'itemreceive', value: false });
                ifRec.commitLine({ sublistId: 'item' });
                continue;
            }

            // Explicitly force the fulfillment line state
            ifRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'itemreceive', value: true });

            ifRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity', value: pickedQty });

            var invDetail = ifRec.getCurrentSublistSubrecord({
                sublistId: 'item',
                fieldId: 'inventorydetail'
            });

            // Prevent duplicate inventory assignment errors by wiping defaults first
            var count = invDetail.getLineCount({ sublistId: 'inventoryassignment' });
            for (var j = count - 1; j >= 0; j--) {
                invDetail.removeLine({
                    sublistId: 'inventoryassignment',
                    line: j,
                    ignoreRecalc: true
                });
            }

            var bulkBins = getStageBins();
            var bulkBinId = bulkBins[location];

            matched.forEach(function (l) {

                // WARNING: THIS IS STILL A GOVERNANCE BOMB (N+1 Query)
                var bulkQty = getAvailableQty(l.itemId, bulkBinId);
                var pickedQtyBin = getAvailableQty(l.itemId, l.binId);

                var useBin;

                if (bulkQty >= l.qty) {
                    useBin = bulkBinId;
                } else if (pickedQtyBin >= l.qty) {
                    useBin = l.binId;
                } else {
                    createInventoryAdjustment(l.itemId, location, bulkBinId, l.qty);
                    useBin = bulkBinId;
                }

                invDetail.selectNewLine({ sublistId: 'inventoryassignment' });
                invDetail.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'binnumber', value: useBin });
                invDetail.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'quantity', value: l.qty });
                invDetail.commitLine({ sublistId: 'inventoryassignment' });
            });

            ifRec.commitLine({ sublistId: 'item' });
            validLineCount++;
        }

        // The Blind Save Fix
        if (validLineCount === 0) {
            log.audit('Skipping Save', 'No valid lines to fulfill for Single Location SO: ' + soId);
            return null;
        }

        // ---------------------------------------------------------
        // NATIVE PACKAGE GENERATION (Direct Line Iteration)
        // ---------------------------------------------------------

        // Fetch weights ONCE using your helper
        var itemWeights = getItemWeights(lines.map(l => l.itemId));

        // Iterate directly over the lines array as requested
        lines.forEach(function (l) {

            // Skip items that don't have tracking data
            if (!l.tracking) return;

            // Calculate weight (default to 1 if missing to prevent native NetSuite crash)
            var w = parseFloat(itemWeights[l.itemId]) || 1;
            var totalWeight = w * l.qty;

            ifRec.selectNewLine({ sublistId: 'package' });

            ifRec.setCurrentSublistValue({
                sublistId: 'package',
                fieldId: 'packagetrackingnumber',
                value: l.tracking
            });

            ifRec.setCurrentSublistValue({
                sublistId: 'package',
                fieldId: 'packageweight',
                value: totalWeight
            });

            ifRec.commitLine({ sublistId: 'package' });
        });

        var ifId = ifRec.save();

        // Ensure custom package contents are mapped on single IFs too
        createCustomPackageContents(ifId, lines);

        return ifId;
    }
    // -------------------------------
    // CREATE IF MULTI LOCATION
    // -------------------------------
    function createIFMultiLocation(soId, lines) {
        log.error('createIFMultiLocation', { soId, lines });

        var ifRec = record.transform({
            fromType: record.Type.SALES_ORDER,
            fromId: soId,
            toType: record.Type.ITEM_FULFILLMENT,
            isDynamic: true
        });

        ifRec.setValue('shipstatus', 'C');
        var lineCount = ifRec.getLineCount({ sublistId: 'item' });

        // 1. ADDED: Track if any lines are actually being fulfilled
        var validLineCount = 0;

        for (var i = 0; i < lineCount; i++) {

            var itemId = ifRec.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i });
            var matched = lines.filter(l => l.itemId == itemId);

            // MANDATORY: Select the line first
            ifRec.selectLine({ sublistId: 'item', line: i });

            if (!matched.length) {
                ifRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'itemreceive', value: false });
                ifRec.commitLine({ sublistId: 'item' });
                continue;
            }

            // THE BLIND OVERRIDE: Calculate total picked from WMS payload
            var pickedQty = matched.reduce((sum, l) => sum + l.qty, 0);

            // Hard stop if WMS sent 0 for this matched item
            if (pickedQty <= 0) {
                ifRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'itemreceive', value: false });
                ifRec.commitLine({ sublistId: 'item' });
                continue;
            }

            // Force the fulfillment
            ifRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'itemreceive', value: true });

            // DANGER: We are explicitly overriding NetSuite's suggested quantity with the WMS quantity
            ifRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity', value: pickedQty });
            var invDetail = ifRec.getCurrentSublistSubrecord({
                sublistId: 'item',
                fieldId: 'inventorydetail'
            });

            var count = invDetail.getLineCount({ sublistId: 'inventoryassignment' });
            for (var j = count - 1; j >= 0; j--) {
                invDetail.removeLine({
                    sublistId: 'inventoryassignment',
                    line: j,
                    ignoreRecalc: true
                });
            }

            var bulkBins = getStageBins();

            matched.forEach(function (l) {
                var bulkBinId = bulkBins[l.location];
                var bulkQty = getAvailableQty(l.itemId, bulkBinId);
                var pickedQty = getAvailableQty(l.itemId, l.binId);

                var useBin;

                if (bulkQty >= l.qty) {
                    useBin = bulkBinId;
                } else if (pickedQty >= l.qty) {
                    useBin = l.binId;
                } else {
                    createInventoryAdjustment(l.itemId, l.location, bulkBinId, l.qty);
                    useBin = bulkBinId;
                }

                invDetail.selectNewLine({ sublistId: 'inventoryassignment' });
                invDetail.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'binnumber', value: useBin });
                invDetail.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'quantity', value: l.qty });
                invDetail.commitLine({ sublistId: 'inventoryassignment' });
            });

            ifRec.commitLine({ sublistId: 'item' });
            validLineCount++; // Line successfully processed
        }

        // 3. FIXED: Hard stop if no lines are valid to prevent the native NetSuite USER_ERROR
        if (validLineCount === 0) {
            log.audit('Skipping Save', 'No valid lines to fulfill for SO: ' + soId);
            return null;
        }

        // Fetch weights ONCE using your helper
        var itemWeights = getItemWeights(lines.map(l => l.itemId));

        lines.forEach(function (l) {

            // Skip items that don't have tracking data
            if (!l.tracking) return;

            // Calculate weight (default to 1 if missing to prevent native NetSuite crash)
            var w = parseFloat(itemWeights[l.itemId]) || 1;
            var totalWeight = w * l.qty;

            ifRec.selectNewLine({ sublistId: 'package' });

            ifRec.setCurrentSublistValue({
                sublistId: 'package',
                fieldId: 'packagetrackingnumber',
                value: l.tracking
            });

            ifRec.setCurrentSublistValue({
                sublistId: 'package',
                fieldId: 'packageweight',
                value: totalWeight
            });

            ifRec.commitLine({ sublistId: 'package' });
        });
        var ifId = ifRec.save();
        createCustomPackageContents(ifId, lines);

        return ifId;
    }

    function createCustomPackageContents(fulfillmentId, lines) {

        try {

            var fulfillmentRec = record.load({
                type: record.Type.ITEM_FULFILLMENT,
                id: fulfillmentId,
                isDynamic: true
            });

            var customerId = fulfillmentRec.getValue({ fieldId: 'entity' });

            var isLowesCustomer = false;
            var LOWES_CUSTOMERS = [1952, 639];

            if (LOWES_CUSTOMERS.indexOf(Number(customerId)) !== -1) {
                isLowesCustomer = true;
            }

            var sublistId = 'recmachcustrecord_hj_packagecontents_sublist';

            // 🔴 Clear existing
            var existingCount = fulfillmentRec.getLineCount({ sublistId: sublistId });

            for (var i = existingCount - 1; i >= 0; i--) {
                fulfillmentRec.removeLine({
                    sublistId: sublistId,
                    line: i,
                    ignoreRecalc: true
                });
            }

            var packageBoxNumber = 0;

            var itemWeightCache = {};

            lines.forEach(function (l) {

                // 🔴 STRICT RULE: one tracking = one package
                if (!l.tracking) return;

                packageBoxNumber++;

                // 🔥 Weight
                if (!itemWeightCache[l.itemId]) {
                    log.error('getItemWeights', l.itemId);
                    itemWeightCache[l.itemId] = getItemWeights([l.itemId]);
                    log.error('itemWeightCache', itemWeightCache);
                }

                var itemWeight = itemWeightCache[l.itemId][l.itemId] || 1;

                fulfillmentRec.selectNewLine({ sublistId: sublistId });

                fulfillmentRec.setCurrentSublistValue({
                    sublistId: sublistId,
                    fieldId: 'custrecordhj_pkgbox',
                    value: packageBoxNumber
                });

                fulfillmentRec.setCurrentSublistValue({
                    sublistId: sublistId,
                    fieldId: 'custrecordhj_pkg_trackingnumber',
                    value: l.tracking
                });

                // SSCC
                if (l.sscc) {
                    fulfillmentRec.setCurrentSublistValue({
                        sublistId: sublistId,
                        fieldId: 'custrecordhj_ucc',
                        value: l.sscc
                    });
                }

                if (isLowesCustomer && l.sscc) {
                    fulfillmentRec.setCurrentSublistValue({
                        sublistId: sublistId,
                        fieldId: 'custrecordhj_ucc',
                        value: l.sscc
                    });
                }

                // 🔥 Description (NO grouping)
                fulfillmentRec.setCurrentSublistValue({
                    sublistId: sublistId,
                    fieldId: 'custrecordhj_pkg_desc',
                    value: l.itemText + '/' + (l.qty || 1)
                });

                // Weight (per package)
                fulfillmentRec.setCurrentSublistValue({
                    sublistId: sublistId,
                    fieldId: 'custrecordhj_tc_packagecontentslbs',
                    value: itemWeight
                });

                // FLAGS
                fulfillmentRec.setCurrentSublistValue({
                    sublistId: sublistId,
                    fieldId: 'custrecord_jyswms_createdfrom',
                    value: true
                });

                fulfillmentRec.setCurrentSublistValue({
                    sublistId: sublistId,
                    fieldId: 'custrecord_jyswms_item_not_populated',
                    value: true
                });

                // fulfillmentRec.setCurrentSublistValue({
                //     sublistId: sublistId,
                //     fieldId: 'custrecord_jyswms_fulfillment_link',
                //     value: true
                // });

                fulfillmentRec.commitLine({ sublistId: sublistId });

            });

            fulfillmentRec.save({
                enableSourcing: true,
                ignoreMandatoryFields: true
            });

        } catch (e) {
            log.error('Custom Package Content Error', e);
        }
    }

    // -------------------------------
    // HELPERS
    // -------------------------------
    function getSOLocation(soId) {
        return search.lookupFields({
            type: search.Type.SALES_ORDER,
            id: soId,
            columns: ['location']
        }).location[0].value;
    }

    function getStageBins() {
        return {
            "9": 4859, // locationId → binId
            "15": 16692
        };
    }

    function getItemWeights(itemIds) {

        var map = {};
        var chunkSize = 50;

        itemIds = [...new Set(itemIds)];

        for (var i = 0; i < itemIds.length; i += chunkSize) {

            var chunk = itemIds.slice(i, i + chunkSize);

            var s = search.create({
                type: search.Type.ITEM,
                filters: [["internalid", "anyof", chunk]],
                columns: ["weight"]
            });

            s.run().each(function (r) {
                map[r.id] = parseFloat(r.getValue("weight")) || 0;
                return true;
            });
        }

        return map;
    }

    function getItemInternalIds(items) {

        var map = {};
        var chunkSize = 50;

        items = [...new Set(items)];

        for (var i = 0; i < items.length; i += chunkSize) {

            var chunk = items.slice(i, i + chunkSize);
            var filters = [];

            chunk.forEach(function (item, index) {
                if (index > 0) filters.push('OR');
                filters.push(["itemid", "is", item]);
            });

            var s = search.create({
                type: search.Type.ITEM,
                filters: filters,
                columns: ["itemid"]
            });

            s.run().each(function (r) {
                map[r.getValue("itemid")] = r.id;
                return true;
            });
        }

        log.error('itemMap', map);
        return map;
    }


    function getBinData(binNames) {

        var map = {};
        var chunkSize = 50;

        binNames = [...new Set(binNames)];

        for (var i = 0; i < binNames.length; i += chunkSize) {

            var chunk = binNames.slice(i, i + chunkSize);
            var filters = [];

            chunk.forEach(function (bin, index) {
                if (index > 0) filters.push('OR');
                filters.push(["binnumber", "is", bin]);
            });

            var s = search.create({
                type: "bin",
                filters: filters,
                columns: ["binnumber", "location"]
            });

            s.run().each(function (r) {
                map[r.getValue("binnumber")] = {
                    id: r.id,
                    location: r.getValue("location")
                };
                return true;
            });
        }

        log.error('binMap', map);
        return map;
    }

    function getAvailableQty(itemId, binId) {

        if (!itemId || !binId) return 0;

        var totalAvailable = 0;

        var invSearch = search.create({
            type: "inventorybalance",
            filters: [
                ["item", "anyof", itemId],
                "AND",
                ["binnumber", "anyof", binId],
                "AND",
                ["onhand", "greaterthanorequalto", "0"],
                "AND",
                ["binnumber.inactive", "is", "F"],
                "AND",
                ["binnumber.custrecord_jyswms_exclude_from_inventory", "is", "F"]
            ],
            columns: [
                search.createColumn({ name: "available" }),
                search.createColumn({ name: "binnumber" }),
                search.createColumn({ name: "location" })
            ]
        });

        invSearch.run().each(function (result) {

            var available = parseFloat(result.getValue("available")) || 0;

            totalAvailable += available;

            return true;
        });

        return totalAvailable;
    }

    function createInventoryTransfer(itemId, qty, fromLoc, toLoc, fromBin, toBin) {
        log.error('createInventoryTransfer', itemId, qty, fromLoc, toLoc, fromBin, toBin);
        var rec = record.create({
            type: record.Type.INVENTORY_TRANSFER,
            isDynamic: true
        });

        rec.setValue({ fieldId: 'location', value: fromLoc });
        rec.setValue({ fieldId: 'transferlocation', value: toLoc });

        rec.selectNewLine({ sublistId: 'inventory' });

        rec.setCurrentSublistValue({ sublistId: 'inventory', fieldId: 'item', value: itemId });
        rec.setCurrentSublistValue({ sublistId: 'inventory', fieldId: 'adjustqtyby', value: qty });
        var invDet = rec.getCurrentSublistSubrecord({
            sublistId: 'inventory',
            fieldId: 'inventorydetail'
        });
        invDet.selectNewLine({ sublistId: 'inventoryassignment' });
        invDet.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'binnumber', value: fromBin });
        invDet.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'tobinnumber', value: toBin });
        invDet.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'quantity', value: qty });
        invDet.commitLine({ sublistId: 'inventoryassignment' });
        rec.commitLine({ sublistId: 'inventory' });

        return rec.save();
    }

    function createInventoryAdjustment(itemId, location, binId, qty) {
        log.error('createInventoryAdjustment', itemId, location, binId, qty);
        var rec = record.create({
            type: record.Type.INVENTORY_ADJUSTMENT,
            isDynamic: true
        });

        rec.setValue({ fieldId: 'account', value: ADJUSTMENT_ACCOUNT });
        rec.setValue({ fieldId: 'subsidiary', value: 1 });
        rec.setValue({ fieldId: 'adjlocation', value: location });

        rec.selectNewLine({ sublistId: 'inventory' });

        rec.setCurrentSublistValue({ sublistId: 'inventory', fieldId: 'item', value: itemId });
        rec.setCurrentSublistValue({ sublistId: 'inventory', fieldId: 'adjustqtyby', value: qty });
        var invDet = rec.getCurrentSublistSubrecord({
            sublistId: 'inventory',
            fieldId: 'inventorydetail'
        });
        invDet.selectNewLine({ sublistId: 'inventoryassignment' });
        invDet.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'binnumber', value: binId });
        invDet.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'quantity', value: qty });
        invDet.commitLine({ sublistId: 'inventoryassignment' });
        rec.commitLine({ sublistId: 'inventory' });

        return rec.save();
    }

    // -------------------------------
    // EXISTING FUNCTIONS (unchanged)
    // -------------------------------

    function extractPickedDetails(APIResponse) {
        var pickedMap = {};

        function processArray(arr) {
            if (!arr || !arr.length) return;

            arr.forEach(function (order) {
                if (!order.data || !order.data.length) return;

                order.data.forEach(function (item) {

                    if (item.is_picked !== 'picked') return;

                    var baseId = item.unique_id.split('_')[0];

                    if (!pickedMap[baseId]) {
                        pickedMap[baseId] = [];
                    }

                    var trackingList = item.tracking_data || [];

                    if (!trackingList.length) {
                        pickedMap[baseId].push({
                            item: item.item,
                            quantity: parseInt(item.quantity, 10) || 0,
                            bin: item.bin_number || '',
                            tracking: '',
                            sscc: ''
                        });
                    } else {
                        trackingList.forEach(function (track) {
                            pickedMap[baseId].push({
                                item: item.item,
                                quantity: parseInt(item.quantity, 10) || 0,
                                bin: item.bin_number || '',
                                tracking: track.trackingNumber || '',
                                sscc: track.SSCC || ''
                            });
                        });
                    }
                });
            });
        }

        processArray(APIResponse.completed);
        processArray(APIResponse.notcompleted);

        return pickedMap;
    }

    function filterPickedMap(pickedMap) {
        var allTrackingNumbers = [];

        Object.keys(pickedMap).forEach(function (key) {
            pickedMap[key].forEach(function (line) {
                if (line.tracking) {
                    allTrackingNumbers.push(line.tracking);
                }
            });
        });

        allTrackingNumbers = [...new Set(allTrackingNumbers)];

        var existingTrackingMap = getExistingTrackingNumbersFromIF(allTrackingNumbers);

        Object.keys(pickedMap).forEach(function (key) {
            pickedMap[key] = pickedMap[key].filter(function (line) {
                return line.tracking && !existingTrackingMap[line.tracking];
            });

            if (!pickedMap[key].length) {
                delete pickedMap[key];
            }
        });

        return pickedMap;
    }

    function getExistingTrackingNumbersFromIF(trackingNumbers) {

        var existingMap = {};
        var chunkSize = 50;

        for (var i = 0; i < trackingNumbers.length; i += chunkSize) {

            var chunk = trackingNumbers.slice(i, i + chunkSize);

            var filters = [
                ["type", "anyof", "ItemShip"],
                "AND",
                ["mainline", "is", "T"],
                "AND"
            ];

            chunk.forEach(function (tracking, index) {
                if (index > 0) filters.push("OR");

                filters.push([
                    "custrecord_hj_packagecontents_sublist.custrecordhj_pkg_trackingnumber",
                    "is",
                    tracking
                ]);
            });

            var searchObj = search.create({
                type: "itemfulfillment",
                filters: filters,
                columns: [
                    search.createColumn({
                        name: "custrecordhj_pkg_trackingnumber",
                        join: "CUSTRECORD_HJ_PACKAGECONTENTS_SUBLIST"
                    })
                ]
            });

            searchObj.run().each(function (result) {

                var tracking = result.getValue({
                    name: "custrecordhj_pkg_trackingnumber",
                    join: "CUSTRECORD_HJ_PACKAGECONTENTS_SUBLIST"
                });

                if (tracking) {
                    existingMap[tracking] = true;
                }

                return true;
            });
        }

        log.error('Existing Tracking (IF)', existingMap);

        return existingMap;
    }

    function getSingleIFFlag(soId) {
        var lookup = search.lookupFields({
            type: search.Type.SALES_ORDER,
            id: soId,
            columns: ["custbody_wms_so_single_if"]
        });
        log.error('singleIF', lookup.custbody_wms_so_single_if === true || lookup.custbody_wms_so_single_if === 'T');
        return lookup.custbody_wms_so_single_if;
    }

    function getSOTotalQty(soId) {
        var lookup = search.lookupFields({
            type: search.Type.SALES_ORDER,
            id: soId,
            columns: ['custbody_so_total_qty']
        });

        return parseFloat(lookup.custbody_so_total_qty) || 0;
    }
    function getPickedTotalQty(pickedMap) {
        var total = 0;

        Object.keys(pickedMap).forEach(function (key) {
            pickedMap[key].forEach(function (line) {
                total += line.quantity || 0;
            });
        });

        return total;
    }

    function validateSingleIFFullPick(soId, pickedMap) {

        var soTotalQty = getSOTotalQty(soId);
        var pickedTotalQty = getPickedTotalQty(pickedMap);

        log.error('SO Total Qty', soTotalQty);
        log.error('Picked Total Qty', pickedTotalQty);

        if (pickedTotalQty < soTotalQty) {
            throw 'Single IF enforced: Not all items are picked. SO Total = '
            + soTotalQty + ', Picked = ' + pickedTotalQty;
        }
    }

    function callWMSAPI(soId) {
        var token = tokenModule.generateToken();
        return https.get({
            url: 'https://api.jyswms.com/dropship-sales-order-status-with-bins?sales_order_id=' + soId,
            headers: { 'Authorization': 'Bearer ' + token }
        });
    }

    return { onRequest: onRequest };
});