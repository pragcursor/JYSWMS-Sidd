/**
 * @NApiVersion 2.1
 * @NModuleScope Public
 */
define(['N/record', 'N/search', 'N/log'], function (record, search, log) {

    /* =====================================================
     * ENTRY POINT
     * ===================================================== */
    function markAsPicked(payload) {

        validatePayload(payload);

        var ctx = buildContext(payload);
        var headerRec;
        var newlyAddedLineIds = [];

        try {
            /* 1️⃣ Upsert Header + append new pick lines */
            headerRec = upsertHeader(ctx, newlyAddedLineIds);

            /* 2️⃣ Recalculate totals */
            recalcTotals(headerRec);

            /* 3️⃣ Decide IF creation */
            if (!canCreateItemFulfillment(headerRec)) {
                return {
                    status: 'PENDING',
                    headerId: headerRec.id,
                    message: 'Waiting for full pick (single IF customer)'
                };
            }

            /* 4️⃣ Create Item Fulfillment (MERGED ITEMS) */
            ctx.fulfillmentId = createItemFulfillment(ctx, headerRec);

            /* 5️⃣ Packages */
            createPackages(ctx);

            /* 6️⃣ Package Contents (ALWAYS) */
            createPackageContents(ctx);

            /* 7️⃣ Amazon (conditional) */
            if (shouldCreateAmazon(ctx)) {
                createAmazonRecords(ctx);
            }

            /* 8️⃣ Finalize header */
            finalizeHeader(headerRec, ctx.fulfillmentId);

            return {
                status: 'SUCCESS',
                headerId: headerRec.id,
                fulfillmentId: ctx.fulfillmentId
            };

        } catch (e) {

            log.error('markAsPicked failed', e);

            /* 🔁 ROLLBACK */
            if (headerRec && newlyAddedLineIds.length) {
                rollbackHeaderLines(headerRec.id, newlyAddedLineIds);
            }

            if (headerRec) {
                record.submitFields({
                    type: 'customrecord_order_fulfillment_details',
                    id: headerRec.id,
                    values: {
                        custrecord_jyswms_error: String(e)
                    }
                });
            }

            throw e;
        }
    }

    /* =====================================================
     * VALIDATION
     * ===================================================== */
    function validatePayload(p) {
        if (!p || !p.salesOrderId) throw 'salesOrderId required';
        if (!Array.isArray(p.items) || !p.items.length) throw 'items required';
        p.tracking = Array.isArray(p.tracking) ? p.tracking : [];
    }

    function buildContext(p) {
        return {
            salesOrderId: p.salesOrderId,
            locationId: p.locationId,
            shipVia: p.shipVia,
            customerId: p.customerId,
            items: p.items,
            tracking: p.tracking,
            fulfillmentId: null
        };
    }

    /* =====================================================
     * HEADER UPSERT + IDEMPOTENCY
     * ===================================================== */
    function upsertHeader(ctx, newLineIds) {

        var headerId = findHeader(ctx.salesOrderId);
        var rec;

        if (headerId) {
            rec = record.load({
                type: 'customrecord_order_fulfillment_details',
                id: headerId,
                isDynamic: true
            });
        } else {
            rec = record.create({
                type: 'customrecord_order_fulfillment_details',
                isDynamic: true
            });
            rec.setValue('custrecord_jyswms_sales_order_id', ctx.salesOrderId);
            rec.setValue('custrecord_jyswms_location_id', ctx.locationId);
            rec.setValue('custrecord_jyswms_order_ship_via', ctx.shipVia);
            rec.setValue('custrecord_jyswms_customer_frm_so', ctx.customerId);
        }

        var existingUniqueIds = getExistingUniqueIds(rec);

        ctx.items.forEach(function (l) {

            if (!l.uniqueId || existingUniqueIds[l.uniqueId]) {
                log.audit('Skipping duplicate pick', l.uniqueId);
                return;
            }

            rec.selectNewLine({ sublistId: 'recmachcustrecord_sales_order_header' });
            rec.setCurrentSublistValue({ fieldId: 'custrecord_jyswms_item', value: l.itemId });
            rec.setCurrentSublistValue({ fieldId: 'custrecord_jyswms_item_picked_qty', value: l.qty });
            rec.setCurrentSublistValue({ fieldId: 'custrecord_jyswms_item_picked_bin', value: l.binId });
            rec.setCurrentSublistValue({ fieldId: 'custrecord_jyswms_item_uniqueid', value: l.uniqueId });
            rec.commitLine({ sublistId: 'recmachcustrecord_sales_order_header' });

            newLineIds.push(l.uniqueId);
        });

        rec.save();
        return record.load({
            type: 'customrecord_order_fulfillment_details',
            id: rec.id,
            isDynamic: true
        });
    }

    function getExistingUniqueIds(headerRec) {
        var map = {};
        var count = headerRec.getLineCount({ sublistId: 'recmachcustrecord_sales_order_header' });
        for (var i = 0; i < count; i++) {
            var uid = headerRec.getSublistValue({
                sublistId: 'recmachcustrecord_sales_order_header',
                fieldId: 'custrecord_jyswms_item_uniqueid',
                line: i
            });
            if (uid) map[uid] = true;
        }
        return map;
    }

    /* =====================================================
     * TOTALS + IF RULE
     * ===================================================== */
    function recalcTotals(headerRec) {

        var picked = 0;
        var count = headerRec.getLineCount({ sublistId: 'recmachcustrecord_sales_order_header' });

        for (var i = 0; i < count; i++) {
            picked += Number(headerRec.getSublistValue({
                sublistId: 'recmachcustrecord_sales_order_header',
                fieldId: 'custrecord_jyswms_item_picked_qty',
                line: i
            })) || 0;
        }

        var soId = headerRec.getValue('custrecord_jyswms_sales_order_id');
        var soQty = Number(search.lookupFields({
            type: 'salesorder',
            id: soId,
            columns: ['custbody_so_total_qty']
        }).custbody_so_total_qty) || 0;

        headerRec.setValue('custrecord_jyswms_total_pick_qty', picked);
        headerRec.setValue('custrecord_jyswms_total_so_qty', soQty);
        headerRec.save();
    }

    function canCreateItemFulfillment(headerRec) {
        var singleIF = headerRec.getValue('custrecord_jywms_single_if_from_customer');
        if (!singleIF) return true;

        var picked = headerRec.getValue('custrecord_jyswms_total_pick_qty');
        var soQty = headerRec.getValue('custrecord_jyswms_total_so_qty');

        return picked >= soQty && soQty > 0;
    }

    /* =====================================================
     * ITEM FULFILLMENT (MERGED ITEMS)
     * ===================================================== */
    function createItemFulfillment(ctx, headerRec) {

        var itemMap = {};

        var lineCount = headerRec.getLineCount({ sublistId: 'recmachcustrecord_sales_order_header' });
        for (var i = 0; i < lineCount; i++) {

            var itemId = headerRec.getSublistValue({
                sublistId: 'recmachcustrecord_sales_order_header',
                fieldId: 'custrecord_jyswms_item',
                line: i
            });

            var qty = Number(headerRec.getSublistValue({
                sublistId: 'recmachcustrecord_sales_order_header',
                fieldId: 'custrecord_jyswms_item_picked_qty',
                line: i
            })) || 0;

            if (!itemMap[itemId]) {
                itemMap[itemId] = { qty: 0 };
            }
            itemMap[itemId].qty += qty;
        }

        var fulfill = record.transform({
            fromType: record.Type.SALES_ORDER,
            fromId: ctx.salesOrderId,
            toType: record.Type.ITEM_FULFILLMENT,
            isDynamic: true
        });

        fulfill.setValue({ fieldId: 'location', value: ctx.locationId });

        var ifCount = fulfill.getLineCount({ sublistId: 'item' });
        for (var j = 0; j < ifCount; j++) {
            fulfill.selectLine({ sublistId: 'item', line: j });

            var soItem = fulfill.getCurrentSublistValue({ fieldId: 'item' });
            if (!itemMap[soItem]) continue;

            fulfill.setCurrentSublistValue({ fieldId: 'itemreceive', value: true });
            fulfill.setCurrentSublistValue({ fieldId: 'quantity', value: itemMap[soItem].qty });

            fulfill.commitLine({ sublistId: 'item' });
        }

        fulfill.setValue({ fieldId: 'shipstatus', value: 'C' });
        return fulfill.save();
    }

    /* =====================================================
     * PACKAGES + CONTENTS
     * ===================================================== */
    function createPackages(ctx) {
        if (!ctx.tracking.length) return;

        var f = record.load({
            type: record.Type.ITEM_FULFILLMENT,
            id: ctx.fulfillmentId,
            isDynamic: true
        });

        clearSublist(f, 'package');

        ctx.tracking.forEach(function (t) {
            if (!t.trackingNumber) return;
            f.selectNewLine({ sublistId: 'package' });
            f.setCurrentSublistValue({ fieldId: 'packagetrackingnumber', value: t.trackingNumber });
            f.commitLine({ sublistId: 'package' });
        });

        f.save();
    }

    function createPackageContents(ctx) {
        var f = record.load({
            type: record.Type.ITEM_FULFILLMENT,
            id: ctx.fulfillmentId,
            isDynamic: true
        });

        clearSublist(f, 'recmachcustrecord_hj_packagecontents_sublist');

        ctx.tracking.forEach(function (t, i) {
            f.selectNewLine({ sublistId: 'recmachcustrecord_hj_packagecontents_sublist' });
            f.setCurrentSublistValue({ fieldId: 'custrecordhj_pkgbox', value: i + 1 });
            f.setCurrentSublistValue({ fieldId: 'custrecordhj_ucc', value: t.ssccCode || '' });
            f.commitLine({ sublistId: 'recmachcustrecord_hj_packagecontents_sublist' });
        });

        f.save();
    }

    function shouldCreateAmazon(ctx) {
        return (
            ctx.shipVia === 57733 ||
            ctx.shipVia === 59691 ||
            ctx.customerId === 1807 ||
            ctx.customerId === 476
        );
    }

    function createAmazonRecords(ctx) {
        // move your existing logic here
    }

    /* =====================================================
     * FINALIZE + ROLLBACK
     * ===================================================== */
    function finalizeHeader(headerRec, fulfillmentId) {
        record.submitFields({
            type: 'customrecord_order_fulfillment_details',
            id: headerRec.id,
            values: {
                custrecord_jyswms_rel_item_ful: fulfillmentId,
                custrecord_jyswms_error: ''
            }
        });
    }

    function rollbackHeaderLines(headerId, uniqueIds) {

        var rec = record.load({
            type: 'customrecord_order_fulfillment_details',
            id: headerId,
            isDynamic: true
        });

        for (var i = rec.getLineCount({ sublistId: 'recmachcustrecord_sales_order_header' }) - 1; i >= 0; i--) {
            var uid = rec.getSublistValue({
                sublistId: 'recmachcustrecord_sales_order_header',
                fieldId: 'custrecord_jyswms_item_uniqueid',
                line: i
            });
            if (uniqueIds.indexOf(uid) !== -1) {
                rec.removeLine({ sublistId: 'recmachcustrecord_sales_order_header', line: i });
            }
        }

        rec.save();
    }

    function findHeader(soId) {
        var res = search.create({
            type: 'customrecord_order_fulfillment_details',
            filters: [
                ['custrecord_jyswms_sales_order_id', 'anyof', soId],
                'AND',
                ['isinactive', 'is', 'F']
            ],
            columns: ['internalid']
        }).run().getRange({ start: 0, end: 1 });

        return res.length ? res[0].id : null;
    }

    function clearSublist(rec, sublistId) {
        for (var i = rec.getLineCount({ sublistId: sublistId }) - 1; i >= 0; i--) {
            rec.removeLine({ sublistId: sublistId, line: i });
        }
    }

    return {
        markAsPicked: markAsPicked
    };
});
