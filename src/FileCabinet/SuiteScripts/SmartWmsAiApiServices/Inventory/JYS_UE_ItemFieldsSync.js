/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 *
 * ============================================================
 * FILE:    JYS_UE_ItemFieldsSync.js
 * PURPOSE: Recalculates all custom inventory/sales fields on
 *          an Inventory Item whenever the item itself or any
 *          related transaction is saved.
 *
 * DEPLOY ON (afterSubmit only):
 * ┌──────────────────────────┬────────────────────────────────────────────────────────┐
 * │ Record Type              │ Why                                                    │
 * ├──────────────────────────┼────────────────────────────────────────────────────────┤
 * │ Inventory Item           │ Direct item edits / manual field changes               │
 * │ Item Receipt  (ItemRcpt) │ onHand changes, IR dates, receiving bin qty            │
 * │ Bin Transfer  (BinTrnfr) │ Bin-excluded qty shifts between bins                  │
 * │ Item Fulfillment(ItemShip│ onHand reduces, committed qty changes                  │
 * │ Customer Invoice(CustInvc│ Sold-qty fields (7d / 30d / 6mo / lifetime)            │
 * └──────────────────────────┴────────────────────────────────────────────────────────┘
 *
 * GOVERNANCE NOTES:
 *   - Each processItem() call runs ~8-10 searches + 3 submitFields.
 *   - Transactions with many unique InvtPart lines may approach the
 *     1,000-unit afterSubmit limit.  The governance guard at the top
 *     of processItem() will log & skip remaining items if units drop
 *     below the safety threshold — no script failure.
 * ============================================================
 */
define(['N/record', 'N/search', 'N/format', 'N/log', 'N/runtime'],
    function (record, search, format, log, runtime) {

    // ── Bins always excluded from available-qty calculations ──────────────
    var EXCLUDED_BINS = [
        "17066", "17064", "7573", "4859", "7586", "7565", "1206", "1408",
        "16692", "16734", "2633", "4672", "16691", "16727", "16733", "16735",
        "4964", "4963", "1410", "1408", "16727", "17373", "23178", "23176"
    ];

    // ── Location master config ────────────────────────────────────────────
    var LOCATION_CONFIG = {
        l41: {
            id: '9',
            qtyField: 'custitem_l41_inventory_on_hand',
            zeroQtyDateField: 'custitem_l41_zero_qty_date',
            qtyArrivedDateField: 'custitem_l41_qty_arrived_date',
            firstIrDateField: 'custitem_l41_first_ir_date',
            latestIrDateField: 'custitem_l41_latest_ir_date',
            recBinId: '1206',
            recBinQtyField: 'custitem202'
        },
        l60: {
            id: '15',
            qtyField: 'custitem_l60_inventory_on_hand',
            zeroQtyDateField: 'custitem_l60_zero_qty_date',
            qtyArrivedDateField: 'custitem_l60_qty_arrived_date',
            firstIrDateField: 'custitem_l60_first_ir_date',
            latestIrDateField: 'custitem_l60_latest_ir_date',
            recBinId: '16691',
            recBinQtyField: 'custitem203'
        },
        l74: {
            id: '23',
            qtyField: 'custitem_l74_inventory_on_hand',
            zeroQtyDateField: 'custitem_l74_zero_qty_date',
            qtyArrivedDateField: 'custitem_l74_qty_arrived_date',
            firstIrDateField: 'custitem_l74_first_ir_date',
            latestIrDateField: 'custitem_l74_latest_ir_date',
            recBinId: '23176',
            recBinQtyField: 'custitem_receiving_l74'
        },
        ftzl74: {
            id: '24',
            qtyField: 'custitem_ftzl74_inventory_on_hand'
            // no IR dates / receiving-bin needed for FTZ
        }
    };

    // ─────────────────────────────────────────────────────────────────────
    // HELPER UTILITIES
    // ─────────────────────────────────────────────────────────────────────

    function toNumber(value) {
        var num = Number(value);
        return isNaN(num) ? 0 : num;
    }

    function getTodayInEST() {
        var date = new Date();
        var dateString = format.format({
            value: date,
            type: format.Type.DATE,
            timezone: format.Timezone.AMERICA_NEW_YORK
        });
        return format.parse({
            value: dateString,
            type: format.Type.DATE,
            timezone: format.Timezone.AMERICA_NEW_YORK
        });
    }

    // ─────────────────────────────────────────────────────────────────────
    // SEARCH HELPERS  (identical logic to original UE — zero changes)
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Returns available qty for one item at one location,
     * excluding all bins in EXCLUDED_BINS.
     */
    function getLocationAvailableQty(itemId, locationId) {
        try {
            var qty = 0;
            search.create({
                type: 'item',
                filters: [
                    ['binonhand.binnumber', 'noneof'].concat(EXCLUDED_BINS),
                    'AND',
                    ['binonhand.location', 'anyof', locationId],
                    'AND',
                    ['internalid', 'anyof', itemId]
                ],
                columns: [
                    search.createColumn({ name: 'quantityavailable', join: 'binOnHand' })
                ]
            }).run().each(function (result) {
                qty += toNumber(result.getValue({ name: 'quantityavailable', join: 'binOnHand' }));
                return true;
            });
            return qty;
        } catch (e) {
            log.error('getLocationAvailableQty', 'loc=' + locationId + ' | ' + e.message);
            return 0;
        }
    }

    /**
     * Returns committed / inTransit / onHand metrics for
     * all requested location IDs in a single search pass.
     */
    function getInventoryLocationMetrics(itemId, locationIds) {
        var metrics = {};
        locationIds.forEach(function (locId) {
            metrics[String(locId)] = { committed: 0, inTransit: 0, onHand: 0 };
        });

        try {
            search.create({
                type: 'inventoryitem',
                filters: [
                    ['type', 'anyof', 'InvtPart'],
                    'AND',
                    ['internalidnumber', 'equalto', itemId],
                    'AND',
                    ['inventorylocation', 'anyof'].concat(locationIds)
                ],
                columns: [
                    search.createColumn({ name: 'formulanumeric1', formula: '({custitem_locationqtyintransitext2})', label: 'Qty InTransit' }),
                    search.createColumn({ name: 'formulanumeric2', formula: '({locationquantitycommitted})',         label: 'Qty Committed' }),
                    search.createColumn({ name: 'formulanumeric3', formula: '({locationquantityonhand})',            label: 'Qty OnHand' }),
                    search.createColumn({ name: 'inventorylocation' })
                ]
            }).run().each(function (result) {
                var loc = String(result.getValue({ name: 'inventorylocation' }));
                if (!metrics[loc]) metrics[loc] = { committed: 0, inTransit: 0, onHand: 0 };
                metrics[loc].inTransit  = toNumber(result.getValue({ name: 'formulanumeric1', formula: '({custitem_locationqtyintransitext2})' }));
                metrics[loc].committed  = toNumber(result.getValue({ name: 'formulanumeric2', formula: '({locationquantitycommitted})' }));
                metrics[loc].onHand     = toNumber(result.getValue({ name: 'formulanumeric3', formula: '({locationquantityonhand})' }));
                return true;
            });
        } catch (e) {
            log.error('getInventoryLocationMetrics', e.message);
        }
        return metrics;
    }

    /**
     * Returns { firstDate, latestDate } from Item Receipts
     * sourced from Purchase Orders for the given item + location.
     */
    function getItemReceiptDates(itemId, locationId) {
        var result = { firstDate: '', latestDate: '' };
        try {
            var irSearch = search.create({
                type: 'itemreceipt',
                filters: [
                    ['type', 'anyof', 'ItemRcpt'],
                    'AND', ['item', 'anyof', itemId],
                    'AND', ['location', 'anyof', locationId],
                    'AND', ['formulatext: {createdfrom}', 'contains', 'Purchase Order']
                ],
                columns: [
                    search.createColumn({ name: 'trandate', summary: 'GROUP', sort: search.Sort.DESC }),
                    search.createColumn({ name: 'tranid',   summary: 'GROUP' })
                ]
            });

            var count = irSearch.runPaged().count;
            if (count === 0) return result;

            var latest = irSearch.run().getRange({ start: 0, end: 1 });
            if (latest && latest.length) {
                result.latestDate = latest[0].getValue({ name: 'trandate', summary: 'GROUP' });
            }

            if (count >= 2) {
                var oldest = irSearch.run().getRange({ start: count - 1, end: count });
                if (oldest && oldest.length) {
                    result.firstDate = oldest[0].getValue({ name: 'trandate', summary: 'GROUP', sort: search.Sort.DESC });
                }
            }

            if (!result.firstDate) result.firstDate = result.latestDate;

        } catch (e) {
            log.error('getItemReceiptDates', 'loc=' + locationId + ' | ' + e.message);
        }
        return result;
    }

    /**
     * Sums invoice quantity for the item within the given period keyword.
     * Pass null for lifetime totals.
     */
    function getInvoiceSum(itemId, periodKeyword) {
        try {
            var filters = [
                ['mainline', 'is', 'F'],
                'AND', ['type', 'anyof', 'CustInvc'],
                'AND', ['item', 'anyof', itemId]
            ];
            if (periodKeyword) {
                filters.push('AND');
                filters.push(['trandate', 'within', periodKeyword]);
            }

            var qty = 0;
            search.create({
                type: 'invoice',
                filters: filters,
                columns: [search.createColumn({ name: 'quantity', summary: 'SUM' })]
            }).run().each(function (result) {
                qty = toNumber(result.getValue({ name: 'quantity', summary: 'SUM' }));
                return true;
            });
            return qty;
        } catch (e) {
            log.error('getInvoiceSum', 'period=' + periodKeyword + ' | ' + e.message);
            return 0;
        }
    }

    /**
     * Returns total factory shipment-request qty for the item.
     */
    function getFactoryRequestQty(itemId) {
        try {
            var fdQty = 0;
            search.create({
                type: 'customrecord_factory_items',
                filters: [
                    ['created', 'onorafter', '7/24/2024 12:00 am', '7/23/2024 12:00 am'],
                    'AND',
                    ['custrecord_items', 'anyof', itemId]
                ],
                columns: [search.createColumn({ name: 'custrecord_quantitys' })]
            }).run().each(function (result) {
                fdQty += toNumber(result.getValue({ name: 'custrecord_quantitys' }));
                return true;
            });
            return fdQty;
        } catch (e) {
            log.error('getFactoryRequestQty', e.message);
            return 0;
        }
    }

    /**
     * Returns available qty in a specific receiving bin for the item.
     */
    function getBinAvailableQty(itemId, binId) {
        try {
            var qty = 0;
            search.create({
                type: 'inventoryitem',
                filters: [
                    ['type', 'anyof', 'InvtPart'],
                    'AND', ['binonhand.binnumber', 'anyof', binId],
                    'AND', ['binonhand.quantityavailable', 'greaterthan', '0'],
                    'AND', ['internalid', 'anyof', itemId]
                ],
                columns: [search.createColumn({ name: 'quantityavailable', join: 'binOnHand' })]
            }).run().each(function (result) {
                qty = toNumber(result.getValue({ name: 'quantityavailable', join: 'binOnHand' }));
                return true;
            });
            return qty;
        } catch (e) {
            log.error('getBinAvailableQty', 'bin=' + binId + ' | ' + e.message);
            return 0;
        }
    }

    /**
     * Determines whether zero-qty date or qty-arrived date needs updating.
     * oldRecord may be the same as itemRec when called from a transaction context
     * (no prior item state available) — in that case date stamping falls back to
     * the qty-is-zero / qty-is-positive checks only.
     */
    function updateZeroAndArrivalDates(itemRec, oldRecord, locationKey, newQty, today, valuesToSubmit) {
        try {
            var config = LOCATION_CONFIG[locationKey];
            if (!config.zeroQtyDateField || !config.qtyArrivedDateField) return;

            var oldValue   = oldRecord ? toNumber(oldRecord.getValue({ fieldId: config.qtyField })) : 0;
            var zeroQtyDate = itemRec.getValue({ fieldId: config.zeroQtyDateField });
            var qtyArrDate  = itemRec.getValue({ fieldId: config.qtyArrivedDateField });

            if ((newQty === 0 && oldValue > newQty) || (newQty === 0 && !zeroQtyDate)) {
                valuesToSubmit[config.zeroQtyDateField] = today;
            }
            if ((newQty > 0 && newQty > oldValue) || (newQty > 0 && !qtyArrDate)) {
                valuesToSubmit[config.qtyArrivedDateField] = today;
            }
        } catch (e) {
            log.error('updateZeroAndArrivalDates', locationKey + ' | ' + e.message);
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // CORE PROCESSOR
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Recalculates and saves all custom fields for one Inventory Item.
     * Called from afterSubmit for both direct item saves and transaction saves.
     *
     * @param {string|number} internalId  - Item internal ID
     * @param {Record|null}   oldItemRec  - context.oldRecord when available (item deployment only)
     */
    function processItem(internalId, oldItemRec) {
        try {
            // ── Governance guard ─────────────────────────────────────────
            var remaining = runtime.getCurrentScript().getRemainingUsage();
            if (remaining < 200) {
                log.error('GOVERNANCE SKIP', 'Item ' + internalId + ' skipped — only ' + remaining + ' units left');
                return;
            }

            // ── Load item ────────────────────────────────────────────────
            var itemRec = record.load({
                type: record.Type.INVENTORY_ITEM,
                id: internalId,
                isDynamic: false
            });

            var manufacturer_tariff = itemRec.getValue({ fieldId: 'manufacturertariff' });
            var days_Sales_Goal     = toNumber(itemRec.getValue({ fieldId: 'custitem_30d_sales_goal' })) * 4;
            var today               = getTodayInEST();

            // ── 1. Available qty per location (bin-exclusion applied) ────
            var locationQtyMap = {};
            Object.keys(LOCATION_CONFIG).forEach(function (key) {
                locationQtyMap[key] = getLocationAvailableQty(internalId, LOCATION_CONFIG[key].id);
            });

            // ── 2. Committed / InTransit / OnHand metrics ────────────────
            var locationMetrics = getInventoryLocationMetrics(internalId, ['9', '15', '23']);

            var valuesToSubmit = {};

            // ── 3. Individual location qty fields ────────────────────────
            Object.keys(LOCATION_CONFIG).forEach(function (key) {
                valuesToSubmit[LOCATION_CONFIG[key].qtyField] = locationQtyMap[key];
            });

            // ── 4. L74 combined total (physical L74 + FTZ-L74) ───────────
            valuesToSubmit.custitem_l74_total_inventory_on_hand =
                toNumber(locationQtyMap.l74) + toNumber(locationQtyMap.ftzl74);

            // ── 5. Zero-qty / arrived dates for L41, L60, L74 ───────────
            // oldItemRec is null when triggered via transaction — pass itemRec for both
            var prevRecord = oldItemRec || itemRec;
            updateZeroAndArrivalDates(itemRec, prevRecord, 'l41', locationQtyMap.l41 || 0, today, valuesToSubmit);
            updateZeroAndArrivalDates(itemRec, prevRecord, 'l60', locationQtyMap.l60 || 0, today, valuesToSubmit);
            updateZeroAndArrivalDates(itemRec, prevRecord, 'l74', locationQtyMap.l74 || 0, today, valuesToSubmit);

            // ── 6. Item Receipt first / latest dates ─────────────────────
            ['l41', 'l60', 'l74'].forEach(function (key) {
                var cfg = LOCATION_CONFIG[key];
                if (!cfg.firstIrDateField || !cfg.latestIrDateField) return;
                var irDates = getItemReceiptDates(internalId, cfg.id);
                valuesToSubmit[cfg.firstIrDateField]  = irDates.firstDate;
                valuesToSubmit[cfg.latestIrDateField] = irDates.latestDate;
            });

            // ── 7. Total Qty Need to Ship ────────────────────────────────
            var l41m = locationMetrics['9']  || { committed: 0, inTransit: 0, onHand: 0 };
            var l60m = locationMetrics['15'] || { committed: 0, inTransit: 0, onHand: 0 };
            var l74m = locationMetrics['23'] || { committed: 0, inTransit: 0, onHand: 0 };

            var totalQtyNeedToShip =
                days_Sales_Goal
                - toNumber(l41m.onHand)     - toNumber(l60m.onHand)     - toNumber(l74m.onHand)
                - toNumber(l41m.committed)   - toNumber(l60m.committed)   - toNumber(l74m.committed)
                - toNumber(l41m.inTransit)   - toNumber(l60m.inTransit)   - toNumber(l74m.inTransit);

            var fdQty = getFactoryRequestQty(internalId);
            if (fdQty > 0) totalQtyNeedToShip -= fdQty;
            if (totalQtyNeedToShip < 0) totalQtyNeedToShip = 0;

            valuesToSubmit.custitem_total_qty_shipped = totalQtyNeedToShip;

            // ── 8. Submit all qty + date fields (batch 1) ────────────────
            record.submitFields({
                type: 'inventoryitem',
                id: internalId,
                values: valuesToSubmit,
                options: { enableSourcing: false, ignoreMandatoryFields: true }
            });

            // ── 9. Sold qty — invoice searches ───────────────────────────
            var qty7days   = getInvoiceSum(internalId, 'previousoneweek');
            var qty30days  = getInvoiceSum(internalId, 'previousonemonth');
            var qty6months = getInvoiceSum(internalId, 'previousrollinghalf');
            var lifeTime   = getInvoiceSum(internalId, null);

            record.submitFields({
                type: 'inventoryitem',
                id: internalId,
                values: {
                    custitem_sold_in_last_6_months:  qty6months,
                    custitem_last_30_days:           qty30days,
                    custitem_last_7_days:            qty7days,
                    custitem_lifetime_sold_qty:      lifeTime,
                    custitem_ns_manufacturer_tariff: manufacturer_tariff
                },
                options: { enableSourcing: false, ignoreMandatoryFields: true }
            });

            // ── 10. PO Attention Required ────────────────────────────────
            var totalOnHand =
                toNumber(locationQtyMap.l41) +
                toNumber(locationQtyMap.l60) +
                toNumber(locationQtyMap.l74) +
                toNumber(locationQtyMap.ftzl74) +
                toNumber(itemRec.getValue({ fieldId: 'custitem_locationqtyintransitext2' }));

            record.submitFields({
                type: 'inventoryitem',
                id: internalId,
                values: {
                    custitem_po_attention_required: (qty30days * 3) > totalOnHand
                },
                options: { enableSourcing: false, ignoreMandatoryFields: true }
            });

            // ── 11. Receiving bin qty ────────────────────────────────────
            ['l41', 'l60', 'l74'].forEach(function (key) {
                var cfg = LOCATION_CONFIG[key];
                if (!cfg.recBinId || !cfg.recBinQtyField) return;
                try {
                    var recQty = getBinAvailableQty(internalId, cfg.recBinId);
                    if (recQty > 0) {
                        record.submitFields({
                            type: 'inventoryitem',
                            id: internalId,
                            values: { [cfg.recBinQtyField]: recQty },
                            options: { enableSourcing: false, ignoreMandatoryFields: true }
                        });
                    }
                } catch (e) {
                    log.error('recBinQty', key + ' | ' + e.message);
                }
            });

            log.audit('processItem OK', 'Item ' + internalId + ' | Gov remaining: ' + runtime.getCurrentScript().getRemainingUsage());

        } catch (e) {
            log.error('processItem FAILED', 'Item ' + internalId + ' | ' + e.message);
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // TRANSACTION HELPER — extract unique InvtPart item IDs from any
    // transaction record (Item Receipt, Bin Transfer, Item Fulfillment,
    // Customer Invoice all use 'item' sublist; Bin Transfer also uses
    // 'inventory' sublist as fallback)
    // ─────────────────────────────────────────────────────────────────────

    function getItemIdsFromTransaction(transRec) {
        var uniqueIds = new Set();

        // Primary sublist used by ItemRcpt, ItemShip, CustInvc
        var itemCount = transRec.getLineCount({ sublistId: 'item' });
        if (itemCount && itemCount > 0) {
            for (var i = 0; i < itemCount; i++) {
                var itemId   = transRec.getSublistValue({ sublistId: 'item', fieldId: 'item',     line: i });
                var itemType = transRec.getSublistValue({ sublistId: 'item', fieldId: 'itemtype', line: i });
                if (itemId && itemType === 'InvtPart') {
                    uniqueIds.add(String(itemId));
                }
            }
        }

        // Fallback sublist used by Bin Transfer
        var invCount = transRec.getLineCount({ sublistId: 'inventory' });
        if (invCount && invCount > 0) {
            for (var j = 0; j < invCount; j++) {
                var invItemId = transRec.getSublistValue({ sublistId: 'inventory', fieldId: 'item', line: j });
                if (invItemId) uniqueIds.add(String(invItemId));
            }
        }

        return uniqueIds;
    }

    // ─────────────────────────────────────────────────────────────────────
    // ENTRY POINT — single afterSubmit handles ALL deployment types
    // ─────────────────────────────────────────────────────────────────────

    function afterSubmit(context) {
        try {
            var rec = context.newRecord;

            // ── A) Deployed on Inventory Item directly ────────────────────
            if (rec.type === record.Type.INVENTORY_ITEM || rec.type === 'inventoryitem') {
                log.audit('afterSubmit', 'InventoryItem ' + rec.id + ' — direct save');
                processItem(rec.id, context.oldRecord);
                return;
            }

            // ── B) Deployed on Transaction records ────────────────────────
            var itemIds = getItemIdsFromTransaction(rec);

            log.audit('afterSubmit',
                'Transaction type=' + rec.type +
                ' id=' + rec.id +
                ' | Unique InvtPart items: ' + itemIds.size
            );

            if (itemIds.size === 0) {
                log.debug('afterSubmit', 'No InvtPart lines found — nothing to process');
                return;
            }

            itemIds.forEach(function (itemId) {
                // null for oldItemRec — we have no prior item state from a transaction context
                processItem(itemId, null);
            });

        } catch (e) {
            log.error('afterSubmit TOP-LEVEL ERROR', e.message);
        }
    }

    // Only afterSubmit is needed — beforeLoad / beforeSubmit not required
    return { afterSubmit: afterSubmit };
});