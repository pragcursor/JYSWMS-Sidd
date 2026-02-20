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
    './Orders/orderUtils.js',
    './JYSWMS_generateToken_API.js'
], (record, search, log, runtime, https, autoLocUtil, tokenModule) => {

    const LOC_HARDEE = '15';
    const LOC_FLEMINGTON = '9';
    const LOCATIONS = ['9', '15'];

    const REASON_NA = 1;
    const REASON_BULK = 2;
    const REASON_RECEIVING = 3;
    const REASON_BOTH = 4;
    const REASON_OTHER_LOCATION = 5;

    // =========================================================
    // SEND DATA FUNCTION (FIXED SCOPE ISSUE)
    // =========================================================
    const sendData = (payload) => {

        const token = tokenModule.generateToken();
        if (!token) {
            log.error('sendData', 'Token generation failed');
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

            return {
                success: response.code === 200,
                response: response.body || ''
            };

        } catch (e) {
            log.error('sendData Error', e);
            return { success: false, error: e.message };
        }
    };

    // =========================================================
    // AFTER SUBMIT
    // =========================================================
    const afterSubmit = (context) => {

        if (![context.UserEventType.CREATE, context.UserEventType.EDIT].includes(context.type)) {
            return;
        }

        try {

            const newRec = context.newRecord;
            const soId = newRec.id;
            const soType = newRec.type;
            // if(soId != 62730674){
            //     return;
            // }
            if (soType !== record.Type.SALES_ORDER) return;

            const autoLocEnabled = newRec.getValue('custbody_jyswms_enable_auto_loc_chng');
            const alreadyUpdated = newRec.getValue('custbody_jyswms_loc_updated');
            const status = newRec.getValue('status');

            if (['Closed', 'Cancelled', 'Billed'].includes(status)) return;
            if (!autoLocEnabled || alreadyUpdated) return;

            const customerId = newRec.getValue({ fieldId: 'entity' });
            if (!customerId) return;

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

            if (!isJysEnabled) return;

            const so = record.load({
                type: soType,
                id: soId,
                isDynamic: false
            });

            const lineCount = so.getLineCount({ sublistId: 'item' });
            if (!lineCount) return;

            // 🔥 BLOCK: Single IF + Multi Line
            if (isSingleIFCustomer && lineCount > 1) {
                log.error('Single IF Customer', 'Single IF customer with multiple lines. Marking as updated without changes.');
                // record.submitFields({
                //     type: soType,
                //     id: soId,
                //     values: { custbody_jyswms_loc_updated: true },
                //     options: { enableSourcing: false, ignoreMandatoryFields: true }
                // });

                return;
            }
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

                if (pickedQty <= 0 || pickedQty < quantity) {

                    const itemId = so.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'item',
                        line: i
                    });

                    if (itemId) itemSet.add(itemId);
                }
            }

            if (!itemSet.size) {
                markComplete(soType, soId);
                return;
            }

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

                if (!inventoryMap[itemId]) inventoryMap[itemId] = {};
                if (!inventoryMap[itemId][locId]) inventoryMap[itemId][locId] = 0;

                inventoryMap[itemId][locId] += qty;

                return true;
            });

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

                if (
                    inventoryMap[itemId][currentLoc] &&
                    inventoryMap[itemId][currentLoc] >= qtyRequired
                ) continue;

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

                so.save({
                    enableSourcing: false,
                    ignoreMandatoryFields: true
                });
                log.audit('Auto Location Change', `Updated SO ${soId} with new locations for items: ${Array.from(updatedItemIds).join(', ')}`);

            } else {
                markComplete(soType, soId);
            }

            if (updatedItemIds.size) {

                const payload = {
                    salesOrderHeaderId: soId,
                    salesOrderItemId: Array.from(updatedItemIds)
                };

                const responseJson = autoLocUtil.getOrdersDUP(payload);

                if (responseJson && responseJson.length > 0) {
                    sendData(responseJson);
                }
            }

        } catch (error) {
            log.error('Error in SO Auto Location Change', error);
        }
    };

    const markComplete = (type, id) => {
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

        if (![context.UserEventType.CREATE, context.UserEventType.EDIT].includes(context.type)) {
            return;
        }

        try {

            const soRec = context.newRecord;
            const isEnabled = soRec.getValue('custbody_jys_enabled_customer');
            if (!isEnabled) return;

            const lineCount = soRec.getLineCount({ sublistId: 'item' });
            if (!lineCount) return;

            const itemSet = new Set();

            for (let i = 0; i < lineCount; i++) {

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
            }

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
                    ['binnumber.inactive', 'is', 'F']
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

            for (let i = 0; i < lineCount; i++) {

                const itemId = soRec.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'item',
                    line: i
                });

                const lineLocation = soRec.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'location',
                    line: i
                });

                const quantity = parseFloat(
                    soRec.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'quantity',
                        line: i
                    })
                ) || 0;

                const pickedQty = parseFloat(
                    soRec.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'quantitypicked',
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

                    if (!currentHasInventory && otherHasInventory) {
                        reasonId = REASON_OTHER_LOCATION;
                    } else if (!currentHasInventory && !otherHasInventory) {
                        reasonId = REASON_NA;
                    } else {
                        reasonId = determineBinReason(currentLocBins);
                    }
                }

                soRec.setSublistValue({
                    sublistId: 'item',
                    fieldId: 'custcol_jyswms_issue',
                    line: i,
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
            } else if (binName.includes('receiving') || binName.includes('rt')) {
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

    return { afterSubmit, beforeSubmit };

});
