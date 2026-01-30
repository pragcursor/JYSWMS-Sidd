/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/record', 'N/search'], (record, search) => {

    const LOC_HARDEE = '15';     // L60-Hardeeville_SC
    const LOC_FLEMINGTON = '9';  // Flemington L41

    const afterSubmit = (context) => {

        if (![context.UserEventType.CREATE, context.UserEventType.EDIT].includes(context.type)) {
            return;
        }

        const newRec = context.newRecord;

        const autoLocEnabled = newRec.getValue('custbody_jyswms_enable_auto_loc_chng');
        const alreadyUpdated = newRec.getValue('custbody_jyswms_loc_updated');

        // HARD EXIT – prevents reload & infinite loop
        if (!autoLocEnabled || alreadyUpdated) {
            return;
        }

        const soId = newRec.id;
        const soType = newRec.type;
        //log.debug('SO Auto Location Change', `Processing SO ID: ${soId}`);
        // Load record ONCE
        const so = record.load({
            type: soType,
            id: soId,
            isDynamic: false
        });

        const lineCount = so.getLineCount({ sublistId: 'item' });
        if (!lineCount) return;

        const itemSet = new Set();

        // Collect inventory items only
        for (let i = 0; i < lineCount; i++) {
            const itemType = so.getSublistValue({
                sublistId: 'item',
                fieldId: 'itemtype',
                line: i
            });

            if (itemType === 'InvtPart') {
                const itemId = so.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'item',
                    line: i
                });
                if (itemId) itemSet.add(itemId);
            }
        }

        if (!itemSet.size) return;

        // Inventory availability map: { itemId: { locationId: availableQty } }
        const inventoryMap = {};

        search.create({
            type: 'inventorybalance',
            filters: [
                ['item', 'anyof', [...itemSet]],
                'AND',
                ['location', 'anyof', [LOC_HARDEE, LOC_FLEMINGTON]],
                'AND',
                ['available', 'greaterthan', '0']
            ],
            columns: ['item', 'location', 'available']
        }).run().each(result => {
            const itemId = result.getValue('item');
            const locId = result.getValue('location');
            const qty = parseFloat(result.getValue('available')) || 0;

            if (!inventoryMap[itemId]) {
                inventoryMap[itemId] = {};
            }
            inventoryMap[itemId][locId] = qty;
            return true;
        });
       // log.debug('Inventory Map', JSON.stringify(inventoryMap));
        let anyLineUpdated = false;

        for (let i = 0; i < lineCount; i++) {

            const itemType = so.getSublistValue({
                sublistId: 'item',
                fieldId: 'itemtype',
                line: i
            });
            if (itemType !== 'InvtPart') continue;

            const itemId = so.getSublistValue({
                sublistId: 'item',
                fieldId: 'item',
                line: i
            });

            if (!inventoryMap[itemId]) continue;

            const qtyRequired = parseFloat(
                so.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'quantity',
                    line: i
                })
            ) || 0;

            const currentLoc = so.getSublistValue({
                sublistId: 'item',
                fieldId: 'location',
                line: i
            });

            // Inventory exists at current location
            if (
                inventoryMap[itemId][currentLoc] &&
                inventoryMap[itemId][currentLoc] >= qtyRequired
            ) {
                continue;
            }

            const alternateLoc =
                currentLoc === LOC_HARDEE ? LOC_FLEMINGTON : LOC_HARDEE;

            if (
                inventoryMap[itemId][alternateLoc] &&
                inventoryMap[itemId][alternateLoc] >= qtyRequired
            ) {
                so.setSublistValue({
                    sublistId: 'item',
                    fieldId: 'location',
                    line: i,
                    value: alternateLoc
                });
                anyLineUpdated = true;
            }
        }

        // Save only if changes were made
        if (anyLineUpdated) {
            so.setValue({
                fieldId: 'custbody_jyswms_loc_updated',
                value: true
            });
            log.audit('SO Auto Location Change', `Saving SO ID: ${soId} with location changes.`);
            so.save({
                enableSourcing: false,
                ignoreMandatoryFields: true
            });
        } else {
            var submit = record.submitFields({
                type: soType,
                id: soId,
                values: {
                    custbody_jyswms_loc_updated: true
                },
                options: {
                    enableSourcing: false,
                    ignoreMandatoryFields: true
                }
            });
        }
    };

    return { afterSubmit };
});
