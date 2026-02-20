/**
 * @NApiVersion 2.1
 * @NModuleScope Public
 */
define(['N/record', 'N/search', 'N/log'], function (record, search, log) {

    const HEADER_TYPE = 'customrecord_order_fulfillment_details';
    const HEADER_ITEM_SUBLIST = 'recmachcustrecord_sales_order_header';
    const TRACK_TYPE = 'customrecord_jyswms_sales_order_track';

    /* ===========================================================
       PUBLIC ENTRY
    ============================================================ */

    function markAsPicked(rows) {

        var headerRec;

        try {

            var validated = validatePayload(rows);
            var ctx = buildContext(validated);

            headerRec = upsertHeader(ctx);

            createTrackingRecords(ctx, headerRec.id);

            recalcTotals(headerRec, ctx);

            var singleIF = enforceSingleIF(headerRec);

            if (!canCreateItemFulfillment(headerRec, singleIF)) {
                return {
                    status: 'PENDING',
                    headerId: headerRec.id
                };
            }

            // ctx.fulfillmentId = createItemFulfillment(ctx);
            // 1️⃣ Create Bin Transfers if needed
            createBinTransfers(ctx);

            // 2️⃣ Validate bulk bin availability and adjust if needed
            handleBulkBinAdjustment(ctx, headerRec.id);

            // 3️⃣ Create Item Fulfillment
            ctx.fulfillmentId = createItemFulfillment(ctx);

            // 4️⃣ Post logic
            runPostFulfillmentLogic(ctx, headerRec.id);


            runPostFulfillmentLogic(ctx, headerRec.id);

            finalizeHeader(headerRec.id, ctx.fulfillmentId);

            return {
                status: 'SUCCESS',
                headerId: headerRec.id,
                fulfillmentId: ctx.fulfillmentId
            };

        } catch (e) {

            log.error('markAsPicked error', e);

            if (headerRec) {
                record.submitFields({
                    type: HEADER_TYPE,
                    id: headerRec.id,
                    values: {
                        custrecord_jyswms_error: String(e),
                        custrecord_jyswms_approved: false
                    }
                });
            }

            return {
                status: 'ERROR',
                message: String(e)
            };
        }
    }

    function createBinTransfers(ctx) {

        ctx.items.forEach(function (item) {

            // 🔥 If JSON already has bin transfer ID → skip creation
            if (item.existingBinTransferId) {
                item.binTransferId = item.existingBinTransferId;
                item.useBulkBin = true;
                return;
            }

            var binTransferRec = record.create({
                type: 'bintransfer',
                isDynamic: true
            });

            binTransferRec.setValue({ fieldId: 'subsidiary', value: 1 });
            binTransferRec.setValue({ fieldId: 'location', value: ctx.locationId });
            binTransferRec.setValue({ fieldId: 'memo', value: 'Auto Bin Transfer - Util' });

            // ✅ IMPORTANT
            binTransferRec.setValue({
                fieldId: 'custbody_realted_sales_order',
                value: ctx.salesOrderId
            });

            binTransferRec.selectNewLine({ sublistId: 'inventory' });

            binTransferRec.setCurrentSublistValue({
                sublistId: 'inventory',
                fieldId: 'item',
                value: item.itemId
            });

            binTransferRec.setCurrentSublistValue({
                sublistId: 'inventory',
                fieldId: 'quantity',
                value: item.qty
            });

            var invDetail = binTransferRec.getCurrentSublistSubrecord({
                sublistId: 'inventory',
                fieldId: 'inventorydetail'
            });

            invDetail.selectNewLine({ sublistId: 'inventoryassignment' });

            invDetail.setCurrentSublistValue({
                sublistId: 'inventoryassignment',
                fieldId: 'binnumber',
                value: item.binId
            });

            invDetail.setCurrentSublistValue({
                sublistId: 'inventoryassignment',
                fieldId: 'tobinnumber',
                value: item.bulkBinId
            });

            invDetail.setCurrentSublistValue({
                sublistId: 'inventoryassignment',
                fieldId: 'quantity',
                value: item.qty
            });

            invDetail.commitLine({ sublistId: 'inventoryassignment' });

            binTransferRec.commitLine({ sublistId: 'inventory' });

            item.binTransferId = binTransferRec.save();
            item.useBulkBin = true;
        });
    }


    function getItemAvailableQtyMapByLocation(locationId, itemIds) {

        var itemQtyMap = {};

        var filters = [
            ["binonhand.quantityonhand", "greaterthan", "0"],
            "AND",
            ["binonhand.location", "anyof", locationId],
            "AND",
            ["binonhand.binnumber", "anyof", "16692", "4859"]
        ];

        if (itemIds && itemIds.length) {
            filters.push("AND");
            filters.push(["internalid", "anyof"].concat(itemIds));
        }

        var searchObj = search.create({
            type: "item",
            filters: filters,
            columns: [
                "internalid",
                search.createColumn({
                    name: "quantityavailable",
                    join: "binOnHand"
                })
            ]
        });

        searchObj.run().each(function (result) {

            var id = result.getValue("internalid");
            var qty = parseFloat(result.getValue({
                name: "quantityavailable",
                join: "binOnHand"
            }) || 0);

            if (!itemQtyMap[id])
                itemQtyMap[id] = 0;

            itemQtyMap[id] += qty;

            return true;
        });

        return itemQtyMap;
    }

    function handleBulkBinAdjustment(ctx, headerId) {

        var itemIds = ctx.items.map(function (i) { return i.itemId; });

        var availableMap = getItemAvailableQtyMapByLocation(ctx.locationId, itemIds);

        var adjustmentObj = {};

        ctx.items.forEach(function (item) {

            var available = parseFloat(availableMap[item.itemId] || 0);

            if (available < item.qty) {
                adjustmentObj[item.itemId] = item.qty - available;
            }
        });

        if (!Object.keys(adjustmentObj).length)
            return;

        var adjId = createPositiveAdjustment(adjustmentObj, ctx.locationId);

        record.submitFields({
            type: record.Type.INVENTORY_ADJUSTMENT,
            id: adjId,
            values: {
                memo: 'Auto Positive Adjustment due to Bulk bin shortage. Header: ' + headerId
            }
        });

        record.submitFields({
            type: HEADER_TYPE,
            id: headerId,
            values: {
                custrecord_jyswms_inventory_adjustment: adjId
            }
        });
    }

    function createPositiveAdjustment(adjustmentObj, locationId) {

        var adjRec = record.create({
            type: record.Type.INVENTORY_ADJUSTMENT,
            isDynamic: true
        });

        adjRec.setValue('subsidiary', 1);
        adjRec.setValue('account', 464); // use correct account
        adjRec.setValue('adjlocation', locationId);

        for (var itemId in adjustmentObj) {

            adjRec.selectNewLine({ sublistId: 'inventory' });

            adjRec.setCurrentSublistValue({
                sublistId: 'inventory',
                fieldId: 'item',
                value: itemId
            });

            adjRec.setCurrentSublistValue({
                sublistId: 'inventory',
                fieldId: 'adjustqtyby',
                value: adjustmentObj[itemId]
            });

            adjRec.commitLine({ sublistId: 'inventory' });
        }

        return adjRec.save();
    }



    /* ===========================================================
       VALIDATION
    ============================================================ */



    function validatePayload(rows) {

        if (!Array.isArray(rows) || !rows.length)
            throw 'Payload must be array';

        var so = rows[0].salesOrders && rows[0].salesOrders[0];

        if (!so || !so.salesOrderId)
            throw 'Missing salesOrderId';

        return {
            salesOrderId: so.salesOrderId,
            rows: rows
        };
    }

    /* ===========================================================
       CONTEXT
    ============================================================ */

    function buildContext(v) {

        var locationId = resolveLocation(v.rows[0]);
        if (!locationId)
            throw 'Unable to resolve location';

        var totalPicked = 0;

        v.rows.forEach(function (r) {
            totalPicked += Number(r.picked_quantity || 0);
        });

        return {
            salesOrderId: v.salesOrderId,
            rows: v.rows,
            locationId: locationId,
            items: extractItems(v.rows, locationId),
            tracking: extractTracking(v.rows),
            totalPickedQty: totalPicked,
            fulfillmentId: null
        };
    }

    function resolveLocation(row) {

        if (row.locationId)
            return row.locationId;

        if (!row.location)
            return null;

        var result = search.create({
            type: search.Type.LOCATION,
            filters: [['name', 'is', row.location]],
            columns: ['internalid']
        }).run().getRange({ start: 0, end: 1 });

        return result.length ? result[0].id : null;
    }

    function resolveBinId(row, locationId) {

        if (row.binInternalId)
            return row.binInternalId;

        if (!row.bin)
            return null;

        var result = search.create({
            type: search.Type.BIN,
            filters: [
                ['binnumber', 'is', row.bin],
                'AND',
                ['location', 'anyof', locationId]
            ],
            columns: ['internalid']
        }).run().getRange({ start: 0, end: 1 });

        return result.length ? result[0].id : null;
    }

    function extractItems(rows, locationId) {

        return rows.map(function (r) {

            var so = r.salesOrders && r.salesOrders[0];
            if (!so) return null;

            var qty = Number(r.picked_quantity || 0);
            if (!qty || qty <= 0) return null;

            var binId = resolveBinId(r, locationId);

            var bulkStageBin = (locationId == 9) ? 4859 : 16692;

            return {
                itemId: so.itemInternalId,
                qty: qty,
                binId: binId,
                bulkBinId: bulkStageBin,
                uniqueId: so.unique_id,
                existingBinTransferId: so.bin_transfer_internal_id || null
            };

        }).filter(Boolean);
    }


    function extractTracking(rows) {

        var out = [];

        rows.forEach(function (r) {
            (r.salesOrders || []).forEach(function (so) {
                (so.labelData || []).forEach(function (l) {

                    if (!l.tracking_number && !l.sscc_code)
                        return;

                    out.push({
                        ssccCode: l.sscc_code || '',
                        trackingNumber: l.tracking_number || ''
                    });
                });
            });
        });

        return out;
    }

    /* ===========================================================
       HEADER
    ============================================================ */

    function upsertHeader(ctx) {

        var rec = record.create({
            type: HEADER_TYPE,
            isDynamic: true
        });

        rec.setValue('custrecord_jyswms_sales_order_id', ctx.salesOrderId);
        rec.setValue('custrecord_jyswms_location_id', ctx.locationId);

        ctx.items.forEach(function (i) {

            rec.selectNewLine({ sublistId: HEADER_ITEM_SUBLIST });

            rec.setCurrentSublistValue({
                sublistId: HEADER_ITEM_SUBLIST,
                fieldId: 'custrecord_jyswms_item',
                value: i.itemId
            });

            rec.setCurrentSublistValue({
                sublistId: HEADER_ITEM_SUBLIST,
                fieldId: 'custrecord_jyswms_item_picked_qty',
                value: i.qty
            });

            rec.setCurrentSublistValue({
                sublistId: HEADER_ITEM_SUBLIST,
                fieldId: 'custrecord_jyswms_item_picked_bin',
                value: i.binId
            });

            // ✅ UNIQUE ID
            rec.setCurrentSublistValue({
                sublistId: HEADER_ITEM_SUBLIST,
                fieldId: 'custrecord_jyswms_item_uniqueid',
                value: i.uniqueId || ''
            });

            // ✅ SALES ORDER #
            rec.setCurrentSublistValue({
                sublistId: HEADER_ITEM_SUBLIST,
                fieldId: 'custrecord_jyswms_sales_order',
                value: ctx.salesOrderId
            });

            // ✅ SO LINE LOCATION
            rec.setCurrentSublistValue({
                sublistId: HEADER_ITEM_SUBLIST,
                fieldId: 'custrecord_jyswms_item_so_line_loc',
                value: ctx.locationId
            });

            // ✅ TRACKING COUNT
            rec.setCurrentSublistValue({
                sublistId: HEADER_ITEM_SUBLIST,
                fieldId: 'custrecord_jyswms_item_tracking_numbers',
                value: ctx.tracking.length
            });

            rec.commitLine({ sublistId: HEADER_ITEM_SUBLIST });
        });


        var id = rec.save();

        return record.load({
            type: HEADER_TYPE,
            id: id,
            isDynamic: true
        });
    }

    /* ===========================================================
       APPROVAL
    ============================================================ */

    function recalcTotals(headerRec, ctx) {

        var soQty = Number(search.lookupFields({
            type: 'salesorder',
            id: ctx.salesOrderId,
            columns: ['custbody_so_total_qty']
        }).custbody_so_total_qty) || 0;

        headerRec.setValue('custrecord_jyswms_total_pick_qty', ctx.totalPickedQty);
        headerRec.setValue('custrecord_jyswms_total_so_qty', soQty);
        headerRec.setValue('custrecord_jyswms_approved', true);

        headerRec.save();
    }

    function enforceSingleIF(headerRec) {

        var singleIF = false;
        const salesorderSearchObj = search.create({
            type: "salesorder",
            filters:
                [
                    ["type", "anyof", "SalesOrd"],
                    "AND",
                    ["internalid", "anyof", headerRec.getValue('custrecord_jyswms_sales_order_id')],
                    "AND",
                    ["mainline", "is", "T"]
                ],
            columns:
                [
                    search.createColumn({ name: "internalid", label: "Internal ID" }),
                    search.createColumn({
                        name: "custentity_single_if",
                        join: "customer",
                        label: "Single IF"
                    })
                ]
        });

        salesorderSearchObj.run().each(function (result) {
            singleIF = result.getValue({ name: "custentity_single_if", join: "customer" });
            return true;
        });



        if (!singleIF) return false;

        var totalPicked = headerRec.getValue('custrecord_jyswms_total_pick_qty');
        var totalSO = headerRec.getValue('custrecord_jyswms_total_so_qty');

        if (totalPicked !== totalSO) {

            record.submitFields({
                type: HEADER_TYPE,
                id: headerRec.id,
                values: { custrecord_jyswms_approved: false }
            });

            return true;
        }

        return true;
    }

    function canCreateItemFulfillment(headerRec, singleIF) {

        var approved = headerRec.getValue('custrecord_jyswms_approved');

        if (!approved)
            return false;

        if (singleIF) {
            return headerRec.getValue('custrecord_jyswms_total_pick_qty') >=
                headerRec.getValue('custrecord_jyswms_total_so_qty');
        }

        return headerRec.getValue('custrecord_jyswms_total_pick_qty') > 0;
    }

    /* ===========================================================
       ITEM FULFILLMENT
    ============================================================ */

    function createItemFulfillment(ctx) {

        var fulfill = record.transform({
            fromType: record.Type.SALES_ORDER,
            fromId: ctx.salesOrderId,
            toType: record.Type.ITEM_FULFILLMENT,
            isDynamic: true
        });

        fulfill.setValue('location', ctx.locationId);

        var count = fulfill.getLineCount({ sublistId: 'item' });

        for (var i = 0; i < count; i++) {

            fulfill.selectLine({ sublistId: 'item', line: i });

            var itemId = fulfill.getCurrentSublistValue({
                sublistId: 'item',
                fieldId: 'item'
            });

            var match = ctx.items.find(function (x) {
                return Number(x.itemId) === Number(itemId);
            });

            if (!match) {

                fulfill.setCurrentSublistValue({
                    sublistId: 'item',
                    fieldId: 'itemreceive',
                    value: false
                });

                fulfill.commitLine({ sublistId: 'item' });
                continue;
            }

            fulfill.setCurrentSublistValue({
                sublistId: 'item',
                fieldId: 'itemreceive',
                value: true
            });

            fulfill.setCurrentSublistValue({
                sublistId: 'item',
                fieldId: 'quantity',
                value: match.qty
            });

            var inv = fulfill.getCurrentSublistSubrecord({
                sublistId: 'item',
                fieldId: 'inventorydetail'
            });

            inv.selectNewLine({ sublistId: 'inventoryassignment' });

            // inv.setCurrentSublistValue({
            //     sublistId: 'inventoryassignment',
            //     fieldId: 'binnumber',
            //     value: match.binId
            // });
            var binToUse = match.useBulkBin ? match.bulkBinId : match.binId;

            inv.setCurrentSublistValue({
                sublistId: 'inventoryassignment',
                fieldId: 'binnumber',
                value: binToUse
            });


            inv.setCurrentSublistValue({
                sublistId: 'inventoryassignment',
                fieldId: 'quantity',
                value: match.qty
            });

            inv.commitLine({ sublistId: 'inventoryassignment' });

            fulfill.commitLine({ sublistId: 'item' });
        }

        fulfill.setValue('shipstatus', 'C');

        return fulfill.save({ ignoreMandatoryFields: true });
    }

    /* ===========================================================
       POST LOGIC
    ============================================================ */

    // function runPostFulfillmentLogic(ctx, headerId) {

    //     createUPSPackages(ctx);
    //     createPackageContent(ctx, headerId);
    //     createAmazonRecords(ctx, headerId);
    // }

    function runPostFulfillmentLogic(ctx, headerId) {

        createIFPackages(ctx);
        createPackageContentRecords(ctx, headerId);
        createAmazonRecords(ctx, headerId);
    }


    function getItemWeight(itemId) {
        if (!itemId) return 0;

        var lookup = search.lookupFields({
            type: search.Type.ITEM,
            id: itemId,
            columns: ['weight']
        });

        var w = Number(lookup.weight);
        return isNaN(w) || w <= 0 ? 0 : w;
    }
    function calculatePackageWeight(ctx) {

        var totalWeight = 0;

        ctx.items.forEach(function (item) {

            var itemWeight = getItemWeight(item.itemId);
            var lineQty = Number(item.qty) || 0;

            if (itemWeight > 0 && lineQty > 0) {
                totalWeight += (itemWeight * lineQty);
            }
        });

        // 🔴 NetSuite REQUIRES non-zero
        if (!totalWeight || totalWeight <= 0) {
            totalWeight = 1;
        }

        return totalWeight;
    }



    // function createUPSPackages(ctx) {

    //     if (!ctx.tracking.length) return;

    //     var f = record.load({
    //         type: record.Type.ITEM_FULFILLMENT,
    //         id: ctx.fulfillmentId,
    //         isDynamic: true
    //     });

    //     ctx.tracking.forEach(function (t) {

    //         if (!t.trackingNumber) return;

    //         f.selectNewLine({ sublistId: 'package' });

    //         f.setCurrentSublistValue({
    //             sublistId: 'package',
    //             fieldId: 'packageweight',
    //             value: 1
    //         });

    //         f.setCurrentSublistValue({
    //             sublistId: 'package',
    //             fieldId: 'packagetrackingnumber',
    //             value: t.trackingNumber
    //         });

    //         f.commitLine({ sublistId: 'package' });
    //     });

    //     f.save({ ignoreMandatoryFields: true });
    // }

    // function createPackageContent(ctx, headerId) {

    //     ctx.tracking.forEach(function (t, i) {

    //         var rec = record.create({
    //             type: 'customrecordhj_tc_package_contents'
    //         });

    //         rec.setValue('custrecord_hj_packagecontents_sublist', ctx.fulfillmentId);
    //         rec.setValue('custrecordhj_pkgbox', i + 1);
    //         rec.setValue('custrecordhj_ucc', t.ssccCode);
    //         rec.setValue('custrecordhj_pkg_trackingnumber', t.trackingNumber);
    //         rec.setValue('custrecord_jyswms_related_cif', headerId);
    //         rec.setValue('custrecord_jyswms_createdfrom', true);

    //         rec.save({ ignoreMandatoryFields: true });
    //     });
    // }

    function clearSublist(rec, sublistId) {

        for (var i = rec.getLineCount({ sublistId: sublistId }) - 1; i >= 0; i--) {
            rec.removeLine({ sublistId: sublistId, line: i });
        }
    }

    function createIFPackages(ctx) {

        if (!ctx.tracking.length) return;

        var f = record.load({
            type: record.Type.ITEM_FULFILLMENT,
            id: ctx.fulfillmentId,
            isDynamic: true
        });

        clearSublist(f, 'package');

        var packageWeight = calculatePackageWeight(ctx);

        ctx.tracking.forEach(function (t) {

            if (!t.trackingNumber) return;

            f.selectNewLine({ sublistId: 'package' });

            f.setCurrentSublistValue({
                sublistId: 'package',
                fieldId: 'packageweight',
                value: packageWeight
            });

            f.setCurrentSublistValue({
                sublistId: 'package',
                fieldId: 'packagetrackingnumber',
                value: t.trackingNumber
            });

            f.commitLine({ sublistId: 'package' });
        });

        f.save();
    }
    function createPackageContentRecords(ctx, headerId) {

        // 🔥 Delete existing package content linked to this IF
        deleteExistingPackageContents(ctx.fulfillmentId);

        ctx.tracking.forEach(function (t, i) {

            var rec = record.create({
                type: 'customrecordhj_tc_package_contents'
            });

            rec.setValue('custrecord_hj_packagecontents_sublist', ctx.fulfillmentId);
            rec.setValue('custrecordhj_pkgbox', i + 1);
            rec.setValue('custrecordhj_ucc', t.ssccCode || '');
            rec.setValue('custrecordhj_pkg_trackingnumber', t.trackingNumber || '');
            rec.setValue('custrecord_jyswms_createdfrom', true);
            rec.setValue('custrecord_jyswms_related_cif', headerId);
            rec.setValue('custrecordhj_pkg_desc',
                ctx.items.map(function (it) {
                    return lookupItemName(it.itemId) + '/1';
                }).join(', ')
            );
            rec.save({ ignoreMandatoryFields: true });
        });
    }

    function deleteExistingPackageContents(fulfillmentId) {

        var searchObj = search.create({
            type: 'customrecordhj_tc_package_contents',
            filters: [
                ['custrecord_hj_packagecontents_sublist', 'anyof', fulfillmentId]
            ],
            columns: ['internalid']
        });

        searchObj.run().each(function (result) {
            record.delete({
                type: 'customrecordhj_tc_package_contents',
                id: result.id
            });
            return true;
        });
    }


    function lookupItemName(itemId) {
        var r = search.lookupFields({
            type: search.Type.ITEM,
            id: itemId,
            columns: ['itemid']
        });
        return r.itemid || '';
    }




    function createAmazonRecords(ctx, headerId) {

        if (!isAmazonCustomer(ctx.salesOrderId)) {
            log.debug('Skipping AMZCC – Not Amazon customer');
            return;
        }

        if (!ctx.tracking.length)
            return;

        var soRec = record.load({
            type: record.Type.SALES_ORDER,
            id: ctx.salesOrderId,
            isDynamic: true
        });

        var sublistId = 'recmachcustrecord_sales_order_id';

        ctx.tracking.forEach(function (t) {

            if (!t.ssccCode) {
                log.debug('Skipping AMZCC – Missing SSCC');
                return;
            }

            if (!ctx.items.length) {
                log.debug('Skipping AMZCC – No items');
                return;
            }

            soRec.selectNewLine({ sublistId: sublistId });

            soRec.setCurrentSublistValue({
                sublistId: sublistId,
                fieldId: 'custrecord_amzcc_code',
                value: t.ssccCode.slice(2)
            });

            soRec.setCurrentSublistValue({
                sublistId: sublistId,
                fieldId: 'custrecord_trackingnumber',
                value: t.trackingNumber || ''
            });

            soRec.setCurrentSublistValue({
                sublistId: sublistId,
                fieldId: 'custrecord_item_id',
                value: ctx.items[0].itemId
            });

            soRec.commitLine({ sublistId: sublistId });
        });

        soRec.save({ ignoreMandatoryFields: true });

        record.submitFields({
            type: HEADER_TYPE,
            id: headerId,
            values: {
                custrecord_jyswms_amzcc_updated: true
            }
        });
    }

    function isAmazonCustomer(salesOrderId) {

        var result = search.create({
            type: "salesorder",
            filters: [
                ["type", "anyof", "SalesOrd"],
                "AND",
                ["mainline", "is", "T"],
                "AND",
                ["internalidnumber", "equalto", salesOrderId]
            ],
            columns: [
                search.createColumn({ name: "entity" }),
                search.createColumn({ name: "shipmethod" })
            ]
        }).run().getRange({ start: 0, end: 1 });

        if (!result.length)
            return false;

        var customerText = result[0].getText({ name: "entity" }) || '';
        var shipMethodText = result[0].getText({ name: "shipmethod" }) || '';

        // Condition 1: Ship Method = P/U
        if (shipMethodText.trim().toUpperCase() === 'P/U') {
            return true;
        }

        // Condition 2: Customer name contains "Amazon"
        if (customerText.toUpperCase().indexOf('AMAZON') !== -1) {
            return true;
        }

        return false;
    }




    function finalizeHeader(headerId, fulfillmentId) {

        record.submitFields({
            type: HEADER_TYPE,
            id: headerId,
            values: {
                custrecord_jyswms_rel_item_ful: fulfillmentId,
                custrecord_jyswms_processing_lock: true,
                custrecord_jyswms_error: ''
            }
        });
    }
    /* ===========================================================
       TRACKING RECORDS
    =========================================================== */

    function createTrackingRecords(ctx, headerId) {

        if (!ctx.tracking || !ctx.tracking.length)
            return;

        ctx.tracking.forEach(function (t) {

            ctx.items.forEach(function (item) {

                var rec = record.create({
                    type: TRACK_TYPE,
                    isDynamic: true
                });

                rec.setValue('custrecord_jyswms_so_header', headerId);
                rec.setValue('custrecord_jyswms_track_so_id', ctx.salesOrderId);
                rec.setValue('custrecord_jyswms_track_item', item.itemId);
                rec.setValue('custrecord_jyswms_track_qty', 1);
                rec.setValue('custrecord_jyswms_track_number', t.ssccCode || '');
                rec.setValue('custrecord_jyswms_track_dropship', t.trackingNumber || '');
                rec.setValue('custrecord_jyswms_track_uniqueid', item.uniqueId || '');

                rec.save({ ignoreMandatoryFields: true });
            });
        });
    }

    return {
        markAsPicked: markAsPicked
    };

});
