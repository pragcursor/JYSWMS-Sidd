/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/search', 'N/record', 'N/log'], (search, record, log) => {

    const getInputData = () => {
        return search.create({
            type: "transaction",
            filters: [
                ["type", "anyof", "SalesOrd", "ItemShip", "ItemRcpt", "InvTrnfr", "BinTrnfr", "InvAdjst"],
                "AND",
                // [
                //     ["datecreated","onorafter","lastweek"],
                //     "OR",
                //     ["lastmodifieddate","onorafter","lastweek"]
                // ],
                // "AND",
                ["mainline", "is", "F"],
                "AND",
                ["taxline", "is", "F"],
                "AND",
                ["shipping", "is", "F"],
                "AND",
                ["cogs", "is", "F"],
                "AND",
                ["internalid", "anyof", "63100185"]
            ],
            columns: [
                search.createColumn({
                    name: "item",
                    summary: "GROUP"
                })
            ]
        });
    };

    const map = (context) => {

        const result = JSON.parse(context.value);
        const itemId = result.values["GROUP(item)"].value;

        context.write({
            key: itemId,
            value: itemId
        });
    };

    // const reduce = (context) => {

    //     const itemId = context.key;

    //     let newL41 = 0;
    //     let newL60 = 0;

    //     // 🔍 Get real availability from item-location data
    //     const itemSearch = search.create({
    //         type: "item",
    //         filters: [
    //             ["internalid","anyof", itemId],
    //             "AND",
    //             ["inventorylocation","anyof","9","15"]
    //         ],
    //         columns: [
    //             "inventorylocation",
    //             "locationquantityavailable"
    //         ]
    //     });

    //     itemSearch.run().each(result => {

    //         const location = result.getValue("inventorylocation");
    //         const qty = Math.floor(parseFloat(result.getValue("locationquantityavailable")) || 0);

    //         if (location == "9") {
    //             newL41 = qty;
    //         }

    //         if (location == "15") {
    //             newL60 = qty;
    //         }

    //         return true;
    //     });

    //     // 🔍 Existing values
    //     const existing = search.lookupFields({
    //         type: search.Type.ITEM,
    //         id: itemId,
    //         columns: [
    //             'custitem_jy_avail_qty_l41',
    //             'custitem_jy_available_quantity_l60'
    //         ]
    //     });

    //     const oldL41 = parseFloat(existing.custitem_jy_avail_qty_l41) || 0;
    //     const oldL60 = parseFloat(existing.custitem_jy_available_quantity_l60) || 0;

    //     // Skip if no change
    //     if (oldL41 === newL41 && oldL60 === newL60) {
    //         return;
    //     }

    //     record.submitFields({
    //         type: record.Type.INVENTORY_ITEM,
    //         id: itemId,
    //         values: {
    //             custitem_jy_avail_qty_l41: newL41,
    //             custitem_jy_available_quantity_l60: newL60
    //         },
    //         options: {
    //             enableSourcing: false,
    //             ignoreMandatoryFields: true
    //         }
    //     });

    //     log.audit('Updated Item', {
    //         itemId,
    //         newL41,
    //         newL60
    //     });
    // };

    const reduce = (context) => {

        const itemIds = context.values; // all itemIds for this reduce key batch

        let availabilityMap = {};

        // 🔥 BULK ITEM SEARCH
        const itemSearch = search.create({
            type: "item",
            filters: [
                ["internalid", "anyof", itemIds],
                "AND",
                ["inventorylocation", "anyof", "9", "15"]
            ],
            columns: [
                "internalid",
                "inventorylocation",
                "locationquantityavailable"
            ]
        });

        itemSearch.run().each(result => {

            const itemId = result.getValue("internalid");
            const location = result.getValue("inventorylocation");
            const qty = Math.floor(parseFloat(result.getValue("locationquantityavailable")) || 0);

            if (!availabilityMap[itemId]) {
                availabilityMap[itemId] = { l41: 0, l60: 0 };
            }

            if (location == "9") {
                availabilityMap[itemId].l41 = qty;
            }

            if (location == "15") {
                availabilityMap[itemId].l60 = qty;
            }

            return true;
        });

        // 🔁 Update all items
        Object.keys(availabilityMap).forEach(itemId => {

            const data = availabilityMap[itemId];

            record.submitFields({
                type: record.Type.INVENTORY_ITEM,
                id: itemId,
                values: {
                    custitem_jy_avail_qty_l41: data.l41,
                    custitem_jy_available_quantity_l60: data.l60
                },
                options: {
                    enableSourcing: false,
                    ignoreMandatoryFields: true
                }
            });
            log.error('Updated Item', {
                itemId: itemId,
                l41: data.l41,
                l60: data.l60
            });

        });
    };

    return {
        getInputData,
        map,
        reduce
    };
});