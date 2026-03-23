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

            /* ================= WMS ================= */
            var wmsLines = callWmsApi(soId);

            var pickMap = buildPickMapByLine(wmsLines);

            var allTracking = extractTrackingNumbers(wmsLines);
            var existingTracking = getExistingTrackingNumbers(allTracking);

            pickMap = filterPickedTracking(pickMap, existingTracking);

            if (!Object.keys(pickMap).length) {
                throw 'No valid picked lines after filtering existing tracking.';
            }

            /* ================= LOAD SO ================= */
            var soRec = record.load({
                type: record.Type.SALES_ORDER,
                id: soId,
                isDynamic: true
            });

            var orderStatus = soRec.getValue({ fieldId: 'status' });
            var customer = soRec.getValue({ fieldId: 'entity' });

            var exclude_status = ["billed", "closed", "cancelled"];

            if (exclude_status.includes(String(orderStatus).toLowerCase())) {
                throw 'Sales Order status is ' + orderStatus + '.';
            }


            if (customer == 476 || customer == 1807) {
                throw 'Amazon orders blocked.';
            }

            var headerLocation = soRec.getValue({ fieldId: 'location' });
            var singleIf = soRec.getValue({ fieldId: 'custbody_wms_so_single_if' });

            /* ================= SINGLE IF ================= */

            if (singleIf) {

                var soLineCount = soRec.getLineCount({ sublistId: 'item' });

                var soRemainingMap = {};
                var itemNameFallbackMap = {};

                // Step 1: Build SO remaining qty map
                for (var i = 0; i < soLineCount; i++) {

                    var lineKey = soRec.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'lineuniquekey',
                        line: i
                    });

                    var itemId = soRec.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'item',
                        line: i
                    });

                    var itemName = getItemNameById(itemId);

                    var remainingQty = Number(
                        soRec.getSublistValue({
                            sublistId: 'item',
                            fieldId: 'quantityremaining',
                            line: i
                        })
                    ) || 0;

                    if (remainingQty <= 0) continue;

                    soRemainingMap[lineKey] = remainingQty;

                    // fallback mapping
                    itemNameFallbackMap[itemName] = remainingQty;
                }

                // Step 2: Build picked qty map from WMS
                var pickedMap = {};

                wmsLines.forEach(function (line) {

                    if (line.is_picked !== 'picked') return;

                    var key = normalizeWmsKey(line.unique_id);
                    var qty = Number(line.quantity) || 0;

                    pickedMap[key] = (pickedMap[key] || 0) + qty;
                });

                // Step 3: Compare SO vs picked
                var hasUnpicked = Object.keys(soRemainingMap).some(function (lineKey) {

                    var required = soRemainingMap[lineKey];
                    var picked = pickedMap[lineKey];

                    // fallback to item name ONLY if no key match
                    if (picked === undefined) {

                        var itemName = null;

                        // get item name again
                        var lineIndex = soRec.findSublistLineWithValue({
                            sublistId: 'item',
                            fieldId: 'lineuniquekey',
                            value: lineKey
                        });

                        if (lineIndex !== -1) {
                            var itemId = soRec.getSublistValue({
                                sublistId: 'item',
                                fieldId: 'item',
                                line: lineIndex
                            });

                            itemName = getItemNameById(itemId);
                        }

                        picked = itemNameFallbackMap[itemName] || 0;
                    }

                    return picked < required;
                });

                if (hasUnpicked) {
                    throw 'Single IF requires full NetSuite remaining quantity picked.';
                }
            }

            /* ================= INVENTORY TRANSFER ================= */

            var lineCount = soRec.getLineCount({ sublistId: 'item' });

            for (var i = 0; i < lineCount; i++) {

                soRec.selectLine({ sublistId: 'item', line: i });

                var itemId = soRec.getCurrentSublistValue({ sublistId: 'item', fieldId: 'item' });
                var locationId = soRec.getCurrentSublistValue({ sublistId: 'item', fieldId: 'location' });
                var qty = soRec.getCurrentSublistValue({ sublistId: 'item', fieldId: 'quantityremaining' });

                if (singleIf && locationId != headerLocation) {

                    var fromBin = getStageBinByLocation(locationId);
                    var toBin = getStageBinByLocation(headerLocation);

                    var exists = getInventoryByItemAndBin(itemId, fromBin, qty, locationId);

                    if (exists) {
                        createInventoryTransfer(itemId, qty, locationId, headerLocation, fromBin, toBin, soId);
                    }
                }
            }

            /* ================= TRANSFORM ================= */

            var fulfillment = record.transform({
                fromType: record.Type.SALES_ORDER,
                fromId: soId,
                toType: record.Type.ITEM_FULFILLMENT,
                isDynamic: true
            });

            fulfillment.setValue({ fieldId: 'shipstatus', value: 'C' });

            var itemCount = fulfillment.getLineCount({ sublistId: 'item' });
            var hasLines = false;

            var packageIndexMap = {};
            var allTrackingArray = [];

            /* ================= LOOP ================= */

            for (var i = 0; i < itemCount; i++) {

                fulfillment.selectLine({ sublistId: 'item', line: i });

                var lineKey = fulfillment.getCurrentSublistValue({
                    sublistId: 'item',
                    fieldId: 'lineuniquekey'
                });

                var itemId = fulfillment.getCurrentSublistValue({
                    sublistId: 'item',
                    fieldId: 'item'
                });

                var itemName = getItemNameById(itemId);

                var remainingQty = Number(
                    fulfillment.getCurrentSublistValue({
                        sublistId: 'item',
                        fieldId: 'quantityremaining'
                    })
                ) || 0;

                var locationId = fulfillment.getCurrentSublistValue({
                    sublistId: 'item',
                    fieldId: 'location'
                });

                if (singleIf && locationId != headerLocation) {
                    fulfillment.setCurrentSublistValue({
                        sublistId: 'item',
                        fieldId: 'location',
                        value: headerLocation
                    });
                    locationId = headerLocation;
                }

                var stageBin = getStageBinByLocation(locationId);

                var invExists = getInventoryByItemAndBin(itemId, stageBin, remainingQty, locationId);

                if (!invExists) {
                    throw 'No inventory for item ' + itemName;
                }

                /* ================= MATCH ================= */

                var normalizedKey = normalizeWmsKey(lineKey);
                var pickData = pickMap[normalizedKey];

                if (!pickData) {
                    pickData = Object.values(pickMap).find(function (p) {
                        return p.item === itemName;
                    });
                }

                if (!pickData) {
                    fulfillment.setCurrentSublistValue({
                        sublistId: 'item',
                        fieldId: 'itemreceive',
                        value: false
                    });
                    fulfillment.commitLine({ sublistId: 'item' });
                    continue;
                }

                var qtyToFulfill = Math.min(pickData.qty, remainingQty);

                if (qtyToFulfill <= 0) {
                    fulfillment.commitLine({ sublistId: 'item' });
                    continue;
                }

                var trackingList = pickData.tracking
                    .filter(t => t.trackingNumber)
                    .slice(0, qtyToFulfill);

                if (trackingList.length !== qtyToFulfill) {
                    log.error('Tracking mismatch', { itemName, qtyToFulfill, trackingList });
                }

                hasLines = true;

                var weight = getItemWeight(itemId);

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

                assignInventoryDetail(fulfillment, qtyToFulfill, stageBin);

                fulfillment.commitLine({ sublistId: 'item' });

                trackingList.forEach(function (t) {

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
                            value: weight || 1
                        });

                        fulfillment.commitLine({ sublistId: 'package' });

                        packageIndexMap[t.trackingNumber] = true;
                    }

                    // allTrackingArray.push({
                    //     trackingNumber: t.trackingNumber,
                    //     itemName: itemName,
                    //     SSCC: t.SSCC
                    // });

                    allTrackingArray.push({
                        trackingNumber: t.trackingNumber,
                        itemName: itemName,
                        itemId: itemId, // REQUIRED
                        SSCC: t.SSCC,
                        qty: 1
                    });
                });

                pickData.qty -= qtyToFulfill;

                if (pickData.qty <= 0) {
                    delete pickMap[normalizedKey];
                }
            }

            if (!hasLines) throw 'No lines fulfilled';

            var fulfillmentId = fulfillment.save({
                enableSourcing: true,
                ignoreMandatoryFields: true
            });

            /* ================= PACKAGE CONTENT ================= */

            var pkgMap = {};

            allTrackingArray.forEach(function (t) {

                var key = t.trackingNumber + '|' + t.itemName;

                if (!pkgMap[key]) {
                    pkgMap[key] = {
                        trackingNumber: t.trackingNumber,
                        itemName: t.itemName,
                        qty: 0,
                        SSCC: t.SSCC
                    };
                }

                pkgMap[key].qty++;
            });

            createCustomPackageContents(fulfillmentId, Object.values(pkgMap));

            form.addField({
                id: 'custpage_success',
                type: ui.FieldType.INLINEHTML,
                label: ' '
            }).defaultValue = '<h3>Fulfillment Created: ' + fulfillmentId + '</h3>';

        } catch (e) {

            log.error('ERROR', e);

            form.addField({
                id: 'custpage_error',
                type: ui.FieldType.INLINEHTML,
                label: ' '
            }).defaultValue = '<h3 style="color:red">' + e + '</h3>';
        }

        context.response.writePage(form);
    }

    /* ================= NORMALIZE ================= */

    function normalizeWmsKey(rawKey) {
        if (!rawKey) return null;
        var noDash = rawKey.split('-')[0];
        var parts = noDash.split('_');
        return parts.length >= 2 ? parts[0] + '_' + parts[1] : noDash;
    }

    // creating custom packages
    function createCustomPackageContents(fulfillmentId, trackingArray) {

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

            // 🔥 NEW: item weight cache
            var itemWeightCache = {};

            trackingArray.forEach(function (line) {

                if (!line.trackingNumber) return;
                if (seenTracking[line.trackingNumber]) return;

                seenTracking[line.trackingNumber] = true;
                packageBoxNumber++;

                /* ================= GET ITEM WEIGHT ================= */

                var itemWeight = 1;

                if (line.itemId) {

                    if (!itemWeightCache[line.itemId]) {
                        itemWeightCache[line.itemId] = getItemWeight(line.itemId);
                    }

                    itemWeight = itemWeightCache[line.itemId] || 1;
                }

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

                /* ================= DESCRIPTION ================= */

                fulfillmentRec.setCurrentSublistValue({
                    sublistId: sublistId,
                    fieldId: 'custrecordhj_pkg_desc',
                    value: line.itemName + '/' + (line.qty || 1)
                });

                // Replace this fieldId with your actual custom field if different
                fulfillmentRec.setCurrentSublistValue({
                    sublistId: sublistId,
                    fieldId: 'custrecordhj_tc_packagecontentslbs',
                    value: itemWeight
                });

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

    /* ================= PICK MAP ================= */

    function buildPickMapByLine(lines) {

        var map = {};

        lines.forEach(function (l) {

            if (l.is_picked !== 'picked') return;

            var key = normalizeWmsKey(l.unique_id);
            var qty = Number(l.quantity) || 0;

            if (!map[key]) {
                map[key] = { item: l.item, qty: 0, tracking: [] };
            }

            map[key].qty += qty;

            (l.tracking_data || []).forEach(function (t) {
                if (t.trackingNumber) {
                    map[key].tracking.push({
                        trackingNumber: t.trackingNumber,
                        SSCC: t.SSCC || ''
                    });
                }
            });
        });

        return map;
    }

    /* ================= INVENTORY ================= */

    function getInventoryByItemAndBin(itemId, binId, qty, loc) {

        var found = false;

        var s = search.create({
            type: "inventorybalance",
            filters: [
                ["item", "anyof", itemId],
                "AND",
                ["binnumber", "anyof", binId],
                "AND",
                ["onhand", "greaterthanorequalto", qty]
            ]
        });

        s.run().each(function () {
            found = true;
            return false;
        });

        if (!found) {
            createPositiveAdjustment({ [itemId]: qty }, loc, binId);
            found = true;
        }

        return found;
    }

    function createPositiveAdjustment(obj, loc, bin) {

        var rec = record.create({ type: record.Type.INVENTORY_ADJUSTMENT, isDynamic: true });

        rec.setValue({ fieldId: 'subsidiary', value: 1 });
        rec.setValue({ fieldId: 'account', value: 464 });
        rec.setValue({ fieldId: 'adjlocation', value: loc });

        for (var item in obj) {

            rec.selectNewLine({ sublistId: 'inventory' });

            rec.setCurrentSublistValue({ sublistId: 'inventory', fieldId: 'item', value: item });
            rec.setCurrentSublistValue({ sublistId: 'inventory', fieldId: 'adjustqtyby', value: obj[item] });

            var inv = rec.getCurrentSublistSubrecord({
                sublistId: 'inventory',
                fieldId: 'inventorydetail'
            });

            inv.selectNewLine({ sublistId: 'inventoryassignment' });

            inv.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'binnumber', value: bin });
            inv.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'quantity', value: obj[item] });

            inv.commitLine({ sublistId: 'inventoryassignment' });

            rec.commitLine({ sublistId: 'inventory' });
        }

        rec.save();
    }

    function createInventoryTransfer(itemId, qty, fromLoc, toLoc, fromBin, toBin, soId) {

        var rec = record.create({ type: record.Type.INVENTORY_TRANSFER, isDynamic: true });

        rec.setValue({ fieldId: 'location', value: fromLoc });
        rec.setValue({ fieldId: 'transferlocation', value: toLoc });

        rec.selectNewLine({ sublistId: 'inventory' });

        rec.setCurrentSublistValue({ sublistId: 'inventory', fieldId: 'item', value: itemId });
        rec.setCurrentSublistValue({ sublistId: 'inventory', fieldId: 'adjustqtyby', value: qty });

        var inv = rec.getCurrentSublistSubrecord({
            sublistId: 'inventory',
            fieldId: 'inventorydetail'
        });

        inv.selectNewLine({ sublistId: 'inventoryassignment' });

        inv.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'binnumber', value: fromBin });
        inv.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'tobinnumber', value: toBin });
        inv.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'quantity', value: qty });

        inv.commitLine({ sublistId: 'inventoryassignment' });

        rec.commitLine({ sublistId: 'inventory' });

        rec.save();
    }

    /* ================= HELPERS ================= */

    function getStageBinByLocation(loc) {
        if (Number(loc) === 15) return 16692;
        if (Number(loc) === 9) return 4859;
        return null;
    }

    function assignInventoryDetail(rec, qty, bin) {

        var inv = rec.getCurrentSublistSubrecord({
            sublistId: 'item',
            fieldId: 'inventorydetail'
        });

        var count = inv.getLineCount({ sublistId: 'inventoryassignment' });

        for (var i = count - 1; i >= 0; i--) {
            inv.removeLine({ sublistId: 'inventoryassignment', line: i, ignoreRecalc: true });
        }

        inv.selectNewLine({ sublistId: 'inventoryassignment' });

        inv.setCurrentSublistValue({
            sublistId: 'inventoryassignment',
            fieldId: 'binnumber',
            value: bin
        });

        inv.setCurrentSublistValue({
            sublistId: 'inventoryassignment',
            fieldId: 'quantity',
            value: qty
        });

        inv.commitLine({ sublistId: 'inventoryassignment' });
    }

    function getItemWeight(id) {
        var r = search.lookupFields({
            type: search.Type.INVENTORY_ITEM,
            id: id,
            columns: ['weight']
        });
        return Number(r.weight) || 1;
    }

    function getItemNameById(id) {
        var r = search.lookupFields({
            type: search.Type.INVENTORY_ITEM,
            id: id,
            columns: ['itemid']
        });
        return r.itemid;
    }

    function extractTrackingNumbers(lines) {
        var arr = [];
        lines.forEach(l => (l.tracking_data || []).forEach(t => t.trackingNumber && arr.push(t.trackingNumber)));
        return arr;
    }

    function getExistingTrackingNumbers(trackingNumbers) {

        var map = {};

        if (!trackingNumbers.length) return map;

        var filters = [
            ["type", "anyof", "ItemShip"],
            "AND",
            ["mainline", "is", "T"],
            "AND"
        ];

        var trackingFilter = [];

        trackingNumbers.forEach(function (num, i) {
            if (i > 0) trackingFilter.push("OR");
            trackingFilter.push(["shipmentpackage.trackingnumber", "is", num]);
        });

        filters = filters.concat(trackingFilter);

        var s = search.create({
            type: "itemfulfillment",
            filters: filters,
            columns: ["shipmentpackage.trackingnumber"]
        });

        s.run().each(function (r) {
            var t = r.getValue({ name: "trackingnumber", join: "shipmentpackage" });
            if (t) map[t] = true;
            return true;
        });

        return map;
    }

    function filterPickedTracking(map, existing) {

        Object.keys(map).forEach(function (k) {

            var d = map[k];

            d.tracking = d.tracking.filter(t => !existing[t.trackingNumber]);

            d.qty = d.tracking.length;

            if (d.qty <= 0) delete map[k];
        });

        return map;
    }

    function callWmsApi(soId) {

        var token = tokenModule.generateToken();

        var res = https.get({
            url: 'https://api.jyswms.com/dropship-sales-order-status?sales_order_id=' + soId,
            headers: { Authorization: 'Bearer ' + token }
        });

        var body = JSON.parse(res.body || '{}');

        var src = body.completed?.length ? body.completed : body.notcompleted;

        return src[0]?.data || [];
    }

    return { onRequest: onRequest };
});