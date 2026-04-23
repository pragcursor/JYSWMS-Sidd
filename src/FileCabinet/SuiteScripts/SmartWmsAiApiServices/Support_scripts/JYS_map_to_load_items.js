/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/record', 'N/search', 'N/format'], (record, search, format) => {

    const EXCLUDED_BINS = [
        "17066", "17064", "7573", "4859", "7586", "7565", "1206", "1408",
        "16692", "16734", "2633", "4672", "16691", "16727", "16733", "16735",
        "4964", "4963", "1410", "1408", "16727", "17373"
    ];

    const LOCATION_CONFIG = {
        l41: {
            id: '9',
            qtyField: 'custitem_l41_inventory_on_hand',
            zero: 'custitem_l41_zero_qty_date',
            arr: 'custitem_l41_qty_arrived_date',
            firstIr: 'custitem_l41_first_ir_date',
            latestIr: 'custitem_l41_latest_ir_date'
        },
        l60: {
            id: '15',
            qtyField: 'custitem_l60_inventory_on_hand',
            zero: 'custitem_l60_zero_qty_date',
            arr: 'custitem_l60_qty_arrived_date',
            firstIr: 'custitem_l60_first_ir_date',
            latestIr: 'custitem_l60_latest_ir_date'
        },
        l74: {
            id: '23',
            qtyField: 'custitem_l74_inventory_on_hand',
            zero: 'custitem_l74_zero_qty_date',
            arr: 'custitem_l74_qty_arrived_date',
            firstIr: 'custitem_l74_first_ir_date',
            latestIr: 'custitem_l74_latest_ir_date'
        },
        ftzl74: {
            id: '24',
            qtyField: 'custitem_ftzl74_inventory_on_hand',
            zero: 'custitem_ftz_0_qty_date',
            arr: 'custitem_ftz_l74_positive_qty_date',
            firstIr: 'custitem_ftz_first_ir_date',
            latestIr: 'custitem_ftz_latest_ir_date'
        }
    };

    const toNumber = v => isNaN(Number(v)) ? 0 : Number(v);

    function getTodayEST() {
        try {
            return format.parse({
                value: format.format({
                    value: new Date(),
                    type: format.Type.DATE,
                    timezone: format.Timezone.AMERICA_NEW_YORK
                }),
                type: format.Type.DATE
            });
        } catch (error) {
            log.error("Error getting today EST", error);
        }
    }

    function getInputData() {
        return search.create({
            type: search.Type.INVENTORY_ITEM,
            filters: [
                ["type", "anyof", "InvtPart"],
                "AND",
                ["isinactive", "is", "F"]
            ],
            columns: ["internalid"]
        });
    }

    function map(context) {
        try {
            const itemId = JSON.parse(context.value).id;

            // ⚠️ still using load for oldQty comparison (can be removed later)
            const itemRec = record.load({
                type: record.Type.INVENTORY_ITEM,
                id: itemId
            });

            let values = {};
            let today = getTodayEST();
            let locationQtyMap = {};
            let locationMetrics = {};

            // ================= BIN SEARCH =================
            search.create({
                type: "item",
                filters: [
                    ["internalid", "anyof", itemId],
                    "AND",
                    ["binonhand.binnumber", "noneof"].concat(EXCLUDED_BINS)
                ],
                columns: [
                    "binonhand.location",
                    "binonhand.quantityavailable"
                ]
            }).run().each(r => {

                const loc = r.getValue("binonhand.location");
                const qty = toNumber(r.getValue("binonhand.quantityavailable"));

                Object.keys(LOCATION_CONFIG).forEach(key => {
                    if (LOCATION_CONFIG[key].id === loc) {
                        locationQtyMap[key] = (locationQtyMap[key] || 0) + qty;
                    }
                });

                return true;
            });

            // ================= QTY + ZERO/ARR =================
            Object.keys(LOCATION_CONFIG).forEach(key => {

                const cfg = LOCATION_CONFIG[key];
                const newQty = toNumber(locationQtyMap[key]);
                const oldQty = toNumber(itemRec.getValue(cfg.qtyField));

                values[cfg.qtyField] = newQty;

                if (cfg.zero && cfg.arr) {

                    if (newQty === 0 && oldQty > 0) {
                        values[cfg.zero] = today;
                    }

                    if (newQty > 0 && oldQty === 0) {
                        values[cfg.arr] = today;
                    }
                }
            });

            // ================= METRICS =================
            search.create({
                type: "inventoryitem",
                filters: [["internalid", "anyof", itemId]],
                columns: [
                    "inventorylocation",
                    "locationquantityonhand",
                    "locationquantitycommitted",
                    "custitem_locationqtyintransitext2"
                ]
            }).run().each(r => {

                const loc = r.getValue("inventorylocation");

                locationMetrics[loc] = {
                    onHand: toNumber(r.getValue("locationquantityonhand")),
                    committed: toNumber(r.getValue("locationquantitycommitted")),
                    inTransit: toNumber(r.getValue("custitem_locationqtyintransitext2"))
                };

                return true;
            });

            // ================= INVOICE (1 SEARCH) =================
            let qty7 = 0, qty30 = 0, qty6m = 0, life = 0;
            const now = new Date();

            search.create({
                type: "invoice",
                filters: [
                    ["mainline", "is", "F"],
                    "AND",
                    ["item", "anyof", itemId]
                ],
                columns: ["trandate", "quantity"]
            }).run().each(r => {

                const qty = toNumber(r.getValue("quantity"));
                const date = new Date(r.getValue("trandate"));

                life += qty;

                const diffDays = (now - date) / (1000 * 60 * 60 * 24);

                if (diffDays <= 7) qty7 += qty;
                if (diffDays <= 30) qty30 += qty;
                if (diffDays <= 180) qty6m += qty;

                return true;
            });

            Object.assign(values, {
                custitem_last_7_days: qty7,
                custitem_last_30_days: qty30,
                custitem_sold_in_last_6_months: qty6m,
                custitem_lifetime_sold_qty: life
            });

            // ================= ITEM RECEIPTS (ALL LOCATIONS) =================
            Object.keys(LOCATION_CONFIG).forEach(key => {

                const cfg = LOCATION_CONFIG[key];
                if (!cfg.firstIr) return;

                let first = null, latest = null;

                search.create({
                    type: "itemreceipt",
                    filters: [
                        ["item", "anyof", itemId],
                        "AND",
                        ["location", "anyof", cfg.id]
                    ],
                    columns: [search.createColumn({ name: "trandate", sort: search.Sort.DESC })]
                }).run().each((r, i) => {

                    const d = r.getValue("trandate");

                    if (i === 0) latest = d;
                    first = d;

                    return true;
                });

                values[cfg.latestIr] = latest;
                values[cfg.firstIr] = first;
            });

            // ================= FACTORY =================
            let fdQty = 0;

            search.create({
                type: "customrecord_factory_items",
                filters: [["custrecord_items", "anyof", itemId]],
                columns: ["custrecord_quantitys"]
            }).run().each(r => {
                fdQty += toNumber(r.getValue("custrecord_quantitys"));
                return true;
            });

            // ================= TOTAL NEED TO SHIP =================
            let daysGoal = toNumber(itemRec.getValue('custitem_30d_sales_goal')) * 4;

            const getMetrics = key =>
                locationMetrics[LOCATION_CONFIG[key].id] || {};

            const l41 = getMetrics('l41');
            const l60 = getMetrics('l60');
            const l74 = getMetrics('l74');
            const ftz = getMetrics('ftzl74');

            let total =
                daysGoal
                - toNumber(l41.onHand)
                - toNumber(l60.onHand)
                - toNumber(l74.onHand)
                - toNumber(ftz.onHand)
                - toNumber(l41.committed)
                - toNumber(l60.committed)
                - toNumber(l74.committed)
                - toNumber(ftz.committed)
                - toNumber(l41.inTransit)
                - toNumber(l60.inTransit)
                - toNumber(l74.inTransit)
                - toNumber(ftz.inTransit)
                - fdQty;

            values.custitem_total_qty_shipped = Math.max(0, total);

            // ================= PO ATTENTION =================
            const totalOnHand =
                toNumber(locationQtyMap.l41) +
                toNumber(locationQtyMap.l60) +
                toNumber(locationQtyMap.l74) +
                toNumber(locationQtyMap.ftzl74) +
                toNumber(itemRec.getValue('custitem_locationqtyintransitext2'));

            values.custitem_po_attention_required = (qty30 * 3) > totalOnHand;

            // ================= FINAL SAVE =================
            record.submitFields({
                type: record.Type.INVENTORY_ITEM,
                id: itemId,
                values,
                options: { ignoreMandatoryFields: true }
            });
        } catch (error) {
            log.error("Error saving inventory item", error);
        }
    }

    function summarize(summary) {
        try {
            log.audit("DONE", summary);
        } catch (error) {
            log.error("Error summarizing inventory item", error);
        }
    }

    return { getInputData, map, summarize };
});