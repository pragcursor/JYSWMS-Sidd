/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/record', 'N/search', 'N/log', 'N/runtime', 'N/https', './Orders/orderUtils.js', './JYSWMS_generateToken_API.js'], (record, search, log, runtime, https, autoLocUtil, tokenModule) => {

    const LOC_HARDEE = '15';     // L60-Hardeeville_SC
    const LOC_FLEMINGTON = '9';  // Flemington L41

    const afterSubmit = (context) => {

        if (![context.UserEventType.CREATE, context.UserEventType.EDIT].includes(context.type)) {
            return;
        }
        try {
            const newRec = context.newRecord;
            const recordId = newRec.id;
            const recordtype = newRec.type;

            const autoLocEnabled = newRec.getValue('custbody_jyswms_enable_auto_loc_chng');
            const alreadyUpdated = newRec.getValue('custbody_jyswms_loc_updated');
            const tranName = newRec.getValue('tranid');
            const status = newRec.getValue('status');
            // const sta = newRec.getValue('status');
            // log.debug('sta', sta);
            if (status == 'Closed' || status == 'Cancelled' || status == 'Billed') {
                log.debug('Scritp exists - status for order: ' + tranName + ' is ', status +' -' + tranName +'-');
                return;
            }
            if (recordtype === record.Type.SALES_ORDER) {

                var customerId = newRec.getValue({ fieldId: 'entity' });

                if (customerId) {
                    var customerLookup = search.lookupFields({
                        type: search.Type.CUSTOMER,
                        id: customerId,
                        columns: ['custentity_jyswms_enable']
                    });

                    if (customerLookup.custentity_jyswms_enable === false || customerLookup.custentity_jyswms_enable === 'F') {
                        // log.audit(
                        //     'Sales Order Approval Skipped',
                        //     'JYS-NOT Enbled | SO ID: ' + recordId
                        // );
                        return;
                    }
                    log.audit(
                        'Sales Order Approval Enabled',
                        'JYS-Enabled | SO ID: ' + recordId
                    );
                }
            }

            // HARD EXIT – prevents reload & infinite loop
            if (!autoLocEnabled || alreadyUpdated) {
                log.debug('script exists - autoLoc || alreadyUpdated ', 'autoLocEnabled: ' + autoLocEnabled + ' - alreadyUpdated: ' + alreadyUpdated);
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

            var so_status = so.getValue({ fieldId: 'status' });
            if (so_status == 'Closed' || so_status == 'Cancelled' || so_status == 'Billed') {
                log.debug('2nd entry point restricted - status for order: ' + soId + ' is ', so_status)
                return;
            }

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
                const pickedQtyRaw = so.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'custcol_jyswms_picked_qty',
                    line: i
                });
                const pickedQty = Number(pickedQtyRaw) || 0;


                if (itemType === 'InvtPart' && pickedQty <= 0) {

                    const itemId = so.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'item',
                        line: i
                    });
                    log.debug('ispicked - for order :' + soId + ' ', 'item: ' + itemId + 'pickedqty = ' + pickedQty);

                    if (itemId) itemSet.add(itemId);
                }
            }


            //  log.debug('lineCount', lineCount);
            if (!itemSet.size) return;
            log.debug('itemSet.size', itemSet.size);
            log.debug('itemSet', [...itemSet]);


            // Inventory availability map: { itemId: { locationId: availableQty } }
            // const inventoryMap = {};

            // search.create({
            //     type: 'inventorybalance',
            //     filters: [
            //         ['item', 'anyof', [...itemSet]],
            //         'AND',
            //         ['location', 'anyof', [LOC_HARDEE, LOC_FLEMINGTON]],
            //         'AND',
            //         ['available', 'greaterthan', '0'],
            //         "AND",
            //         ["binnumber.custrecord_jyswms_exclude_from_inventory", "is", "F"],
            //         "AND",
            //         ["binnumber.inactive", "is", "F"]
            //     ],
            //     columns: ['item', 'location', 'available', 'binnumber']
            // }).run().each(result => {
            //     const itemId = result.getValue('item');
            //     const locId = result.getValue('location');
            //     const qty = parseFloat(result.getValue('available')) || 0;

            //     if (!inventoryMap[itemId]) {
            //         inventoryMap[itemId] = {};
            //     }
            //     inventoryMap[itemId][locId] = qty;
            //     return true;
            // });
            // log.debug('Inventory Map', JSON.stringify(inventoryMap));



            const inventoryMap = {};

            search.create({
                type: 'inventorybalance',
                filters: [
                    ['item', 'anyof', [...itemSet]],
                    'AND',
                    ['location', 'anyof', [LOC_HARDEE, LOC_FLEMINGTON]],
                    'AND',
                    ['available', 'greaterthan', '0'],
                    'AND',
                    ['binnumber.custrecord_jyswms_exclude_from_inventory', 'is', 'F'],
                    'AND',
                    ['binnumber.inactive', 'is', 'F']
                ],
                columns: ['item', 'location', 'available']
            }).run().each(result => {

                const itemId = result.getValue('item');
                const locId = result.getValue('location');
                const qty = parseFloat(result.getValue('available')) || 0;

                if (!inventoryMap[itemId]) {
                    inventoryMap[itemId] = {};
                }

                if (!inventoryMap[itemId][locId]) {
                    inventoryMap[itemId][locId] = 0;
                }

                inventoryMap[itemId][locId] += qty;

                return true;
            });

            log.debug('Inventory Map', JSON.stringify(inventoryMap));



            let anyLineUpdated = false;
            let newHeaderLocation = null;
            const updatedItemIds = new Set();

            for (let i = 0; i < lineCount; i++) {

                const itemType = so.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'itemtype',
                    line: i
                });
                //  log.debug('itemType', itemType);
                if (itemType !== 'InvtPart') continue;

                const itemId = so.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'item',
                    line: i
                });
                //  log.debug('inventoryMap[itemId]', inventoryMap[itemId]);
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

                //  log.debug('alternateLoc', alternateLoc);
                //  log.debug(itemId, 'qtyRequired=' + qtyRequired + ',currentLoc' + inventoryMap[itemId][currentLoc] + ', Alternate=' + inventoryMap[itemId][alternateLoc])

                if (
                    inventoryMap[itemId][alternateLoc] &&
                    inventoryMap[itemId][alternateLoc] >= qtyRequired
                ) {
                    // log.debug('inventoryMap[itemId][alternateLoc] >= qtyRequired', inventoryMap[itemId][alternateLoc] >= qtyRequired);
                    so.setSublistValue({
                        sublistId: 'item',
                        fieldId: 'location',
                        line: i,
                        value: alternateLoc
                    });
                    so.setSublistValue({
                        sublistId: 'item',
                        fieldId: 'custcol_jyswms_line_location',
                        line: i,
                        value: alternateLoc
                    });
                    anyLineUpdated = true;
                    // collect ONLY item IDs
                    updatedItemIds.add(itemId);
                    // Track header location ONLY if single-line SO
                    if (lineCount === 1) {
                        newHeaderLocation = alternateLoc;
                    }
                }

            }
            // log.debug('updatedItemIds', updatedItemIds);
            // Save only if changes were made
            if (anyLineUpdated) {
                if (lineCount === 1 && newHeaderLocation) {
                    so.setValue({
                        fieldId: 'location',
                        value: newHeaderLocation
                    });

                }
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

            let responseJson = null;

            if (updatedItemIds.size) {
                const payload = {
                    salesOrderHeaderId: soId,
                    salesOrderItemId: Array.from(updatedItemIds) // ['123','456']
                };

                responseJson = autoLocUtil.getOrdersDUP(payload);
                //  log.audit('Util Response', JSON.stringify(responseJson));
            }
            if (responseJson && responseJson.length > 0) {
                var send = sendData(responseJson)
            }

        } catch (error) {
            log.error('Error in SO Auto Location Change', error);
        }
    };



    /** Sends data to external API using parameters */
    function sendData(recId) {
        const token = tokenModule.generateToken();
        if (!token) {
            return;
        }

        try {
            const response = https.post({
                url: 'https://api.jyswms.com/update-dropship-lines?closed=' + false,
                headers: {
                    'Authorization': 'Bearer ' + token,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(recId)
            });

            log.debug('sendData Response', JSON.stringify(response));
            return {
                success: response.code === 200,
                response: response.body || ''
            };

        } catch (e) {
            log.error('sendData Error', e);
            return { success: false, error: e.message };
        }
    }

    return { afterSubmit };
});