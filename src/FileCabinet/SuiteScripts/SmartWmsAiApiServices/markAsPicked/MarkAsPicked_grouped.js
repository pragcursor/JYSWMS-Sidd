/**
 * @NApiVersion 2.1
 * @NModuleScope Public
 */
define(['N/record', 'N/search', 'N/log'], function (record, search, log) {


    function markAsPicked_Group(requestBody, jyswmsApiCustRecId) {

        // ─── CONSTANTS ────────────────────────────────────────────────────────────
        var PICKUP_SHIP_METHOD_ID = '57733';
        var ALWAYS_BIN_TRANSFER_CUSTS = ['476', '1807'];
        var INV_ADJ_ACCOUNT = 464;
        var SUBSIDIARY = 1;

        // ─── RESULT COLLECTORS ───────────────────────────────────────────────────
        var savedTransfers = [];
        var savedHeaders = [];
        var itemLines = [];
        var trackingLines = [];
        var packageLines = [];

        // ─── TOP-LEVEL GUARD ─────────────────────────────────────────────────────
        if (!requestBody || !Array.isArray(requestBody.data)) {
            return { status: 'error', message: 'Invalid request body: data array is required' };
        }

        var topLevelHeaderId = null; // kept for catch-block error stamping

        try {

            // ─── PRE-FETCH: bin map (one call for entire batch) ──────────────────
            var binMap = getBinNameToIdMap();
            var existingMap = {};  // salesOrderId → headerId

            var portalId = requestBody.portalId || requestBody.portalid;
            var pickerName = requestBody.userName || requestBody.username || requestBody.pickerName;

            // ─── MAIN LOOP ───────────────────────────────────────────────────────
            for (var d = 0; d < requestBody.data.length; d++) {
                var dataItem = requestBody.data[d];
                var salesOrders = dataItem.salesOrders || [];
                if (!salesOrders.length) continue;

                for (var s = 0; s < salesOrders.length; s++) {
                    var so = salesOrders[s];
                    var salesOrderId = so.salesOrderId;
                    if (!salesOrderId) continue;

                    // ── 1. Stamp API tracking record (fire-and-forget) ──────────
                    if (jyswmsApiCustRecId) {
                        try {
                            record.submitFields({
                                type: 'customrecord_wms_ai_api_custom_rec',
                                id: jyswmsApiCustRecId,
                                values: { custrecord_jyswms_related_tran_record: salesOrderId },
                                options: { enableSourcing: false, ignoreMandatoryFields: true }
                            });
                        } catch (e) {
                            log.error('stampApiRecord', e.message);
                        }
                    }

                    // ── 2. Extract payload fields ────────────────────────────────
                    var itemId = so.itemInternalId || dataItem.itemInternalId || dataItem.item || '';
                    if (!itemId) continue;

                    var pickQty = extractPickQty(so, dataItem);
                    var binNumber = dataItem.bin;
                    var binId = binMap[binNumber] || '';
                    var uniqueId = so.unique_id || '';
                    var isClose = isTruthyFlag(dataItem.isClose) || isTruthyFlag(dataItem.is_close) || isTruthyFlag(so.is_close);
                    var locationId = resolveLocationId(dataItem, binId);

                    // ── 3. Handle isClose – close SO line and skip pick flow ─────
                    if (isClose) {
                        closeSalesOrderItem(salesOrderId, itemId, uniqueId);
                        continue;
                    }

                    if (!locationId) continue;  // can't proceed without a location

                    var bulkStageBin = (locationId === 9) ? 4859 : 16692;

                    // ── 4. Build tracking number pairs ───────────────────────────
                    var trackingNumbers = buildTrackingPairs(so);

                    // ── 5. Fetch existing header + SO metadata in ONE search each ─
                    if (!existingMap.hasOwnProperty(salesOrderId)) {
                        existingMap[salesOrderId] = fetchExistingHeaderId(salesOrderId);
                    }

                    var soMeta = fetchSOMeta(salesOrderId);  // { isSingleIf, shipMethodId, customerId }
                    var isSingleIf = soMeta.isSingleIf;

                    // ── 6. Load or create fulfillment header ─────────────────────
                    var headerId = existingMap[salesOrderId];
                    topLevelHeaderId = headerId; // for error stamping

                    if (headerId && isSingleIf) {
                        // Reuse existing header only when Single IF is checked
                    } else {
                        // Always create a new header when Single IF is off
                        var newHeader = record.create({ type: 'customrecord_order_fulfillment_details', isDynamic: true });
                        newHeader.setValue('custrecord_jyswms_sales_order_id', salesOrderId);
                        newHeader.setValue('custrecord_jyswms_portal_id', portalId);
                        newHeader.setValue('custrecord_jyswms_location_id', locationId);
                        headerId = newHeader.save();
                        existingMap[salesOrderId] = headerId;
                        topLevelHeaderId = headerId;
                    }

                    savedHeaders.push(headerId);

                    // ── 7. Conditionally create bin transfer ─────────────────────
                    var shouldTransfer = String(soMeta.shipMethodId) === PICKUP_SHIP_METHOD_ID
                        || ALWAYS_BIN_TRANSFER_CUSTS.indexOf(String(soMeta.customerId)) !== -1;

                    var savedBinTransferId = so.bin_transfer_internal_id || '';

                    if (!savedBinTransferId && shouldTransfer) {
                        savedBinTransferId = createBinTransfer({
                            locationId: locationId,
                            uniqueId: uniqueId,
                            pickerName: pickerName,
                            salesOrderId: salesOrderId,
                            itemId: itemId,
                            pickQty: pickQty,
                            binId: binId,
                            bulkStageBin: bulkStageBin
                        });
                    } else if (!shouldTransfer) {
                        log.debug('BIN TRANSFER SKIPPED', {
                            salesOrderId: salesOrderId,
                            customerId: soMeta.customerId,
                            shipMethodId: soMeta.shipMethodId
                        });
                    }

                    if (savedBinTransferId) savedTransfers.push(savedBinTransferId);

                    // ── 8. Auto-approve header when NOT Single IF ────────────────
                    var headerUpdateValues = { custrecord_jyswms_location_id: locationId };

                    if (!isSingleIf) {
                        headerUpdateValues.custrecord_jyswms_is_partially_fulfilled = true;
                        headerUpdateValues.custrecord_jyswms_approved = true;
                        headerUpdateValues.custrecord_jywms_perform_update = true;
                    }

                    try {
                        record.submitFields({
                            type: 'customrecord_order_fulfillment_details',
                            id: headerId,
                            values: headerUpdateValues,
                            options: { enableSourcing: false, ignoreMandatoryFields: true }
                        });
                    } catch (e) {
                        log.error('autoApproveHeader', e.message);
                    }

                    // ── 9. Negative inventory adjustment (short-pick) ────────────
                    var invAdjId = '';
                    var qtyDiff = (so.quantity || 0) - pickQty;

                    if (qtyDiff > 0) {
                        invAdjId = createNegativeInvAdj({
                            itemId: itemId,
                            locationId: locationId,
                            binId: binId,
                            headerId: headerId,
                            salesOrderId: salesOrderId,
                            pickerName: pickerName,
                            portalId: portalId
                        });
                    }

                    // ── 10. Create item line record ───────────────────────────────
                    var itemRec = record.create({ type: 'customrecord_jyswms_sales_order_item', isDynamic: true });
                    itemRec.setValue({ fieldId: 'custrecord_sales_order_header', value: headerId });
                    itemRec.setValue({ fieldId: 'custrecord_jyswms_item', value: itemId });
                    itemRec.setValue({ fieldId: 'custrecord_jyswms_item_order_qty', value: so.quantity });
                    itemRec.setValue({ fieldId: 'custrecord_jyswms_item_picked_qty', value: pickQty });
                    itemRec.setValue({ fieldId: 'custrecord_jyswms_sales_order', value: salesOrderId });
                    itemRec.setValue({ fieldId: 'custrecord_jyswms_item_picked_bin', value: binId });
                    itemRec.setValue({ fieldId: 'custrecord_jswms_item_so_item_qty', value: so.item_quantity });
                    itemRec.setValue({ fieldId: 'custrecord_jyswms_item_so_line_loc', value: locationId });
                    itemRec.setValue({ fieldId: 'custrecord_jyswms_item_uniqueid', value: uniqueId });
                    itemRec.setValue({ fieldId: 'custrecord_jyswms_item_portal_id', value: portalId });
                    itemRec.setValue({ fieldId: 'custrecord_jyswms_item_picker_name', value: pickerName });
                    itemRec.setValue({ fieldId: 'custrecord_jyswms_item_tracking_numbers', value: trackingNumbers.length });

                    if (savedBinTransferId) {
                        itemRec.setValue({ fieldId: 'custrecord_item_bintransfer_id', value: savedBinTransferId });
                    }
                    if (invAdjId) {
                        itemRec.setValue({ fieldId: 'custrecord_jyswms_item_inv_adjy', value: invAdjId });
                    }

                    var itemRecId = itemRec.save();
                    itemLines.push(itemRecId);

                    // ── 11. Create tracking / SSCC records ───────────────────────
                    // Load fresh header once for SSCC duplicate check
                    var headerRecForTracking = record.load({
                        type: 'customrecord_order_fulfillment_details',
                        id: headerId,
                        isDynamic: true
                    });

                    trackingNumbers.forEach(function (track) {
                        if (!track) return;
                        if (ssccExistsInSublist(headerRecForTracking, track.ssccCode)) return;

                        var trackRec = record.create({ type: 'customrecord_jyswms_sales_order_track', isDynamic: true });
                        trackRec.setValue({ fieldId: 'custrecord_jyswms_so_header', value: headerId });
                        trackRec.setValue({ fieldId: 'custrecord_jyswms_track_item', value: itemId });
                        trackRec.setValue({ fieldId: 'custrecord_jyswms_track_number', value: track.ssccCode });
                        trackRec.setValue({ fieldId: 'custrecord_jyswms_track_so_id', value: salesOrderId });
                        trackRec.setValue({ fieldId: 'custrecord_jyswms_track_qty', value: 1 });
                        trackRec.setValue({ fieldId: 'custrecord_jyswms_track_uniqueid', value: uniqueId });
                        trackRec.setValue({ fieldId: 'custrecord_jyswms_track_dropship', value: track.trackingNumber || ' ' });

                        trackingLines.push(trackRec.save({ enableSourcing: true, ignoreMandatoryFields: false }));
                    });

                    // ── 12. Update header totals ─────────────────────────────────
                    var soLookup = search.lookupFields({ type: 'salesorder', id: salesOrderId, columns: ['custbody_so_total_qty'] });
                    var totalSOQty = Number(soLookup.custbody_so_total_qty) || 0;

                    // Sum picked qty from header sublist lines
                    var totalPickedQty = 0;
                    var lineCount = headerRecForTracking.getLineCount({ sublistId: 'recmachcustrecord_sales_order_header' });
                    for (var l = 0; l < lineCount; l++) {
                        totalPickedQty += Number(headerRecForTracking.getSublistValue({
                            sublistId: 'recmachcustrecord_sales_order_header',
                            fieldId: 'custrecord_jyswms_item_picked_qty',
                            line: l
                        })) || 0;
                    }
                    if (totalPickedQty === 0) totalPickedQty = pickQty;

                    var totalsUpdate = {
                        custrecord_jyswms_total_so_qty: totalSOQty,
                        custrecord_jyswms_total_pick_qty: totalPickedQty
                    };
                    if (isSingleIf) totalsUpdate.custrecord_jyswms_approved = true;

                    try {
                        record.submitFields({
                            type: 'customrecord_order_fulfillment_details',
                            id: headerId,
                            values: totalsUpdate,
                            options: { enableSourcing: false, ignoreMandatoryFields: true }
                        });
                        existingMap[salesOrderId] = headerId;
                    } catch (e) {
                        log.error('updateHeaderTotals', { error: e.message, salesOrderId: salesOrderId, headerId: headerId });
                        continue;
                    }

                    // Final header save
                    try {
                        var finalHeader = record.load({ type: 'customrecord_order_fulfillment_details', id: headerId, isDynamic: true });
                        headerId = finalHeader.save();
                        existingMap[salesOrderId] = headerId;
                    } catch (e) {
                        log.error('finalHeaderSave', { error: e.message, salesOrderId: salesOrderId, headerId: headerId });
                        continue;
                    }

                } // end salesOrders loop

                log.audit('MarkAsPicked', 'transfers: ' + JSON.stringify(savedTransfers) + ' | headers: ' + JSON.stringify(savedHeaders));

            } // end data loop

            return {
                status: 'success',
                message: 'Items & tracking numbers processed successfully',
                binTransferId: savedTransfers,
                customRecID: savedHeaders,
                itemLines: itemLines,
                trackingLines: trackingLines,
                packageLines: packageLines
            };

        } catch (e) {
            log.error('POST Error', e);
            if (topLevelHeaderId) {
                record.submitFields({
                    type: 'customrecord_order_fulfillment_details',
                    id: topLevelHeaderId,
                    values: { custrecord_jyswms_error: e.message, custrecord_jyswms_item_error_: e.message }
                });
            }
            return { status: 'error', message: e.message };
        }
    }


    // ═══════════════════════════════════════════════════════════════════════════════
    // HELPER FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════════

    /** Returns a numeric pickQty, defaulting to 0 */
    function extractPickQty(so, dataItem) {
        if (so.picked_quantity !== undefined && so.picked_quantity !== null) return Number(so.picked_quantity);
        if (dataItem.picked_quantity !== undefined && dataItem.picked_quantity !== null) return Number(dataItem.picked_quantity);
        return 0;
    }

    /** Resolves locationId from dataItem or falls back to bin lookup */
    function resolveLocationId(dataItem, binId) {
        if (dataItem.locationId) return dataItem.locationId;
        if (dataItem.location) return dataItem.location === 'L60-Hardeeville_SC' ? 15 : 9;
        if (binId) {
            var loc = search.lookupFields({ type: search.Type.BIN, id: binId, columns: ['location'] });
            return loc.location && loc.location[0] && loc.location[0].value;
        }
        return null;
    }

    /** Fetches the existing fulfillment header ID for a given SO */
    function fetchExistingHeaderId(salesOrderId) {
        var result = null;
        search.create({
            type: 'customrecord_order_fulfillment_details',
            filters: [
                ['custrecord_jyswms_rel_item_ful', 'anyof', '@NONE@'], 'AND',
                ['isinactive', 'is', 'F'], 'AND',
                ['custrecord_jyswms_sales_order_id', 'anyof', salesOrderId]
            ],
            columns: ['internalid', 'custrecord_jyswms_sales_order_id']
        }).run().each(function (r) {
            result = r.id;
            return false; // stop at first result
        });
        return result;
    }

    /** Fetches SO metadata: isSingleIf, shipMethodId, customerId */
    function fetchSOMeta(salesOrderId) {
        var meta = { isSingleIf: false, shipMethodId: null, customerId: null };
        search.create({
            type: 'salesorder',
            filters: [
                ['type', 'anyof', 'SalesOrd'], 'AND',
                ['internalid', 'anyof', salesOrderId], 'AND',
                ['mainline', 'is', 'T']
            ],
            columns: [
                search.createColumn({ name: 'custentity_single_if', join: 'customer' }),
                search.createColumn({ name: 'shipmethod' }),
                search.createColumn({ name: 'entity' })
            ]
        }).run().each(function (r) {
            var v = r.getValue({ name: 'custentity_single_if', join: 'customer' });
            meta.isSingleIf = (v === true || v === 'T');
            meta.shipMethodId = r.getValue({ name: 'shipmethod' });
            meta.customerId = r.getValue({ name: 'entity' });
            return false;
        });
        return meta;
    }

    /**
     * Builds tracking number pairs from labelData / labelData2.
     * Returns array of { ssccCode, trackingNumber }
     */
    function buildTrackingPairs(so) {
        var trackingNumbers = [];

        var trackingList = (so.labelData || []).map(function (l) {
            return so.packing_slip ? (l.tracking_number || '') : (l.sscc_code || l.tracking_number || '');
        }).filter(Boolean);

        var ssccList = (so.labelData2 || []).map(function (l) {
            return l.sscc_code || l.tracking_number || '';
        }).filter(Boolean);

        if (ssccList.length && trackingList.length && !so.packing_slip) {
            // Pair SSCC + tracking by index
            var pairCount = Math.min(trackingList.length, ssccList.length);
            for (var p = 0; p < pairCount; p++) {
                trackingNumbers.push({ ssccCode: ssccList[p], trackingNumber: trackingList[p] });
            }
        } else if (so.packing_slip) {
            trackingList.forEach(function (tn) {
                trackingNumbers.push({ trackingNumber: tn, ssccCode: '' });
            });
        } else {
            trackingList.forEach(function (tn) {
                trackingNumbers.push({ ssccCode: tn, trackingNumber: '' });
            });
        }

        return trackingNumbers;
    }

    /**
     * Creates a bin transfer record.
     * Returns the saved record ID, or '' on failure.
     */
    function createBinTransfer(opts) {
        try {
            var bt = record.create({ type: 'bintransfer', isDynamic: true });
            bt.setValue({ fieldId: 'subsidiary', value: 1 });
            bt.setValue({ fieldId: 'custbody_wms_ai_created_by', value: true });
            bt.setValue({ fieldId: 'memo', value: 'Bin Transfer via Restlet' });
            bt.setValue({ fieldId: 'location', value: opts.locationId });
            bt.setValue({ fieldId: 'custbody_jyswms_item_unique_id', value: opts.uniqueId });
            bt.setValue({ fieldId: 'custbody_wms_ai_pickername', value: opts.pickerName });
            bt.setValue({ fieldId: 'custbody_realted_sales_order', value: opts.salesOrderId });

            bt.selectNewLine({ sublistId: 'inventory' });
            bt.setCurrentSublistValue({ sublistId: 'inventory', fieldId: 'item', value: opts.itemId });
            bt.setCurrentSublistValue({ sublistId: 'inventory', fieldId: 'quantity', value: opts.pickQty });

            var invDetail = bt.getCurrentSublistSubrecord({ sublistId: 'inventory', fieldId: 'inventorydetail' });
            invDetail.selectNewLine({ sublistId: 'inventoryassignment' });
            invDetail.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'binnumber', value: opts.binId });
            invDetail.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'quantity', value: opts.pickQty });
            invDetail.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'tobinnumber', value: opts.bulkStageBin });
            invDetail.commitLine({ sublistId: 'inventoryassignment' });
            bt.commitLine({ sublistId: 'inventory' });

            return bt.save();
        } catch (e) {
            log.error('createBinTransfer failed', e.message);
            return '';
        }
    }

    /**
     * Creates a negative inventory adjustment for a short-picked bin.
     * Returns the saved record ID, or '' on failure.
     */
    function createNegativeInvAdj(opts) {
        try {
            // Get actual on-hand qty in the bin so we zero it out precisely
            var negativeQty = '';
            search.create({
                type: 'inventorybalance',
                filters: [
                    ['item', 'anyof', opts.itemId], 'AND',
                    ['location', 'anyof', opts.locationId], 'AND',
                    ['available', 'greaterthan', '0'], 'AND',
                    ['binnumber.custrecord_jyswms_exclude_from_inventory', 'is', 'F'], 'AND',
                    ['binnumber', 'anyof', opts.binId], 'AND',
                    ['binnumber.inactive', 'is', 'F']
                ],
                columns: [search.createColumn({ name: 'onhand', summary: 'SUM' })]
            }).run().each(function (r) {
                negativeQty = -Number(r.getValue({ name: 'onhand', summary: 'SUM' }));
                return true;
            });

            var adj = record.create({ type: record.Type.INVENTORY_ADJUSTMENT, isDynamic: true });
            adj.setValue({ fieldId: 'subsidiary', value: 1 });
            adj.setValue({ fieldId: 'adjlocation', value: opts.locationId });
            adj.setValue({ fieldId: 'account', value: 464 });
            adj.setValue({ fieldId: 'memo', value: 'Auto negative adjustment for bin: ' + opts.binId });
            adj.setValue({ fieldId: 'custbody_wms_ai_created_by', value: true });
            adj.setValue({ fieldId: 'custbody_realted_jyorder', value: opts.headerId });
            adj.setValue({ fieldId: 'custbody_realted_sales_order', value: opts.salesOrderId });
            adj.setValue({ fieldId: 'custbody_wms_ai_pickername', value: opts.pickerName + ' portal Id: ' + opts.portalId });

            adj.selectNewLine({ sublistId: 'inventory' });
            adj.setCurrentSublistValue({ sublistId: 'inventory', fieldId: 'item', value: opts.itemId });
            adj.setCurrentSublistValue({ sublistId: 'inventory', fieldId: 'location', value: opts.locationId });
            adj.setCurrentSublistValue({ sublistId: 'inventory', fieldId: 'adjustqtyby', value: negativeQty });

            // Only add inventory detail if item uses bins
            var itemLookup = search.lookupFields({ type: search.Type.ITEM, id: opts.itemId, columns: ['usebins', 'recordtype'] });
            var usesBins = itemLookup.usebins === true || itemLookup.usebins === 'T' || (Array.isArray(itemLookup.usebins) && itemLookup.usebins[0] === 'T');
            var isInvItem = ['inventoryitem', 'serializedinventoryitem', 'lotnumberedinventoryitem'].indexOf(itemLookup.recordtype) !== -1;

            if (usesBins && isInvItem && opts.binId) {
                try {
                    var invDetail = adj.getCurrentSublistSubrecord({ sublistId: 'inventory', fieldId: 'inventorydetail' });
                    var existingLines = invDetail.getLineCount({ sublistId: 'inventoryassignment' });
                    for (var k = existingLines - 1; k >= 0; k--) {
                        invDetail.removeLine({ sublistId: 'inventoryassignment', line: k });
                    }
                    invDetail.selectNewLine({ sublistId: 'inventoryassignment' });
                    invDetail.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'binnumber', value: opts.binId });
                    invDetail.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'quantity', value: negativeQty });
                    invDetail.commitLine({ sublistId: 'inventoryassignment' });
                } catch (e) {
                    log.error('invDetailOnAdj', e.message);
                }
            }

            adj.commitLine({ sublistId: 'inventory' });

            var adjId = adj.save({ enableSourcing: true, ignoreMandatoryFields: true });
            log.error('Inventory Adjustment Created - MarkAsPicked', adjId);
            return adjId;

        } catch (e) {
            log.error('createNegativeInvAdj failed', { error: e.message, item: opts.itemId, bin: opts.binId });
            return '';
        }
    }

    return {
        markAsPicked_Group: markAsPicked_Group
    };

});
