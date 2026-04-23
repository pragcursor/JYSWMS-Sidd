/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 */
define([
    'N/ui/serverWidget',
    'N/record',
    'N/https',
    'N/log',
    'N/search',
    '../JYSWMS_generateToken_API.js'
], function (ui, record, https, log, search, tokenModule) {

    function onRequest(context) {

        var soId = context.request.parameters.custpage_soid;
        var form = ui.createForm({ title: 'WMS Fulfillment Result' });

        try {

            if (!soId) throw 'Sales Order Internal ID required.';

            /* ===============================
               🔒 LOCK
            =============================== */
            var soRec = record.load({
                type: record.Type.SALES_ORDER,
                id: soId,
                isDynamic: true
            });

            // if (soRec.getValue('custbody_wms_fulfillment_lock')) {
            //     throw 'Fulfillment already running.';
            // }

            // record.submitFields({
            //     type: record.Type.SALES_ORDER,
            //     id: soId,
            //     values: { custbody_wms_fulfillment_lock: true }
            // });

            /* ===============================
                BUSINESS RULES
            =============================== */
            var orderStatus = soRec.getValue('status');
            var customer = soRec.getValue('entity');

            if (orderStatus === 'Billed') throw 'SO already billed.';
            if (customer == 476 || customer == 1807) throw 'Amazon blocked.';

            /* ===============================
               📡 WMS
            =============================== */
            var wmsLines = callWmsApi(soId);

            var pickMapByLine = buildPickMapByLine(wmsLines);
            var pickMapByItem = buildPickMapByItem(wmsLines);

            /* ===============================
               🔁 TRACKING IDEMPOTENCY
            =============================== */
            var allTracking = extractTrackingNumbers(wmsLines);
            var existingTracking = getExistingTrackingNumbers(allTracking);

            pickMapByLine = filterTrackingFromMap(pickMapByLine, existingTracking);
            pickMapByItem = filterTrackingFromMap(pickMapByItem, existingTracking);

            if (!Object.keys(pickMapByLine).length && !Object.keys(pickMapByItem).length) {
                throw 'No picked lines.';
            }

            /* ===============================
               🧭 SINGLE IF LOGIC (UNCHANGED)
            =============================== */
            var singleIf = soRec.getValue('custbody_wms_so_single_if');
            var headerLocationId = soRec.getValue('location');

            if (singleIf) {

                var notPicked = wmsLines.filter(function (l) {
                    return l.is_picked !== 'picked';
                });

                if (notPicked.length) {
                    throw 'Single IF requires all picked.';
                }
            }

            /* ===============================
               🔄 INVENTORY TRANSFER (UNCHANGED)
            =============================== */
            var lineCountSO = soRec.getLineCount({ sublistId: 'item' });

            for (var i = 0; i < lineCountSO; i++) {

                soRec.selectLine({ sublistId: 'item', line: i });

                var itemId = soRec.getCurrentSublistValue({ sublistId: 'item', fieldId: 'item' });
                var loc = soRec.getCurrentSublistValue({ sublistId: 'item', fieldId: 'location' });

                if (singleIf && loc != headerLocationId) {

                    var qty = soRec.getCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity' });

                    var stageFrom = getStageBinByLocation(loc);
                    var stageTo = getStageBinByLocation(headerLocationId);

                    if (getInventoryByItemAndBin(itemId, stageFrom, qty, loc)) {
                        createInventoryTransfer(itemId, qty, loc, headerLocationId, stageFrom, stageTo, soId);
                    }
                }
            }

            /* ===============================
               🔁 TRANSFORM
            =============================== */
            var fulfillment = record.transform({
                fromType: record.Type.SALES_ORDER,
                fromId: soId,
                toType: record.Type.ITEM_FULFILLMENT,
                isDynamic: true
            });

            fulfillment.setValue({ fieldId: 'shipstatus', value: 'C' });

            var lineCount = fulfillment.getLineCount({ sublistId: 'item' });

            var hasLines = false;
            var packageIndexMap = {};
            var allTrackingArray = [];

            for (var i = 0; i < lineCount; i++) {

                fulfillment.selectLine({ sublistId: 'item', line: i });

                var itemId = fulfillment.getCurrentSublistValue({ sublistId: 'item', fieldId: 'item' });
                var itemName = getItemNameById(itemId) || itemId;

                var remainingQty = Number(
                    fulfillment.getCurrentSublistValue({
                        sublistId: 'item',
                        fieldId: 'quantityremaining'
                    })
                ) || 0;

                var uniqueId = fulfillment.getCurrentSublistValue({
                    sublistId: 'item',
                    fieldId: 'custcol_wms_unique_id'
                });

                // var stageBinId = getStageBinByLocation(
                //     fulfillment.getCurrentSublistValue({
                //         sublistId: 'item',
                //         fieldId: 'location'
                //     })
                // );

                var lineLocation = fulfillment.getCurrentSublistValue({
                    sublistId: 'item',
                    fieldId: 'location'
                });

                var effectiveLocation = singleIf ? headerLocationId : lineLocation;
                var stageBinId = getStageBinByLocation(effectiveLocation);

                if (!getInventoryByItemAndBin(itemId, stageBinId, remainingQty)) {
                    throw 'Inventory missing for ' + itemName;
                }

                var qtyToFulfill = 0;
                var trackingList = [];

                /* ===============================
                   🎯 UNIQUE LINE MATCH
                =============================== */
                if (uniqueId && pickMapByLine[uniqueId]) {

                    var data = pickMapByLine[uniqueId];

                    qtyToFulfill = Math.min(data.qty, remainingQty);
                    trackingList = data.tracking;

                    delete pickMapByLine[uniqueId];
                }

                /* ===============================
                   🔁 FALLBACK
                =============================== */
                else if (pickMapByItem[itemName]) {

                    var data = pickMapByItem[itemName];

                    qtyToFulfill = Math.min(data.qty, remainingQty);
                    trackingList = data.tracking.splice(0, qtyToFulfill);

                    data.qty -= qtyToFulfill;

                    if (data.qty <= 0) delete pickMapByItem[itemName];
                }

                if (qtyToFulfill <= 0) {

                    fulfillment.setCurrentSublistValue({
                        sublistId: 'item',
                        fieldId: 'itemreceive',
                        value: false
                    });

                    fulfillment.commitLine({ sublistId: 'item' });
                    continue;
                }

                hasLines = true;

                fulfillment.setCurrentSublistValue({
                    sublistId: 'item',
                    fieldId: 'itemreceive',
                    value: true
                });

                fulfillment.setCurrentSublistValue({
                    sublistId: 'item',
                    fieldId: 'quantity',
                    value: qtyToFulfill
                });

                assignInventoryDetail(fulfillment, qtyToFulfill, stageBinId);

                fulfillment.commitLine({ sublistId: 'item' });

                trackingList.forEach(function (t) {

                    if (!t.trackingNumber) return;

                    if (!packageIndexMap[t.trackingNumber]) {

                        fulfillment.selectNewLine({ sublistId: 'package' });

                        fulfillment.setCurrentSublistValue({
                            sublistId: 'package',
                            fieldId: 'packagetrackingnumber',
                            value: t.trackingNumber
                        });

                        fulfillment.setCurrentSublistValue({
                            sublistId: 'package',
                            fieldId: 'packageweight',
                            value: getItemWeight(itemId) || 1
                        });

                        fulfillment.commitLine({ sublistId: 'package' });

                        packageIndexMap[t.trackingNumber] = true;
                    }

                    allTrackingArray.push({
                        trackingNumber: t.trackingNumber,
                        SSCC: t.SSCC,
                        itemName: itemName
                    });
                });
            }

            if (!hasLines) throw 'No valid lines to fulfill.';

            var fulfillmentId = fulfillment.save({
                enableSourcing: true,
                ignoreMandatoryFields: true
            });

            createCustomPackageContents(fulfillmentId, allTrackingArray);

            /* ===============================
               🔓 UNLOCK
            =============================== */
            record.submitFields({
                type: record.Type.SALES_ORDER,
                id: soId,
                values: { custbody_wms_fulfillment_lock: false }
            });

            form.addField({
                id: 'custpage_success',
                type: ui.FieldType.INLINEHTML,
                label: ' '
            }).defaultValue =
                '<h3 style="color:green">Fulfillment Created</h3><p>ID: ' + fulfillmentId + '</p>';

        } catch (e) {

            log.error('ERROR', e);

            try {
                record.submitFields({
                    type: record.Type.SALES_ORDER,
                    id: soId,
                    values: { custbody_wms_fulfillment_lock: false }
                });
            } catch (err) { }

            form.addField({
                id: 'custpage_error',
                type: ui.FieldType.INLINEHTML,
                label: ' '
            }).defaultValue =
                '<h3 style="color:red">Error</h3><p>' + e + '</p>';
        }

        context.response.writePage(form);
    }

    /* ===============================
       🔧 ALL ORIGINAL HELPERS KEPT
    =============================== */

    // (ALL your original helper functions go here EXACTLY as-is:
    // createInventoryTransfer, getInventoryByItemAndBin,
    // createPositiveAdjustment, getStageBinByLocation,
    // getItemWeight, createCustomPackageContents,
    // extractTrackingNumbers, getExistingTrackingNumbers, etc.)

    function assignInventoryDetail(fulfillment, qty, stageBinId) {

        if (!stageBinId) return;

        try {

            var invDetail = fulfillment.getCurrentSublistSubrecord({
                sublistId: 'item',
                fieldId: 'inventorydetail'
            });

            var assignmentCount = invDetail.getLineCount({
                sublistId: 'inventoryassignment'
            });

            // REMOVE existing lines first
            for (var i = assignmentCount - 1; i >= 0; i--) {
                invDetail.removeLine({
                    sublistId: 'inventoryassignment',
                    line: i,
                    ignoreRecalc: true
                });
            }

            // ADD correct assignment
            invDetail.selectNewLine({
                sublistId: 'inventoryassignment'
            });

            invDetail.setCurrentSublistValue({
                sublistId: 'inventoryassignment',
                fieldId: 'binnumber',
                value: stageBinId
            });

            invDetail.setCurrentSublistValue({
                sublistId: 'inventoryassignment',
                fieldId: 'quantity',
                value: qty
            });

            invDetail.commitLine({
                sublistId: 'inventoryassignment'
            });

        } catch (e) {
            log.error('Inventory Detail Error', e);
            throw e;
        }
    }

    function getExistingTrackingNumbers(trackingNumbers) {

        var existingTracking = {};

        try {

            if (!trackingNumbers || !trackingNumbers.length) {
                return existingTracking;
            }

            var filters = [
                ["type", "anyof", "ItemShip"],
                "AND",
                ["mainline", "is", "T"],
                "AND"
            ];

            var trackingFilter = [];

            trackingNumbers.forEach(function (num, index) {

                if (index > 0) {
                    trackingFilter.push("OR");
                }

                trackingFilter.push([
                    "shipmentpackage.trackingnumber",
                    "is",
                    num
                ]);

            });

            filters = filters.concat(trackingFilter);

            var fulfillmentSearch = search.create({
                type: "itemfulfillment",
                filters: filters,
                columns: [
                    search.createColumn({
                        name: "trackingnumber",
                        join: "shipmentpackage"
                    })
                ]
            });

            fulfillmentSearch.run().each(function (result) {

                var tracking = result.getValue({
                    name: "trackingnumber",
                    join: "shipmentpackage"
                });

                if (tracking) {
                    existingTracking[String(tracking)] = true;
                }

                return true;
            });

        } catch (e) {

            log.error('Error Fetching Existing Tracking Numbers', e);

        }

        return existingTracking;
    }

    function extractTrackingNumbers(wmsLines) {
        try {



            var trackingNumbers = [];

            wmsLines.forEach(function (line) {

                if (line.tracking_data && line.tracking_data.length) {

                    line.tracking_data.forEach(function (track) {

                        if (track.trackingNumber) {
                            trackingNumbers.push(track.trackingNumber);
                        }

                    });

                }

            });

            return trackingNumbers;
        } catch (error) {
            log.error('Error Extracting Tracking Numbers', error);
        }
    }

    function createCustomPackageContents(fulfillmentId, trackingArray) {

        try {

            var fulfillmentRec = record.load({
                type: record.Type.ITEM_FULFILLMENT,
                id: fulfillmentId,
                isDynamic: true
            });

            var customerId = fulfillmentRec.getValue({ fieldId: 'entity' });

            var isLowesCustomer = false;

            // Replace these with your actual Lowe's customer IDs
            var LOWES_CUSTOMERS = [1952, 639];

            if (LOWES_CUSTOMERS.indexOf(Number(customerId)) !== -1) {
                isLowesCustomer = true;
            }

            var sublistId = 'recmachcustrecord_hj_packagecontents_sublist';

            var existingCount = fulfillmentRec.getLineCount({ sublistId: sublistId });

            for (var i = existingCount - 1; i >= 0; i--) {
                fulfillmentRec.removeLine({
                    sublistId: sublistId,
                    line: i,
                    ignoreRecalc: true
                });
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
                    sublistId: sublistId,
                    fieldId: 'custrecordhj_pkgbox',
                    value: packageBoxNumber
                });

                fulfillmentRec.setCurrentSublistValue({
                    sublistId: sublistId,
                    fieldId: 'custrecordhj_pkg_trackingnumber',
                    value: line.trackingNumber
                });

                if (line.SSCC) {
                    fulfillmentRec.setCurrentSublistValue({
                        sublistId: sublistId,
                        fieldId: 'custrecordhj_ucc',
                        value: line.SSCC
                    });
                }

                if (isLowesCustomer && line.SSCC) {

                    fulfillmentRec.setCurrentSublistValue({
                        sublistId: sublistId,
                        fieldId: 'custrecordhj_ucc',
                        value: line.SSCC
                    });

                }

                fulfillmentRec.setCurrentSublistValue({
                    sublistId: sublistId,
                    fieldId: 'custrecordhj_pkg_desc',
                    value: line.itemName + '/1'
                });

                fulfillmentRec.setCurrentSublistValue({
                    sublistId: sublistId,
                    fieldId: 'custrecord_jyswms_createdfrom',
                    value: true
                });

                // fulfillmentRec.setCurrentSublistValue({
                //     sublistId: sublistId,
                //     fieldId: 'custrecordhj_tc_packagecontentslbs',
                //     value: getItemWeight(line.itemName) || 1
                // });
                fulfillmentRec.setCurrentSublistValue({
                    sublistId: sublistId,
                    fieldId: 'custrecord_jyswms_item_not_populated',
                    value: true
                });

                fulfillmentRec.setCurrentSublistValue({
                    sublistId: sublistId,
                    fieldId: 'custrecord_jyswms_fulfillment_link',
                    value: true
                });
                fulfillmentRec.setCurrentSublistValue({
                    sublistId: sublistId,
                    fieldId: 'custrecord_jyswms_createdfrom',
                    value: true
                });

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

    function getItemWeight(itemId) {
        try {
            var itemData = search.lookupFields({
                type: search.Type.INVENTORY_ITEM,
                id: itemId,
                columns: ['weight']
            });
            return Number(itemData.weight) || 0;
        } catch (e) {
            return 0;
        }
    }

    function getItemNameById(itemId) {
        try {
            var itemRecord = search.lookupFields({
                type: search.Type.INVENTORY_ITEM,
                id: itemId,
                columns: ['itemid']
            });
            return itemRecord.itemid || null;
        } catch (error) {
            log.error('Item Lookup Failed', 'ID: ' + itemId + ' - ' + error);
            return null;
        }
    }

    function getStageBinByLocation(locationId) {
        var binId = (locationId == 9) ? 4859 : 16692;
        return binId;
    }

    function createPositiveAdjustment(adjustmentObj, locationId, binId) {

        try {

            var adjRec = record.create({
                type: record.Type.INVENTORY_ADJUSTMENT,
                isDynamic: true
            });

            adjRec.setValue({ fieldId: 'subsidiary', value: 1 });
            adjRec.setValue({ fieldId: 'memo', value: 'Inventory Adj for Fulfillment' });
            adjRec.setValue({ fieldId: 'account', value: 464 }); // adjustment account
            adjRec.setValue({ fieldId: 'adjlocation', value: locationId });

            log.debug('Adjustment Object', adjustmentObj);
            log.debug('Location ID', locationId);
            log.debug('Bin ID', binId);

            for (var itemId in adjustmentObj) {

                var qty = adjustmentObj[itemId];

                adjRec.selectNewLine({ sublistId: 'inventory' });

                adjRec.setCurrentSublistValue({
                    sublistId: 'inventory',
                    fieldId: 'item',
                    value: itemId
                });

                adjRec.setCurrentSublistValue({
                    sublistId: 'inventory',
                    fieldId: 'location',
                    value: locationId
                });

                adjRec.setCurrentSublistValue({
                    sublistId: 'inventory',
                    fieldId: 'adjustqtyby',
                    value: qty
                });

                // Inventory Detail (for Bin / Lot / Serial)
                var inventoryDetail = adjRec.getCurrentSublistSubrecord({
                    sublistId: 'inventory',
                    fieldId: 'inventorydetail'
                });

                inventoryDetail.selectNewLine({
                    sublistId: 'inventoryassignment'
                });

                inventoryDetail.setCurrentSublistValue({
                    sublistId: 'inventoryassignment',
                    fieldId: 'binnumber',
                    value: binId
                });

                inventoryDetail.setCurrentSublistValue({
                    sublistId: 'inventoryassignment',
                    fieldId: 'quantity',
                    value: qty
                });

                inventoryDetail.commitLine({
                    sublistId: 'inventoryassignment'
                });

                adjRec.commitLine({ sublistId: 'inventory' });

            }

            var recId = adjRec.save({
                enableSourcing: true,
                ignoreMandatoryFields: true
            });

            log.debug('Inventory Adjustment Created', recId);

            return recId;

        } catch (e) {
            log.error('Error Creating Inventory Adjustment', e);
        }
    }

    function getInventoryByItemAndBin(itemId, binId, quantity, locationId) {
        log.error('Getting Inventory by Item and Bin', {
            itemId: itemId,
            binId: binId,
            quantity: quantity,
            locationId: locationId
        });
        var invExists = false;
        var inventorybalanceSearchObj = search.create({
            type: "inventorybalance",
            filters:
                [
                    ["item", "anyof", itemId],
                    "AND",
                    ["binnumber", "anyof", binId],
                    "AND",
                    ["onhand", "greaterthan", quantity]
                ],
            columns:
                [
                    search.createColumn({ name: "onhand", label: "On Hand" }),
                    search.createColumn({ name: "available", label: "Available" }),
                    search.createColumn({ name: "binnumber", label: "Bin Number" }),
                    search.createColumn({ name: "location", label: "Location" }),
                    search.createColumn({
                        name: "internalid",
                        join: "binNumber",
                        label: "Internal ID"
                    })
                ]
        });
        var invExists = false;
        const searchResultCount = inventorybalanceSearchObj.runPaged().count;
        log.debug("inventorybalanceSearchObj result count", searchResultCount);
        inventorybalanceSearchObj.run().each(function (result) {
            // .run().each has a limit of 4,000 results
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

    function createInventoryTransfer(itemId, quantity, fromLocation, toLocation, fromBin, toBin, soId) {
        try {

            log.error('Creating Inventory Transfer', {
                itemId: itemId,
                quantity: quantity,
                fromLocation: fromLocation,
                toLocation: toLocation,
                fromBin: fromBin,
                toBin: toBin,
                soId: soId
            });

            var invTransferRec = record.create({
                type: record.Type.INVENTORY_TRANSFER,
                isDynamic: true
            });

            // Header fields
            invTransferRec.setValue({
                fieldId: 'location',
                value: fromLocation
            });

            invTransferRec.setValue({
                fieldId: 'transferlocation',
                value: toLocation
            });

            invTransferRec.setValue({
                fieldId: 'memo',
                value: 'Inventory Transfer for Fulfillment - SO: ' + soId
            });
            // Add item line
            invTransferRec.selectNewLine({
                sublistId: 'inventory'
            });

            invTransferRec.setCurrentSublistValue({
                sublistId: 'inventory',
                fieldId: 'item',
                value: itemId
            });

            invTransferRec.setCurrentSublistValue({
                sublistId: 'inventory',
                fieldId: 'adjustqtyby',
                value: quantity
            });

            // Inventory Detail (Bin Transfer)
            var invDetail = invTransferRec.getCurrentSublistSubrecord({
                sublistId: 'inventory',
                fieldId: 'inventorydetail'
            });

            invDetail.selectNewLine({
                sublistId: 'inventoryassignment'
            });

            invDetail.setCurrentSublistValue({
                sublistId: 'inventoryassignment',
                fieldId: 'binnumber',
                value: fromBin
            });

            invDetail.setCurrentSublistValue({
                sublistId: 'inventoryassignment',
                fieldId: 'tobinnumber',
                value: toBin
            });

            invDetail.setCurrentSublistValue({
                sublistId: 'inventoryassignment',
                fieldId: 'quantity',
                value: quantity
            });

            invDetail.commitLine({
                sublistId: 'inventoryassignment'
            });

            invTransferRec.commitLine({
                sublistId: 'inventory'
            });

            var transferId = invTransferRec.save({
                enableSourcing: true,
                ignoreMandatoryFields: true
            });

            log.debug('Inventory Transfer Created', transferId);

            return transferId;

        } catch (e) {
            log.error('Inventory Transfer Error', e);
        }
    }

    // + ONLY ADDITIONS BELOW

    function buildPickMapByLine(lines) {
        var map = {};
        lines.forEach(function (l) {
            if (l.is_picked !== 'picked') return;
            var qty = Number(l.quantity) || 0;
            if (qty <= 0) return;
            map[l.unique_id] = {
                qty: qty,
                tracking: l.tracking_data || []
            };
        });
        return map;
    }

    function filterTrackingFromMap(map, existing) {
        Object.keys(map).forEach(function (k) {
            var filtered = map[k].tracking.filter(function (t) {
                return !existing[t.trackingNumber];
            });
            map[k].tracking = filtered;
            map[k].qty = filtered.length;
            if (map[k].qty <= 0) delete map[k];
        });
        return map;
    }

    function callWmsApi(soId) {

        var token = tokenModule.generateToken();

        var response = https.get({
            url: 'https://api.jyswms.com/dropship-sales-order-status?sales_order_id=' + soId,
            headers: {
                'Authorization': 'Bearer ' + token,
                'Content-Type': 'application/json'
            }
        });

        if (response.code !== 200) {
            throw 'WMS API returned ' + response.code;
        }

        var body = JSON.parse(response.body || '{}');
        var sourceArray = body.completed?.length
            ? body.completed
            : body.notcompleted;

        return sourceArray[0].data || [];
    }

    function buildPickMapByItem(wmsLines) {

        var map = {};

        wmsLines.forEach(function (line) {

            if (!line.item || line.is_picked !== 'picked') return;

            var itemName = line.item;
            var qty = Number(line.quantity) || 0;

            if (!map[itemName]) {
                map[itemName] = {
                    qty: 0,
                    tracking: []
                };
            }

            map[itemName].qty += qty;

            // Ensure tracking aligns with quantity
            if (line.tracking_data && line.tracking_data.length) {

                line.tracking_data.forEach(function (track) {
                    map[itemName].tracking.push({
                        trackingNumber: track.trackingNumber || '',
                        SSCC: track.SSCC || ''
                    });
                });
            }
        });

        return map;
    }

    return { onRequest: onRequest };
});