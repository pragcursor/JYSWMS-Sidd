/**
 * @NApiVersion 2.1
 * @NModuleScope Public
 */
define(['N/record', 'N/search', 'N/log'], function (record, search, log) {

    const HEADER_ITEM_SUBLIST = 'recmachcustrecord_sales_order_header';

    /* =====================================================
     * PUBLIC ENTRY
     * ===================================================== */
    function markAsPicked(data) {
        var headerRec;
        try {

            var validated = validatePayload(data);
            var ctx = buildContext(validated);

            headerRec = upsertHeader(ctx);

            createTrackingRecords(ctx, headerRec.id);

            recalcTotalsFromJSON(headerRec, ctx);

            if (!canCreateItemFulfillment(headerRec)) {
                return {
                    status: 'PENDING',
                    headerId: headerRec.id
                };
            }

            ctx.fulfillmentId = createItemFulfillment(ctx, headerRec);

            createIFPackages(ctx);
            createPackageContentRecords(ctx, headerRec.id);

            finalizeHeader(headerRec.id, ctx.fulfillmentId);

            return {
                status: 'SUCCESS',
                headerId: headerRec.id,
                fulfillmentId: ctx.fulfillmentId
            };

        } catch (e) {
            log.error('markAsPicked error', e);
            return {
                status: 'ERROR',
                headerId: headerRec ? headerRec.id : null,
                message: String(e)
            };
        }
    }

    /* =====================================================
     * VALIDATION + CONTEXT
     * ===================================================== */
    function validatePayload(rows) {
        if (!Array.isArray(rows) || !rows.length) {
            throw 'Payload must be array';
        }

        var so = rows[0].salesOrders && rows[0].salesOrders[0];
        if (!so || !so.salesOrderId) {
            throw 'Missing salesOrderId';
        }

        return {
            salesOrderId: so.salesOrderId,
            rows: rows
        };
    }

    function buildContext(v) {
        var totalPicked = 0;

        v.rows.forEach(function (r) {
            var qty = Number(r.picked_quantity || 0);
            if (qty > 0) totalPicked += qty;
        });

        return {
            salesOrderId: v.salesOrderId,
            rows: v.rows,
            locationId: resolveLocation(v.rows[0]),
            customerId: v.rows[0].customerId || null,
            shipVia: v.rows[0].shipVia || null,
            items: extractItems(v.rows),
            tracking: extractTracking(v.rows),
            totalPickedQty: totalPicked,
            fulfillmentId: null
        };
    }

    function resolveLocation(row) {
        if (row.locationId) return row.locationId;
        if (row.location === 'L60-Hardeeville_SC') return 15;
        return null;
    }

    // function extractItems(rows) {
    //     return rows.map(function (r) {
    //         var so = r.salesOrders && r.salesOrders[0];
    //         if (!so) return null;

    //         var qty = Number(r.picked_quantity || 0);
    //         if (!qty || qty <= 0) return null;

    //         if (!r.binInternalId) return null;

    //         return {
    //             itemId: so.itemInternalId,
    //             qty: qty,
    //             binId: r.binInternalId,
    //             uniqueId: so.unique_id
    //         };
    //     }).filter(Boolean);
    // }
    function extractItems(rows) {
        return rows.map(function (r) {

            var so = r.salesOrders && r.salesOrders[0];
            if (!so) return null;

            var qty = Number(r.picked_quantity || 0);
            if (!qty || qty <= 0) return null;

            var binId = resolveBinId(r);
            if (!binId) {
                log.error('Bin could not be resolved', r.bin);
                return null;
            }

            return {
                itemId: so.itemInternalId,
                qty: qty,
                binId: binId,
                uniqueId: so.unique_id
            };

        }).filter(Boolean);
    }


    function extractTracking(rows) {
        var out = [];
        rows.forEach(function (r) {
            (r.salesOrders || []).forEach(function (so) {
                (so.labelData || []).forEach(function (l) {
                    if (l.tracking_number || l.sscc_code) {
                        out.push({
                            ssccCode: l.sscc_code || '',
                            trackingNumber: l.tracking_number || ''
                        });
                    }
                });
            });
        });
        return out;
    }

    /* =====================================================
     * HEADER
     * ===================================================== */
    function upsertHeader(ctx) {
        var headerId = findHeader(ctx.salesOrderId);

        var rec = headerId
            ? record.load({ type: 'customrecord_order_fulfillment_details', id: headerId, isDynamic: true })
            : record.create({ type: 'customrecord_order_fulfillment_details', isDynamic: true });

        if (!headerId) {
            rec.setValue('custrecord_jyswms_sales_order_id', ctx.salesOrderId);
            rec.setValue('custrecord_jyswms_location_id', ctx.locationId);
            rec.setValue('custrecord_jyswms_customer_frm_so', ctx.customerId);
            rec.setValue('custrecord_jyswms_order_ship_via', ctx.shipVia);
        }

        var existing = getExistingUniqueIds(rec);

        ctx.items.forEach(function (i) {
            if (!i || existing[i.uniqueId]) return;

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
            rec.setCurrentSublistValue({
                sublistId: HEADER_ITEM_SUBLIST,
                fieldId: 'custrecord_jyswms_item_uniqueid',
                value: i.uniqueId
            });

            rec.commitLine({ sublistId: HEADER_ITEM_SUBLIST });
        });

        rec.save();
        return record.load({ type: rec.type, id: rec.id, isDynamic: true });
    }

    function getExistingUniqueIds(rec) {
        var map = {};
        var count = rec.getLineCount({ sublistId: HEADER_ITEM_SUBLIST });
        for (var i = 0; i < count; i++) {
            var uid = rec.getSublistValue({
                sublistId: HEADER_ITEM_SUBLIST,
                fieldId: 'custrecord_jyswms_item_uniqueid',
                line: i
            });
            if (uid) map[uid] = true;
        }
        return map;
    }

    function findHeader(soId) {
        var r = search.create({
            type: 'customrecord_order_fulfillment_details',
            filters: [
                ['custrecord_jyswms_sales_order_id', 'anyof', soId],
                'AND',
                ['isinactive', 'is', 'F'],
                'AND',
                ['custrecord_jywms_single_if_from_customer', 'is', 'T']
            ],
            columns: ['internalid']
        }).run().getRange({ start: 0, end: 1 });

        return r.length ? r[0].id : null;
    }

    /* =====================================================
     * TRACKING RECORDS
     * ===================================================== */
    function createTrackingRecords(ctx, headerId) {
        ctx.items.forEach(function (item) {
            ctx.tracking.forEach(function (t) {
                var rec = record.create({
                    type: 'customrecord_jyswms_sales_order_track',
                    isDynamic: true
                });

                rec.setValue('custrecord_jyswms_so_header', headerId);
                rec.setValue('custrecord_jyswms_track_so_id', ctx.salesOrderId);
                rec.setValue('custrecord_jyswms_track_item', item.itemId);
                rec.setValue('custrecord_jyswms_track_qty', 1);
                rec.setValue('custrecord_jyswms_track_number', t.ssccCode || '');
                rec.setValue('custrecord_jyswms_track_dropship', t.trackingNumber || '');
                rec.setValue('custrecord_jyswms_track_uniqueid', item.uniqueId);
                rec.setValue('custrecord_jyswms_so_package_desc', lookupItemName(item.itemId) + '/1');

                if (ctx.shipVia) {
                    rec.setValue('custrecord_jyswms_track_shipvia', ctx.shipVia);
                }

                rec.save();
            });
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

    /* =====================================================
     * TOTALS (JSON SOURCE OF TRUTH)
     * ===================================================== */
    function recalcTotalsFromJSON(headerRec, ctx) {

        var soQty = Number(search.lookupFields({
            type: 'salesorder',
            id: ctx.salesOrderId,
            columns: ['custbody_so_total_qty']
        }).custbody_so_total_qty) || 0;

        headerRec.setValue('custrecord_jyswms_total_pick_qty', ctx.totalPickedQty);
        headerRec.setValue('custrecord_jyswms_total_so_qty', soQty);
        headerRec.save();
    }

    function canCreateItemFulfillment(headerRec) {
        var singleIF = headerRec.getValue('custrecord_jywms_single_if_from_customer');
        if (singleIF) {
            return headerRec.getValue('custrecord_jyswms_total_pick_qty') >=
                headerRec.getValue('custrecord_jyswms_total_so_qty');
        }
        return headerRec.getValue('custrecord_jyswms_total_pick_qty') > 0;
    }

    /* =====================================================
     * ITEM FULFILLMENT
     * ===================================================== */
    function createItemFulfillment(ctx, headerRec) {

        var itemMap = {};

        var count = headerRec.getLineCount({ sublistId: HEADER_ITEM_SUBLIST });
        for (var i = 0; i < count; i++) {

            var itemId = headerRec.getSublistValue({
                sublistId: HEADER_ITEM_SUBLIST,
                fieldId: 'custrecord_jyswms_item',
                line: i
            });

            var qty = Number(headerRec.getSublistValue({
                sublistId: HEADER_ITEM_SUBLIST,
                fieldId: 'custrecord_jyswms_item_picked_qty',
                line: i
            })) || 0;

            var binId = headerRec.getSublistValue({
                sublistId: HEADER_ITEM_SUBLIST,
                fieldId: 'custrecord_jyswms_item_picked_bin',
                line: i
            });

            if (!itemMap[itemId]) {
                itemMap[itemId] = { total: 0, bins: {} };
            }

            itemMap[itemId].total += qty;
            itemMap[itemId].bins[binId] = (itemMap[itemId].bins[binId] || 0) + qty;
        }

        var fulfill = record.transform({
            fromType: record.Type.SALES_ORDER,
            fromId: ctx.salesOrderId,
            toType: record.Type.ITEM_FULFILLMENT,
            isDynamic: true
        });

        fulfill.setValue('location', ctx.locationId);

        var ifCount = fulfill.getLineCount({ sublistId: 'item' });

        for (var j = 0; j < ifCount; j++) {

            fulfill.selectLine({ sublistId: 'item', line: j });

            var soItemId = fulfill.getCurrentSublistValue({ sublistId: 'item', fieldId: 'item' });
            var data = itemMap[soItemId];

            if (!data) {
                fulfill.setCurrentSublistValue({ sublistId: 'item', fieldId: 'itemreceive', value: false });
                fulfill.commitLine({ sublistId: 'item' });
                continue;
            }

            fulfill.setCurrentSublistValue({ sublistId: 'item', fieldId: 'itemreceive', value: true });
            fulfill.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity', value: data.total });

            var inv = fulfill.getCurrentSublistSubrecord({
                sublistId: 'item',
                fieldId: 'inventorydetail'
            });

            Object.keys(data.bins).forEach(function (binId) {
                inv.selectNewLine({ sublistId: 'inventoryassignment' });
                inv.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'binnumber', value: binId });
                inv.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'quantity', value: data.bins[binId] });
                inv.commitLine({ sublistId: 'inventoryassignment' });
            });

            fulfill.commitLine({ sublistId: 'item' });
        }

        fulfill.setValue('shipstatus', 'C');

        return fulfill.save({ ignoreMandatoryFields: true });
    }

    /* =====================================================
     * PACKAGES
     * ===================================================== */
    // function createIFPackages(ctx) {
    //     if (!ctx.tracking.length) return;

    //     var f = record.load({
    //         type: record.Type.ITEM_FULFILLMENT,
    //         id: ctx.fulfillmentId,
    //         isDynamic: true
    //     });

    //     clearSublist(f, 'package');

    //     ctx.tracking.forEach(function (t) {
    //         f.selectNewLine({ sublistId: 'package' });
    //         f.setCurrentSublistValue({ sublistId: 'package', fieldId: 'packagetrackingnumber', value: t.trackingNumber });
    //         f.commitLine({ sublistId: 'package' });
    //     });

    //     f.save({ ignoreMandatoryFields: true });
    // }
    function createIFPackages(ctx) {

        if (!ctx.tracking.length) return;

        var f = record.load({
            type: record.Type.ITEM_FULFILLMENT,
            id: ctx.fulfillmentId,
            isDynamic: true
        });

        clearSublist(f, 'package');

        //  UE-style weight calculation
        var packageWeight = calculatePackageWeight(ctx);

        ctx.tracking.forEach(function (t) {

            if (!t.trackingNumber) return;

            f.selectNewLine({ sublistId: 'package' });

            // ✅ REQUIRED (UE used to set this)
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
        ctx.tracking.forEach(function (t, i) {
            var rec = record.create({ type: 'customrecordhj_tc_package_contents' });
            rec.setValue('custrecord_hj_packagecontents_sublist', ctx.fulfillmentId);
            rec.setValue('custrecordhj_pkgbox', i + 1);
            rec.setValue('custrecordhj_ucc', t.ssccCode || '');
            rec.setValue('custrecordhj_pkg_trackingnumber', t.trackingNumber || '');
            rec.setValue('custrecord_jyswms_createdfrom', true);
            rec.setValue('custrecord_jyswms_related_cif', headerId);
          
            rec.save({ ignoreMandatoryFields: true });
        });
    }

    /* =====================================================
     * FINALIZE
     * ===================================================== */
    function finalizeHeader(headerId, fulfillmentId) {
        record.submitFields({
            type: 'customrecord_order_fulfillment_details',
            id: headerId,
            values: {
                custrecord_jyswms_rel_item_ful: fulfillmentId,
                custrecord_jyswms_processing_lock: true,
                custrecord_jyswms_error: ''
            }
        });
    }

    function clearSublist(rec, sublistId) {
        for (var i = rec.getLineCount({ sublistId: sublistId }) - 1; i >= 0; i--) {
            rec.removeLine({ sublistId: sublistId, line: i });
        }
    }

    function resolveBinId(row) {
        if (row.binInternalId) return row.binInternalId;
        if (!row.bin) return null;

        var res = search.create({
            type: 'bin',
            filters: [['binnumber', 'is', row.bin]],
            columns: ['internalid']
        }).run().getRange({ start: 0, end: 1 });

        return res.length ? res[0].id : null;
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



    /* =====================================================
     * EXPORT
     * ===================================================== */
    return {
        markAsPicked: markAsPicked
    };
});
