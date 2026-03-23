/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define([
    'N/record',
    'N/search',
    'N/log',
    'N/runtime',
    'N/https',
    './Orders/orderUtils',
    './JYSWMS_generateToken_API'
], (record, search, log, runtime, https, autoLocUtil, tokenModule) => {

    const LOC_HARDEE = '15';
    const LOC_FLEMINGTON = '9';
    const LOCATIONS = ['9', '15'];

    const REASON_NA = 1;
    const REASON_BULK = 2;
    const REASON_RECEIVING = 3;
    const REASON_BOTH = 4;
    const REASON_OTHER_LOCATION = 5;
    const REASON_OTHER_LOC_BULK_REC = 6;

    // =========================================================
    // SEND DATA
    // =========================================================
    const sendData = (payload) => {

        log.error('SEND DATA - START', JSON.stringify(payload));

        const token = tokenModule.generateToken();
        log.error('SEND DATA - Token Generated', token ? 'Success' : 'Failed');
        if (!token) {
            log.error('SEND DATA - Token Failed', 'Token generation failed');
            return;
        }

        try {
            const response = https.post({
                url: 'https://api.jyswms.com/update-dropship-lines?closed=false',
                headers: {
                    'Authorization': 'Bearer ' + token,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            log.error('SEND DATA - RESPONSE', {
                code: response.code,
                body: response.body
            });

            return {
                success: response.code === 200,
                response: response.body || ''
            };

        } catch (e) {
            log.error('SEND DATA - ERROR', e);
            return { success: false, error: e.message };
        }
    };

    // =========================================================
    // AFTER SUBMIT
    // =========================================================
    const afterSubmit = (context) => {

        // log.error('AFTER SUBMIT - START', {
        //     type: context.type,
        //     recordId: context.newRecord.id
        // });

        if (![context.UserEventType.EDIT].includes(context.type)) {
            // log.error('EXIT', 'Not CREATE or EDIT'); ![context.UserEventType.CREATE,
            return;
        }

        try {

            const newRec = context.newRecord;
            const soId = newRec.id;
            const soType = newRec.type;
            // if (soId != 62696792) {
            //     return;
            // }
            if (soType !== record.Type.SALES_ORDER) {
                log.error('EXIT', 'Not Sales Order');
                return;
            }

            const autoLocEnabled = newRec.getValue('custbody_jyswms_enable_auto_loc_chng');
            const alreadyUpdated = newRec.getValue('custbody_jyswms_loc_updated');
            const status = newRec.getValue('status');

            //  log.debug('HEADER CHECK', { autoLocEnabled, alreadyUpdated, status });

            if (['Closed', 'Cancelled', 'Billed'].includes(status)) {
                // log.error('EXIT', 'Invalid status');
                return;
            }

            if (!autoLocEnabled || alreadyUpdated) {
                //log.error('EXIT', 'Auto loc disabled or already updated');
                return;
            }

            const customerId = newRec.getValue({ fieldId: 'entity' });
            if (!customerId) {
                //  log.error('EXIT', 'No customer');
                return;
            }

            const customerLookup = search.lookupFields({
                type: search.Type.CUSTOMER,
                id: customerId,
                columns: ['custentity_jyswms_enable', 'custentity_single_if']
            });

            const isJysEnabled =
                customerLookup.custentity_jyswms_enable === true ||
                customerLookup.custentity_jyswms_enable === 'T';

            const isSingleIFCustomer =
                customerLookup.custentity_single_if === true ||
                customerLookup.custentity_single_if === 'T';

            // log.debug('CUSTOMER FLAGS', { isJysEnabled, isSingleIFCustomer });

            if (!isJysEnabled) {
                // log.error('EXIT', 'Customer not enabled');
                return;
            }

            const so = record.load({
                type: soType,
                id: soId,
                isDynamic: false
            });

            const lineCount = so.getLineCount({ sublistId: 'item' });

            // log.debug('LINE COUNT', lineCount);

            if (!lineCount) return;

            // if (isSingleIFCustomer && lineCount > 1) {
            //   //  log.error('EXIT', 'Single IF customer with multiple lines');
            //     return;
            // }

            const itemSet = new Set();

            for (let i = 0; i < lineCount; i++) {

                const itemType = so.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'itemtype',
                    line: i
                });

                if (itemType !== 'InvtPart') continue;

                const quantity = parseFloat(
                    so.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'quantity',
                        line: i
                    })
                ) || 0;

                const pickedQty = Number(
                    so.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'custcol_jyswms_picked_qty',
                        line: i
                    })
                ) || 0;

                const itemId = String(
                    so.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'item',
                        line: i
                    })
                );

                // log.debug('LINE EVAL', {
                //     line: i,
                //     itemId,
                //     quantity,
                //     pickedQty
                // });

                if (pickedQty <= 0 || pickedQty < quantity) {
                    itemSet.add(itemId);
                }
            }

            //log.debug('ITEM SET', Array.from(itemSet));

            if (!itemSet.size) {
                // log.error('No items require evaluation');
                markComplete(soType, soId);
                return;
            }

            const inventoryMap = {};

            // log.error('INVENTORY SEARCH START', Array.from(itemSet));

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
                    ['binnumber.inactive', 'is', 'F'],
                    "AND",
                    ["binnumber.binnumber", "isnotempty", ""]
                ],
                columns: ['item', 'location', 'available']
            }).run().each(result => {

                const itemId = String(result.getValue('item'));
                const locId = String(result.getValue('location'));
                const qty = parseFloat(result.getValue('available')) || 0;

                // log.debug('INVENTORY ROW', { itemId, locId, qty });

                if (!inventoryMap[itemId]) inventoryMap[itemId] = {};
                if (!inventoryMap[itemId][locId]) inventoryMap[itemId][locId] = 0;

                inventoryMap[itemId][locId] += qty;

                return true;
            });

            //  log.error('INVENTORY MAP BUILT', JSON.stringify(inventoryMap));

            let anyLineUpdated = false;
            let newHeaderLocation = null;
            const updatedItemIds = new Set();

            for (let i = 0; i < lineCount; i++) {

                const itemType = so.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'itemtype',
                    line: i
                });

                if (itemType !== 'InvtPart') continue;

                const itemId = String(
                    so.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'item',
                        line: i
                    })
                );

                if (!inventoryMap[itemId]) continue;

                const qtyRequired = parseFloat(
                    so.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'quantity',
                        line: i
                    })
                ) || 0;

                const currentLoc = String(
                    so.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'location',
                        line: i
                    })
                );
                //   log.debug('EVALUATING LINE', { line: i, itemId });
                //   log.debug('INVENTORY CHECK', { itemId, inventoryMap: inventoryMap[itemId] });
                const currentAvailable =
                    (inventoryMap[itemId][currentLoc]) || 0;

                const alternateLoc =
                    currentLoc === LOC_HARDEE ? LOC_FLEMINGTON : LOC_HARDEE;

                const alternateAvailable =
                    (inventoryMap[itemId][alternateLoc]) || 0;

                // log.error('INVENTORY DECISION for SOID: ' + soId, {
                //     line: i,
                //     itemId,
                //     qtyRequired,
                //     currentLoc,
                //     currentAvailable,
                //     alternateLoc,
                //     alternateAvailable
                // });

                if (currentAvailable >= qtyRequired) {
                    log.debug('DECISION for SOID: ' + soId, 'Sufficient at current location');
                    continue;
                }

                if (alternateAvailable >= qtyRequired) {

                    log.error('LOCATION SWITCH for SOID: ' + soId, {
                        line: i,
                        itemId,
                        from: currentLoc,
                        to: alternateLoc
                    });

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

                    so.setSublistValue({
                        sublistId: 'item',
                        fieldId: 'custcol_jyswms_issue',
                        line: i,
                        value: ''
                    });

                    anyLineUpdated = true;
                    updatedItemIds.add(itemId);

                    if (lineCount === 1) {
                        newHeaderLocation = alternateLoc;
                    }
                }
            }

            if (anyLineUpdated) {

                if (lineCount === 1 && newHeaderLocation) {
                    so.setValue({ fieldId: 'location', value: newHeaderLocation });
                }

                so.setValue({
                    fieldId: 'custbody_jyswms_loc_updated',
                    value: true
                });

                log.error('SAVING SO for SOID: ' + soId, soId);

                so.save({
                    enableSourcing: false,
                    ignoreMandatoryFields: true
                });

            } else {
                //  log.error('No lines updated for SOID: ' + soId, soId);
                markComplete(soType, soId);
            }

            if (updatedItemIds.size) {

                const payload = {
                    salesOrderHeaderId: soId,
                    salesOrderItemId: Array.from(updatedItemIds)
                };

                log.error('CALLING DUP API for SOID: ' + soId, payload);

                // const responseJson = autoLocUtil.getDropShipOrders_helperfunction(payload);
                // log.error('DUP API RESPONSE for SOID: ' + soId, responseJson);
                // if (responseJson && responseJson.data && Object.keys(responseJson.data).length > 0) {
                //     sendData(responseJson.data);
                // }    function getDropShipOrders(context, pageSize, startIndex) {

                const responseJson = autoLocUtil.getDropShipOrders_helperfunction(payload,1000,0);  //_helperfunction
                log.error('DUP API RESPONSE for SOID: ' + soId, responseJson);

                if (
                    responseJson &&
                    responseJson.data &&
                    Object.keys(responseJson.data).length > 0
                ) {
                    log.error('VALID DATA FOUND - CALLING API', responseJson.data);
                    sendData(responseJson);
                } else {
                    log.error('NO VALID DATA - SKIPPING API', responseJson);
                }
            }

        } catch (error) {
            log.error('AFTER SUBMIT ERROR for SOID: ' + error);
        }
    };

    const markComplete = (type, id) => {
        //  log.error('MARK COMPLETE for SOID: ' + id, id);

        record.submitFields({
            type: type,
            id: id,
            values: { custbody_jyswms_loc_updated: true },
            options: { enableSourcing: false, ignoreMandatoryFields: true }
        });
    };
    // =========================================================
    // BEFORE SUBMIT
    // =========================================================
    const beforeSubmit = (context) => {
        // runs on edit of sales order, checks if any lines are marked picked but not fulfilled, if so checks inventory and sets issue reason if needed. Also checks for closed lines and sends to WMS if found.
        if (![context.UserEventType.EDIT].includes(context.type)) {
            return;
        }

        try {

            const soRec = context.newRecord;
            const isEnabled = soRec.getValue('custbody_jys_enabled_customer');
            if (!isEnabled) return;

            const shipvia = soRec.getValue('shipmethod');
            if (shipvia == 57733) {
                log.error('EXIT', 'Order is marked as P/U, skipping auto location change and closed line sync');
                return;
            }

            const excludeCustomer = soRec.getText('entity');
            if (excludeCustomer && excludeCustomer.toLowerCase().includes('amazon')) {
                log.error('EXIT', 'Customer is Amazon, skipping auto location change and closed line sync');
                return;
            }

            const status = soRec.getValue('status');
            var lowerStatus = status ? String(status).toLowerCase() : '';
            if (['closed', 'cancelled', 'billed'].includes(lowerStatus)) {
                soRec.setValue({
                    fieldId: 'custbody_jyswms_fufilment_error',
                    value: ''
                });
            }

            const lineCount = soRec.getLineCount({ sublistId: 'item' });
            if (!lineCount) return;

            const CLOSED_SYNC_START_DATE = new Date(2026, 0, 1);
            // Month is 0-indexed → 0 = January

            const closedItemIds = new Set(); // Track items that are closed
            const itemSet = new Set();
            let allLinesPicked = true;
            for (let i = 0; i < lineCount; i++) {
                const pickedRaw = soRec.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'custcol_jyswms_picked_qty',
                    line: i
                });

                const jypickedQty = parseFloat(pickedRaw);
                // ---- NEW LOGIC (does not impact existing behavior) ----
                if ((pickedRaw == null || pickedRaw == '' || pickedRaw == undefined) && jypickedQty != 0) {
                    allLinesPicked = false;
                } else if (jypickedQty >= 0) {
                    allLinesPicked = true;
                }
                const itemId = soRec.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'item',
                    line: i
                });

                const quantity = parseFloat(
                    soRec.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'quantity',
                        line: i
                    })
                ) || 0;

                const fulfilledQty = parseFloat(
                    soRec.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'quantityfulfilled',
                        line: i
                    })
                ) || 0;

                if (itemId && fulfilledQty < quantity) {
                    itemSet.add(itemId);
                }

                const isClosed = soRec.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'isclosed',
                    line: i
                });
                const closed_sent = soRec.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'custcol_jys_close_sent',
                    line: i
                });

                if (isClosed === true || isClosed === 'T' && !closed_sent) {
                    if (pickedRaw > 0) {
                        soRec.setSublistValue({
                            sublistId: 'item',
                            fieldId: 'custcol_jys_close_sent',
                            line: i,
                            value: true
                        });
                        soRec.setSublistValue({
                            sublistId: 'item',
                            fieldId: 'isclosed',
                            line: i,
                            value: true
                        });
                    }

                    if (itemId && (pickedRaw == null || pickedRaw == '' || pickedRaw == undefined || pickedRaw == 0)) {
                        closedItemIds.add(String(itemId));
                    }
                }
            }

            // =========================================================
            // CLOSED LINE API CALL
            // =========================================================
            if (closedItemIds.size > 0) {

                const tranDate = soRec.getValue({ fieldId: 'trandate' });

                if (!tranDate || new Date(tranDate) <= CLOSED_SYNC_START_DATE) {
                    // log.debug('CLOSED SYNC SKIPPED - Old Order', {
                    //     soId: soRec.id,
                    //     trandate: tranDate
                    // });

                } else if (tranDate && new Date(tranDate) > CLOSED_SYNC_START_DATE) {
                    //  log.error('CLOSED ITEMS FOUND for SOID: ' + soRec.id, Array.from(closedItemIds));
                    const payload = {
                        salesOrderHeaderId: soRec.id,
                        salesOrderItemId: Array.from(closedItemIds)
                    };

                    //  log.error('CLOSED ITEMS DETECTED', payload);

                    const responseJson = autoLocUtil.getDropShipOrders_helperfunction(payload);

                    if (responseJson && responseJson.length > 0) {
                        //  sendClosedData(responseJson);
                    }
                }
            }

            // close lines logic end

            soRec.setValue({
                fieldId: 'custbody_jys_wms_sync_completed',
                value: allLinesPicked                       //&& lineCount > 0
            });

            if (!itemSet.size) return;

            const availabilityMap = {};

            search.create({
                type: 'inventorybalance',
                filters: [
                    ['item', 'anyof', [...itemSet]],
                    'AND',
                    ['location', 'anyof', LOCATIONS],
                    'AND',
                    ['available', 'greaterthan', '0'],
                    'AND',
                    ['binnumber.inactive', 'is', 'F'],
                    "AND",
                    ["binnumber.binnumber", "isnotempty", ""]
                ],
                columns: ['item', 'location', 'available', 'binnumber']
            }).run().each(result => {

                const item = result.getValue('item');
                const location = result.getValue('location');
                const available = parseFloat(result.getValue('available')) || 0;
                const binText = result.getText('binnumber') || '';

                if (!availabilityMap[item]) availabilityMap[item] = {};
                if (!availabilityMap[item][location]) availabilityMap[item][location] = [];

                availabilityMap[item][location].push({
                    bin: binText,
                    available: available
                });

                return true;
            });

            for (let d = 0; d < lineCount; d++) {

                const itemId = soRec.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'item',
                    line: d
                });

                const lineLocation = soRec.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'location',
                    line: d
                });

                const quantity = parseFloat(
                    soRec.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'quantity',
                        line: d
                    })
                ) || 0;

                const pickedQty = parseFloat(
                    soRec.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'quantitypicked',
                        line: d
                    })
                ) || 0;

                const fulfilledQty = parseFloat(
                    soRec.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'quantityfulfilled',
                        line: d
                    })
                ) || 0;

                let reasonId = '';

                if (fulfilledQty >= quantity || pickedQty > 0) {
                    reasonId = '';
                } else if (itemId && lineLocation) {

                    const itemData = availabilityMap[itemId] || {};
                    const currentLocBins = itemData[lineLocation] || [];
                    const otherLocation = LOCATIONS.find(loc => loc !== lineLocation);
                    const otherLocBins = itemData[otherLocation] || [];

                    const currentHasInventory = hasInventory(currentLocBins);
                    const otherHasInventory = hasInventory(otherLocBins);

                    // if (!currentHasInventory && otherHasInventory) {
                    //     reasonId = REASON_OTHER_LOCATION;
                    // } 
                    if (!currentHasInventory && otherHasInventory) {
                        if (hasOnlyBulkOrReceiving(otherLocBins)) {
                            reasonId = REASON_OTHER_LOC_BULK_REC;
                        } else {
                            reasonId = REASON_OTHER_LOCATION;
                        }
                    }
                    else if (!currentHasInventory && !otherHasInventory) {
                        reasonId = REASON_NA;
                    } else {
                        reasonId = determineBinReason(currentLocBins);
                    }
                }

                soRec.setSublistValue({
                    sublistId: 'item',
                    fieldId: 'custcol_jyswms_issue',
                    line: d,
                    value: reasonId || ''
                });
            }



        } catch (e) {
            log.error('Inventory Script Error', e);
        }
    };

    const hasInventory = (binData) =>
        binData.some(b => (b.available || 0) > 0);

    const determineBinReason = (binData) => {

        if (!binData || !binData.length) return REASON_NA;

        let hasBulk = false;
        let hasReceiving = false;
        let hasOther = false;

        binData.forEach(entry => {

            const binName = (entry.bin || '').toLowerCase();

            if (binName.includes('bulk')) {
                hasBulk = true;
            } else if (binName.includes('receiving') || binName.includes('rt') || binName.includes('studio')) {
                hasReceiving = true;
            } else {
                hasOther = true;
            }
        });

        if (hasOther) return '';
        if (hasBulk && hasReceiving) return REASON_BOTH;
        if (hasBulk) return REASON_BULK;
        if (hasReceiving) return REASON_RECEIVING;

        return REASON_NA;
    };

    function hasOnlyBulkOrReceiving(bins) {
        if (!bins || !bins.length) return false;

        return bins.every(b =>
            b.available > 0 &&
            (
                b.bin.toLowerCase().includes('bulk') ||
                b.bin.toLowerCase().includes('receiving') ||
                b.bin.toLowerCase().includes('studio')
            )
        );
    }



    // =========================================================
    // SEND CLOSED DATA
    // =========================================================
    const sendClosedData = (payload) => {

        const token = tokenModule.generateToken();
        if (!token) {
            //  log.error('SEND CLOSED DATA - Token Failed', 'Token generation failed');
            return;
        }

        try {
            const response = https.post({
                url: 'https://api.jyswms.com/update-dropship-lines?closed=true',
                headers: {
                    'Authorization': 'Bearer ' + token,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            return {
                success: response.code === 200,
                response: response.body || ''
            };

        } catch (e) {
            log.error('SEND CLOSED DATA - ERROR', e);
            return { success: false, error: e.message };
        }
    };

    return { afterSubmit, beforeSubmit };

});