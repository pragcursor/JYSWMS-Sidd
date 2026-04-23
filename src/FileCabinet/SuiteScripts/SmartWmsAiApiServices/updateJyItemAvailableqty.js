/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/record', 'N/search'], (record, search) => {

    const afterSubmit = (context) => {
        try {

            const internalId = context.newRecord.id;
            const recType = context.newRecord.type;

            // Location → Field mapping
            const locationFieldMap = {
                "9": "custitem_l41_inventory_on_hand",
                "15": "custitem_l60_inventory_on_hand"
            };

            // Initialize values
            let values = {
                custitem_l41_inventory_on_hand: 0,
                custitem_l60_inventory_on_hand: 0
            };

            // ❗ YOUR ITEM SEARCH (fixed)
            const itemSearchObj = search.create({
                type: "item",
                filters: [
                    ["type","anyof","InvtPart"],
                    "AND",
                    ["inventorylocation","anyof","9","15"],
                    "AND",
                    ["internalid","anyof", internalId]
                ],
                columns: [
                    search.createColumn({name: "inventorylocation"}),
                    search.createColumn({name: "locationquantityavailable"})
                ]
            });

            itemSearchObj.run().each(result => {

                const locationId = result.getValue({
                    name: "inventorylocation"
                });

                const qty = parseFloat(result.getValue({
                    name: "locationquantityavailable"
                })) || 0;

                const fieldId = locationFieldMap[locationId];

                if (fieldId) {
                    values[fieldId] = qty;
                }

                return true;
            });

            // ✅ Update item fields
            record.submitFields({
                type: recType,
                id: internalId,
                values: {
                    custitem_l41_inventory_on_hand: Math.floor(values.custitem_l41_inventory_on_hand),
                    custitem_l60_inventory_on_hand: Math.floor(values.custitem_l60_inventory_on_hand)
                },
                options: {
                    enableSourcing: false,
                    ignoreMandatoryFields: true
                }
            });
            log.error('Updated Item', {
                itemId: internalId,
                newL41: Math.floor(values.custitem_l41_inventory_on_hand),
                newL60: Math.floor(values.custitem_l60_inventory_on_hand)
            });

        } catch (e) {
            log.error('Error', e);
        }
    };

    return { afterSubmit };

});