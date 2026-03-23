/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/record', 'N/url', 'N/https', 'N/log', 'N/search'], function (record, url, https, log, search) {

    function afterSubmit(context) {
        try {
            var newRec = context.newRecord;
            //  if (context.type !== context.UserEventType.CREATE) return;

            var recordId = newRec.id;
            var recordType = newRec.type;
            var response = {};

            var isApproved = newRec.getValue({ fieldId: 'custrecord_jyswms_approved' });
            var itemFulfill = newRec.getValue({ fieldId: 'custrecord_jyswms_rel_item_ful' });
            var isPackagesUpdated = newRec.getValue({ fieldId: 'custrecord_jyswms_package_updated' });

            var salesOrderId = newRec.getValue({ fieldId: 'custrecord_jyswms_sales_order_id' });
            var headerPickedQty = newRec.getValue({ fieldId: 'custrecord_jyswms_total_pick_qty' });
            var totalSoQuantity = newRec.getValue({ fieldId: 'custrecord_jyswms_total_so_qty' });
            var fulfillPartilly = newRec.getValue({ fieldId: 'custrecord_jyswms_is_partially_fulfilled' });
            var locationId = newRec.getValue({ fieldId: 'custrecord_jyswms_location_id' }) || "";
            var lineLineLocation = locationId;
            var singleIf = issingleif(recordId, salesOrderId)
             var shipVia = newRec.getValue('custrecord_jyswms_order_ship_via');

            // if (shipVia != '57733' ) {
            //   log.error("not a P/U order",shipVia);
            //   return ;
            // }


            var customerId = newRec.getValue('custrecord_jyswms_customer_frm_so');
            log.error("customerId", customerId);
           
            // if (!ltlCustomer || (customerId !== '1807' && customerId !== '476')) {
            //     log.error("not an amazon order", customerId);
            //     log.error("not a P/U order", shipVia);
            //     return;
            // }

            // var allowedCustomers = ['1807', '476'];

            // if (!ltlCustomer && !allowedCustomers.includes(customerId)) {
            //     log.debug("Skipping record", customerId);
            //     return;
            // }

            // log.error("amazon order", customerId);


            // if ((customerId == '476' && shipVia != '57733') || (customerId == '473' && shipVia != '57733')) {
            //     return;
            // }


            var allowedCustomers = ['476', '1807'];

            // Lookup customer checkbox
            var customerLookup = search.lookupFields({
                type: search.Type.CUSTOMER,
                id: customerId,
                columns: ['custentity_wms_ltl_customer']
            });

            var ltlCustomer = customerLookup.custentity_wms_ltl_customer || false;

            log.debug("LTL Customer Flag", ltlCustomer);


            // CASE 1: P/U Orders
            if (shipVia == '57733') {

                // if (!ltlCustomer) {
                //     log.debug("Skipping - P/U order but LTL checkbox not checked", customerId);
                //     return;
                // }

                log.debug("P/U order with LTL customer - Script allowed", customerId);
            }


            // CASE 2: Non P/U Orders
            if (shipVia != '57733' && !allowedCustomers.includes(customerId)) {
                log.debug("Skipping - Non P/U order and customer not allowed", customerId);
                return;
            }

            log.debug("Script execution allowed", {
                shipVia: shipVia,
                customerId: customerId
            });

            var trackCount = newRec.getLineCount({
                sublistId: 'recmachcustrecord_jyswms_so_header'
            });

            log.debug('amazon - Line Count', trackCount);


            if (headerPickedQty == 0 && !isPackagesUpdated) {

                record.submitFields({
                    type: 'customrecord_order_fulfillment_details',
                    id: recordId,
                    values: {
                        custrecord_jyswms_total_pick_qty: trackCount
                    }
                });

            }


            var donttrigger = newRec.getValue('custrecord_jys_dont_trigger');

            if (itemFulfill) {
                return;
            }

            if (donttrigger) {
                return;
            }

            if (fulfillPartilly && !isApproved) {

                record.submitFields({
                    type: 'customrecord_order_fulfillment_details',
                    id: recordId,
                    values: {
                        custrecord_jyswms_approved: true
                    }
                });
                // return;
            }

            if (!isApproved) {
                return;
            }

           // log.error('Trigger Info', {
            //     recordId: recordId,
            //     isApproved: isApproved,
            //     itemFulfill: itemFulfill,
            //     salesOrderId: salesOrderId,
            //     totalSoQuantity: totalSoQuantity
            // });

            if (isApproved && !itemFulfill && salesOrderId) {
                //  if (isApproved && itemFulfill && salesOrderId) {


                var locationLookup = search.lookupFields({
                    type: search.Type.SALES_ORDER,
                    id: salesOrderId,
                    columns: ['location']
                });
                if (!locationId) {
                    locationId = locationLookup.location.length ? locationLookup.location[0].value : null;
                }
                // var weightLookup = search.lookupFields({
                //         type: search.Type.ITEM,
                //         id: salesOrderId,
                //         columns: ['location']
                //       });

                var trackingNumbers = [];
                var itemIdsInOrder = [];

                var quantityLineCount = newRec.getLineCount({ sublistId: 'recmachcustrecord_sales_order_header' });
                // NEW: Map to merge duplicate items
                var linesMap = {};
                var seenUniqueIds = {};
                var lines = [];
                var totalQuantity = 0;



                for (var i = 0; i < quantityLineCount; i++) {

                    var itemId = newRec.getSublistValue({
                        sublistId: 'recmachcustrecord_sales_order_header',
                        fieldId: 'custrecord_jyswms_item',
                        line: i
                    });

                    var uniqueId = newRec.getSublistValue({
                        sublistId: 'recmachcustrecord_sales_order_header',
                        fieldId: 'custrecord_jyswms_item_uniqueid',
                        line: i
                    });

                    var linePickedQty = Number(newRec.getSublistValue({
                        sublistId: 'recmachcustrecord_sales_order_header',
                        fieldId: 'custrecord_jyswms_item_picked_qty',
                        line: i
                    })) || 0;

                    lineLineLocation = Number(newRec.getSublistValue({
                        sublistId: 'recmachcustrecord_sales_order_header',
                        fieldId: 'custrecord_jyswms_item_so_line_loc',
                        line: i
                    })) || ""; //locationId

                    var binName = newRec.getSublistValue({
                        sublistId: 'recmachcustrecord_sales_order_header',
                        fieldId: 'custrecord_jyswms_item_picked_bin',
                        line: i
                    });


                    if (!uniqueId || !itemId || linePickedQty <= 0) continue;

                    if (seenUniqueIds[uniqueId]) continue;
                    seenUniqueIds[uniqueId] = true;

                    if (itemIdsInOrder.indexOf(itemId) === -1) {
                        itemIdsInOrder.push(itemId);
                    }

                    totalQuantity += linePickedQty;

                    if (linesMap[itemId]) {

                        linesMap[itemId].quantity += linePickedQty;

                        if (
                            binName &&
                            linesMap[itemId].bins.findIndex(function (b) {
                                return b.binId === binName;
                            }) === -1
                        ) {
                            linesMap[itemId].bins.push({ binId: binName });
                        }

                    } else {

                        linesMap[itemId] = {
                            selected: true,
                            itemId: itemId,
                            quantity: linePickedQty,
                            locationId: lineLineLocation,
                            bins: binName ? [{ binId: binName }] : []
                        };
                    }
                }
               // log.error('itemIdsInOrder', itemIdsInOrder);
                var itemName = '';
                if (itemIdsInOrder.length === 1) {
                    // get the item type from the array 
                    var itemTypeLookup = search.lookupFields({
                        type: search.Type.ITEM,
                        id: Number(itemIdsInOrder[0]),
                        columns: ['recordtype', "itemid"]
                    });
                    // log.error('itemTypeLookup', itemTypeLookup);
                    itemName = itemTypeLookup.itemid || '';
                    if (itemTypeLookup.recordtype === 'noninventoryitem') {
                        // transform the sales order to item fulfillment directly
                        var itemFulfillment = record.transform({
                            fromType: record.Type.SALES_ORDER,
                            fromId: salesOrderId,
                            toType: record.Type.ITEM_FULFILLMENT,
                            isDynamic: true
                        });
                        itemFulfillment.setValue({ fieldId: 'location', value: locationId });
                        var fulfillmentLineCount = itemFulfillment.getLineCount({ sublistId: 'item' });

                        for (var j = 0; j < fulfillmentLineCount; j++) {
                            itemFulfillment.selectLine({ sublistId: 'item', line: j });

                            var soItemId = itemFulfillment.getCurrentSublistValue({
                                sublistId: 'item',
                                fieldId: 'item'
                            });

                            // Only fulfill the item you processed earlier
                            if (Number(soItemId) === Number(itemIdsInOrder[0])) {

                                itemFulfillment.setCurrentSublistValue({
                                    sublistId: 'item',
                                    fieldId: 'itemreceive',
                                    value: true
                                });

                                itemFulfillment.setCurrentSublistValue({
                                    sublistId: 'item',
                                    fieldId: 'quantity',
                                    value: totalQuantity // or linePickedQty
                                });
                            }

                            itemFulfillment.commitLine({ sublistId: 'item' });
                        }
                        itemFulfillment.setValue({ fieldId: 'shipstatus', value: 'C' });
                        var fulfillmentId = itemFulfillment.save();
                        // log.error('Item Fulfillment Created for Non Inventory Item', fulfillmentId);
                    } else {
                        // log.error('Item is not Non Inventory Item', itemTypeLookup.recordtype);
                    }
                }
                if ((itemIdsInOrder.length === 1) && itemName.toLowerCase().includes('parts')) {
                    // log.error('Item is Parts - skipping fulfillment creation', itemName);
                    return;
                }
                lines = Object.values(linesMap);

                // record.submitFields({
                //             type: 'customrecord_order_fulfillment_details',
                //             id: recordId,
                //             values: {
                //                 custrecord_jyswms_total_pick_qty: totalQuantity
                //             }
                //         });


                // ✅ Validate totals
                if (headerPickedQty !== totalQuantity && singleIf) {

                    if (totalQuantity == totalSoQuantity) {

                        record.submitFields({
                            type: 'customrecord_order_fulfillment_details',
                            id: recordId,
                            values: {
                                custrecord_jyswms_total_pick_qty: totalQuantity
                            }
                        });

                    }
                    else {
                        record.submitFields({
                            type: 'customrecord_order_fulfillment_details',
                            id: recordId,
                            values: {
                                custrecord_jyswms_total_pick_qty: totalQuantity,
                                custrecord_jyswms_approved: false
                            }
                        });
                        if (totalQuantity < totalSoQuantity && !fulfillPartilly) {
                            return;
                        }
                    }
                }
                else {
                    record.submitFields({
                        type: 'customrecord_order_fulfillment_details',
                        id: recordId,
                        values: {
                            custrecord_jyswms_total_pick_qty: totalQuantity
                        }
                    });
                }

                // log.error("FINAL MERGED LINES", JSON.stringify(lines));



                // Step 2: Build a map of itemId => array of tracking numbers
                var trackingLineCount = newRec.getLineCount({ sublistId: 'recmachcustrecord_jyswms_so_header' });

                // skip creating the package if the tracking line count is 0

                trackingLineCount = 0; // updated by Vamshi to avoid creating packages

                // log.debug("trackingLineCount", trackingLineCount);

                var trackingMap = {}; // itemId => [tracking1, tracking2]

                var ssccCodes = [];

                // Step 3: Build trackingNumbers array in same order as lines
                for (var j = 0; j < trackingLineCount; j++) {

                    var trackingItemId = newRec.getSublistValue({
                        sublistId: 'recmachcustrecord_jyswms_so_header',
                        fieldId: 'custrecord_jyswms_track_item',
                        line: j
                    });

                    // log.debug("trackingItemId", trackingItemId);

                    var trackingNumber = newRec.getSublistValue({
                        sublistId: 'recmachcustrecord_jyswms_so_header',
                        fieldId: 'custrecord_jyswms_track_number',
                        line: j
                    });

                    ssccCodes.push(trackingNumber)
                    // log.debug("trackingNumber", trackingNumber);

                    // var weightLookup = search.lookupFields({
                    //   type: search.Type.INVENTORY_ITEM,
                    //   id: trackingItemId,
                    //   columns: ['weight']
                    // });
                    // var weight = weightLookup.weight.length ? weightLookup.weight : null;
                    // log.debug("weight", weight);


                    var trackingObj = {
                        trackingNumbers: trackingNumber,
                        item: trackingItemId
                    };

                    trackingNumbers.push(trackingObj);

                }

                // trackingNumbers.push(ssccCodes)



                // Step 4: Build final object
                var obj = {};

                obj[salesOrderId] = {
                    salesOrderId: salesOrderId,
                    lines: lines,
                    locationId: locationId || lineLineLocation,
                    trackingNumbers: trackingNumbers,
                    ssccCodes: ssccCodes
                };
                if (totalQuantity < totalSoQuantity && !fulfillPartilly) {
                    return;
                }
                // log.error('Fulfillment Object', JSON.stringify(obj));

                if (obj) {
                    // log.error("Entering object");
                    response = FullFillOrders(obj, context.newRecord.id, itemIdsInOrder);
                    // log.error('response', JSON.stringify(response));


                }


            }



            // log.error("response[salesOrderId].fulfillmentId",response);

            //  var suiteletUrl = url.resolveScript({
            //      scriptId: 'customscript_jy_load_submit_records',      // INTERNAL SCRIPT ID
            //      deploymentId: 'customdeploy_jy_load_submit_records',     // INTERNAL DEPLOYMENT ID
            //      params: {
            //          recordtype: recordType,
            //          recordid: recordId
            //      }
            //  });

            //  log.error("Suitelet URL", suiteletUrl);

            //  var slresponse = https.get({
            //      url: suiteletUrl
            //  });

            //  log.error("Suitelet Response", slresponse.body);


        } catch (e) {
            log.error('afterSubmit error', e);
        }
    }

    function issingleif(headerId, salesOrderId) {
        let isSingleIf = false;
        if (headerId && salesOrderId) {

            const salesorderSearchObj = search.create({
                type: "salesorder",
                filters: [
                    ["type", "anyof", "SalesOrd"],
                    "AND",
                    ["internalid", "anyof", salesOrderId],
                    "AND",
                    ["mainline", "is", "T"]
                ],
                columns: [
                    search.createColumn({
                        name: "custentity_single_if",
                        join: "customer"
                    })
                ]
            });

            salesorderSearchObj.run().each(function (result) {

                var singleIFValue = result.getValue({
                    name: "custentity_single_if",
                    join: "customer"
                });

                isSingleIf = singleIFValue === true || singleIFValue === 'T';

                return false; // Only one result expected
            });

            // log.error("Single IF Check", {
            //     headerId: headerId,
            //     salesOrderId: salesOrderId,
            //     isSingleIf: isSingleIf
            // });

        }
        return isSingleIf;
    }

    function FullFillOrders(jsonData, customRecId, itemIdsInOrder) {

        var results = {};
        var fulfillmentIds = [];

        for (var salesOrderKey in jsonData) {

            if (salesOrderKey === 'action') continue;

            try {

                var orderData = jsonData[salesOrderKey];
                var salesOrderId = orderData.salesOrderId;
                var locationId = orderData.locationId;

                var trackingObj = trackingLines(customRecId);
                var ssccCodes = orderData.ssccCodes;

                        // log.error("incoming Object - ", {
                        //     ssccCodes: ssccCodes,
                        //     trackingObj: trackingObj,
                        //     orderData: orderData,
                        //     locationId: locationId
                        // });

                var singleIf = issingleif(customRecId, salesOrderId);

                var soHeaderLocation = null;
                var singleIfDestinationBin = null;

                if (singleIf) {

                    var locationLookup = search.lookupFields({
                        type: search.Type.SALES_ORDER,
                        id: salesOrderId,
                        columns: ['location']
                    });

                    soHeaderLocation = locationLookup.location.length
                        ? locationLookup.location[0].value
                        : null;

                    if (!soHeaderLocation) {
                        throw new Error("SO Header Location not found for Single IF");
                    }

                    // 🔥 FIRST normalize inventory (transfer)
                    createInventoryTransferForSingleIF(orderData, soHeaderLocation, customRecId);

                    locationId = soHeaderLocation;

                    // 🔥 determine final staging bin
                    if (Number(soHeaderLocation) === 15) {
                        singleIfDestinationBin = 16692;
                    } else if (Number(soHeaderLocation) === 9) {
                        singleIfDestinationBin = 4859;
                    } else {
                        // log.error("Unsupported header location for Single IF: " + soHeaderLocation);
                    }

                    // log.audit("Single IF Mode", {
                    //     headerLocation: soHeaderLocation,
                    //     destinationBin: singleIfDestinationBin
                    // });
                }

                var itemFulfillment = record.transform({
                    fromType: record.Type.SALES_ORDER,
                    fromId: salesOrderId,
                    toType: record.Type.ITEM_FULFILLMENT,
                    isDynamic: true
                });

                itemFulfillment.setValue({ fieldId: 'trandate', value: new Date() });
                itemFulfillment.setValue({ fieldId: 'location', value: locationId });

                var itemsFulfilled = false;
                var itemMap = {};

                // Build itemMap
                for (var i = 0; i < orderData.lines.length; i++) {

                    var line = orderData.lines[i];
                    if (!line.selected) continue;

                    if (!itemMap[line.itemId]) {
                        itemMap[line.itemId] = {
                            total: 0,
                            locationId: line.locationId,
                            bins: line.bins || []
                        };
                    }

                    itemMap[line.itemId].total += parseFloat(line.quantity) || 0;
                }

                var itemAvailQty = getItemAvailableQtyMapByLocation(locationId, itemIdsInOrder);

                var adjustmentObj = {};

                for (var key in itemMap) {

                    var itemData = itemMap[key];
                    var availableQty = parseFloat(itemAvailQty[key] || 0);

                    if (availableQty < itemData.total) {
                        adjustmentObj[key] = itemData.total - availableQty;
                    }
                }
                // log.error("adjustmentObj", adjustmentObj)
                if (Object.keys(adjustmentObj).length > 0) {

                    //  var adjustmentId = createAdjustment(adjustmentObj, locationId);
                    var adjustmentId = createAdjustment(adjustmentObj, locationId, customRecId, salesOrderId);


                    record.submitFields({
                        type: 'customrecord_order_fulfillment_details',
                        id: customRecId,
                        values: {
                            custrecord_jyswms_inventory_adjustment: adjustmentId
                        }
                    });
                }

                var fulfillmentLineCount = itemFulfillment.getLineCount({ sublistId: 'item' });
                var soHeaderLocation = locationId;
                for (var j = 0; j < fulfillmentLineCount; j++) {

                    itemFulfillment.selectLine({ sublistId: 'item', line: j });

                    var itemIdInternal = itemFulfillment.getCurrentSublistValue({
                        sublistId: 'item',
                        fieldId: 'item'
                    });

                    if (!itemMap[itemIdInternal]) {
                        itemFulfillment.setCurrentSublistValue({
                            sublistId: 'item',
                            fieldId: 'itemreceive',
                            value: false
                        });

                        itemFulfillment.commitLine({ sublistId: 'item' });
                        continue;
                    }

                    var itemData = itemMap[itemIdInternal];

                    itemFulfillment.setCurrentSublistValue({
                        sublistId: 'item',
                        fieldId: 'itemreceive',
                        value: true
                    });

                    itemFulfillment.setCurrentSublistValue({
                        sublistId: 'item',
                        fieldId: 'quantity',
                        value: itemData.total
                    });

                    if (singleIf) {
                        // Force every line to header location
                        itemFulfillment.setCurrentSublistValue({
                            sublistId: 'item',
                            fieldId: 'location',
                            value: soHeaderLocation
                        });

                    } else {

                        if (itemData.locationId) {
                            itemFulfillment.setCurrentSublistValue({
                                sublistId: 'item',
                                fieldId: 'location',
                                value: itemData.locationId
                            });
                        }
                    }

                    var inventoryDetailSubrecord = itemFulfillment.getCurrentSublistSubrecord({
                        sublistId: 'item',
                        fieldId: 'inventorydetail',
                        create: true
                    });

                    var existingLines = inventoryDetailSubrecord.getLineCount({
                        sublistId: 'inventoryassignment'
                    });

                    for (var k = existingLines - 1; k >= 0; k--) {
                        inventoryDetailSubrecord.removeLine({
                            sublistId: 'inventoryassignment',
                            line: k
                        });
                    }

                    inventoryDetailSubrecord.selectNewLine({
                        sublistId: 'inventoryassignment'
                    });

                    var fulfillmentBin;

                    if (singleIf) {
                        fulfillmentBin = singleIfDestinationBin;
                    } else {
                        fulfillmentBin = (itemData.locationId == 9) ? 4859 : 16692;
                    }

                    inventoryDetailSubrecord.setCurrentSublistValue({
                        sublistId: 'inventoryassignment',
                        fieldId: 'binnumber',
                        value: fulfillmentBin
                    });

                    inventoryDetailSubrecord.setCurrentSublistValue({
                        sublistId: 'inventoryassignment',
                        fieldId: 'quantity',
                        value: itemData.total
                    });

                    inventoryDetailSubrecord.commitLine({
                        sublistId: 'inventoryassignment'
                    });

                    itemFulfillment.commitLine({ sublistId: 'item' });

                    itemsFulfilled = true;
                }

                if (!itemsFulfilled) {
                    throw new Error("No items selected for fulfillment.");
                }

                itemFulfillment.setValue({ fieldId: 'shipstatus', value: 'C' });

                var fulfillmentId = itemFulfillment.save();

                // 🔥 Lock related transfers
                var transferSearch = search.create({
                    type: record.Type.INVENTORY_TRANSFER,
                    filters: [
                        ["custbody_jyswms_order_fulfillment_id", "anyof", customRecId],
                        "AND",
                        ["mainline", "is", "T"]
                    ],
                    columns: ["internalid"]
                });

                transferSearch.run().each(function (result) {

                    record.submitFields({
                        type: record.Type.INVENTORY_TRANSFER,
                        id: result.getValue("internalid"),
                        values: {
                            custbody_jyswms_if_created: true,
                            memo: "Closed - IF Created"
                        }
                    });

                    return true;
                });

                fulfillmentIds.push(fulfillmentId);

                record.submitFields({
                    type: 'customrecord_order_fulfillment_details',
                    id: customRecId,
                    values: {
                        custrecord_jyswms_rel_item_ful: fulfillmentId,
                        custrecord_jyswms_status: 3,
                        custrecord_jyswms_error: ''
                    }
                });

                results[salesOrderId] = {
                    salesOrderId: salesOrderId,
                    success: true,
                    fulfillmentId: fulfillmentId
                };

            } catch (e) {

                record.submitFields({
                    type: 'customrecord_order_fulfillment_details',
                    id: customRecId,
                    values: {
                        custrecord_jyswms_error: e.message,
                        custrecord_jyswms_approved: false
                    }
                });

                results[salesOrderKey] = {
                    salesOrderId: salesOrderKey,
                    success: false,
                    Error_Message: e.message
                };

                log.error("Unexpected error in FullFillOrders", e);
            }
        }

        return results;
    }

    //   function createAdjustment(adjustmentObj, locationId) {
    function createAdjustment(adjustmentObj, locationId, headerID, salesOrderId) {
        try {
            if (!adjustmentObj || Object.keys(adjustmentObj).length === 0) {
               // log.error("No adjustments required");
                return null;
            }

            var binId = (locationId == 9) ? 4859 : 16692;

            var inventoryAdjRec = record.create({
                type: record.Type.INVENTORY_ADJUSTMENT,
                isDynamic: true
            });

            // Header values
            inventoryAdjRec.setValue({ fieldId: 'subsidiary', value: 1 });
            inventoryAdjRec.setValue({ fieldId: 'adjlocation', value: locationId });
            inventoryAdjRec.setValue({ fieldId: 'account', value: 464 });
            inventoryAdjRec.setValue({ fieldId: 'memo', value: 'Auto Positive Adjustment due to Bulk bin shortage for JYSWMS Order Fulfilment Details, ID ' });
            inventoryAdjRec.setValue({ fieldId: 'custbody_jyswms_excess_items', value: adjustmentObj });
            inventoryAdjRec.setValue({ fieldId: 'custbody_wms_ai_created_by', value: true });
            inventoryAdjRec.setValue({ fieldId: 'custbody_realted_jyorder', value: headerID });
            inventoryAdjRec.setValue({ fieldId: 'custbody_realted_sales_order', value: salesOrderId });



            // Loop through shortage items
            for (var itemId in adjustmentObj) {

                var adjustQty = parseFloat(adjustmentObj[itemId]);
                if (!adjustQty || adjustQty <= 0) continue;

                inventoryAdjRec.selectNewLine({ sublistId: 'inventory' });

                inventoryAdjRec.setCurrentSublistValue({
                    sublistId: 'inventory',
                    fieldId: 'item',
                    value: itemId
                });

                inventoryAdjRec.setCurrentSublistValue({
                    sublistId: 'inventory',
                    fieldId: 'location',
                    value: locationId
                });

                inventoryAdjRec.setCurrentSublistValue({
                    sublistId: 'inventory',
                    fieldId: 'adjustqtyby',
                    value: adjustQty   // positive adjustment
                });

                // Check if item requires bin
                var itemLookup = search.lookupFields({
                    type: search.Type.ITEM,
                    id: itemId,
                    columns: ['usebins', 'recordtype']
                });

                var useBins =
                    itemLookup.usebins === true ||
                    itemLookup.usebins === 'T';

                var isInventoryItem =
                    ['inventoryitem', 'serializedinventoryitem', 'lotnumberedinventoryitem']
                        .includes(itemLookup.recordtype);

                if (useBins && isInventoryItem && binId) {

                    var invDetail = inventoryAdjRec.getCurrentSublistSubrecord({
                        sublistId: 'inventory',
                        fieldId: 'inventorydetail'
                    });

                    // Clear existing lines
                    var lineCount = invDetail.getLineCount({ sublistId: 'inventoryassignment' });
                    for (var i = lineCount - 1; i >= 0; i--) {
                        invDetail.removeLine({ sublistId: 'inventoryassignment', line: i });
                    }

                    // Add new assignment
                    invDetail.selectNewLine({ sublistId: 'inventoryassignment' });

                    invDetail.setCurrentSublistValue({
                        sublistId: 'inventoryassignment',
                        fieldId: 'binnumber',
                        value: binId
                    });

                    invDetail.setCurrentSublistValue({
                        sublistId: 'inventoryassignment',
                        fieldId: 'quantity',
                        value: adjustQty
                    });

                    invDetail.commitLine({ sublistId: 'inventoryassignment' });

                    log.audit('Bin Assignment Added', {
                        itemId: itemId,
                        binId: binId,
                        qty: adjustQty
                    });
                }

                inventoryAdjRec.commitLine({ sublistId: 'inventory' });
            }

            var invAdjId = inventoryAdjRec.save({
                enableSourcing: true,
                ignoreMandatoryFields: false
            });

            log.audit(" Inventory Adjustment Created", invAdjId);

            return invAdjId;

        } catch (e) {
            log.error("❌ Error creating adjustment", e.name + " : " + e);
            return null;
        }
    }

    // ===============================
    // SINGLE IF INVENTORY TRANSFER
    // ===============================
    function createInventoryTransferForSingleIF(orderData, soHeaderLocation, customRecId) {

        try {

            if (!customRecId) {
                throw new Error("customRecId is missing in createInventoryTransferForSingleIF");
            }

            var salesOrderId = orderData.salesOrderId;

            // =====================================================
            // 🔒 DO NOT TRANSFER IF IF ALREADY EXISTS
            // =====================================================

            var headerRec = record.load({
                type: 'customrecord_order_fulfillment_details',
                id: customRecId
            });

            var existingIF = headerRec.getValue('custrecord_jyswms_rel_item_ful');

            if (existingIF) {
                log.audit("Transfer Skipped", "Item Fulfillment already exists.");
                return;
            }

            // =====================================================
            // 🔥 BUILD TRANSFER MAP (ONLY DIFFERENT LOCATIONS)
            // =====================================================

            var transferMap = {};

            orderData.lines.forEach(function (line) {

                if (!line.selected) return;

                // If line location empty → use header location
                var normalizedLineLocation = line.locationId
                    ? String(line.locationId)
                    : String(soHeaderLocation);

                // Only transfer if different from header location
                if (normalizedLineLocation === String(soHeaderLocation)) {
                    return;
                }

                if (!transferMap[normalizedLineLocation]) {
                    transferMap[normalizedLineLocation] = [];
                }

                transferMap[normalizedLineLocation].push({
                    itemId: line.itemId,
                    quantity: parseFloat(line.quantity) || 0,
                    sourceBinId: (line.bins && line.bins.length)
                        ? line.bins[0].binId
                        : null
                });

            });

            if (Object.keys(transferMap).length === 0) {
                // log.audit("Single IF Transfer", "No transfers required");
                return;
            }

            // =====================================================
            // 🔄 PROCESS EACH SOURCE LOCATION
            // =====================================================

            for (var fromLocation in transferMap) {

                var toLocation = String(soHeaderLocation);
                var destinationBin = null;

                if (Number(fromLocation) === 9 && Number(toLocation) === 15) {
                    destinationBin = 16692;
                } else if (Number(fromLocation) === 15 && Number(toLocation) === 9) {
                    destinationBin = 4859;
                } else {
                    throw new Error("Unsupported transfer direction: "
                        + fromLocation + " → " + toLocation);
                }

                // =====================================================
                // 🔎 FIND EXISTING TRANSFER
                // =====================================================

                var existingTransferId = null;

                var transferSearch = search.create({
                    type: record.Type.INVENTORY_TRANSFER,
                    filters: [
                        ["custbody_realted_sales_order", "anyof", salesOrderId],
                        "AND",
                        ["custbody_jyswms_order_fulfillment_id", "anyof", customRecId],
                        "AND",
                        ["mainline", "is", "T"],
                        "AND",
                        ["location", "anyof", fromLocation],
                        "AND",
                        ["transferlocation", "anyof", toLocation]
                    ],
                    columns: ["internalid"]
                });

                transferSearch.run().each(function (result) {
                    existingTransferId = result.getValue("internalid");
                    return false;
                });

                var transferRec;

                if (existingTransferId) {

                  //  log.audit("Using Existing Transfer", existingTransferId);

                    transferRec = record.load({
                        type: record.Type.INVENTORY_TRANSFER,
                        id: existingTransferId,
                        isDynamic: true
                    });

                } else {

                  //  log.audit("Creating New Transfer", salesOrderId);

                    transferRec = record.create({
                        type: record.Type.INVENTORY_TRANSFER,
                        isDynamic: true
                    });

                    transferRec.setValue({
                        fieldId: 'location',
                        value: fromLocation
                    });

                    transferRec.setValue({
                        fieldId: 'transferlocation',
                        value: toLocation
                    });

                    transferRec.setValue({
                        fieldId: 'custbody_realted_sales_order',
                        value: salesOrderId
                    });

                    transferRec.setValue({
                        fieldId: 'custbody_jyswms_order_fulfillment_id',
                        value: customRecId
                    });

                    transferRec.setValue({
                        fieldId: 'memo',
                        value: 'Auto Transfer for Single IF normalization'
                    });
                }

                // =====================================================
                // SAFE ADD / UPDATE LINES (NO OVER TRANSFER)
                // =====================================================

                transferMap[fromLocation].forEach(function (item) {

                    if (!item.sourceBinId) {
                        throw new Error("Missing source bin for item " + item.itemId);
                    }

                    var requiredQty = item.quantity;
                    var lineCount = transferRec.getLineCount({ sublistId: 'inventory' });

                    var existingLineIndex = -1;
                    var existingQty = 0;

                    for (var i = 0; i < lineCount; i++) {

                        var existingItem = transferRec.getSublistValue({
                            sublistId: 'inventory',
                            fieldId: 'item',
                            line: i
                        });

                        if (Number(existingItem) === Number(item.itemId)) {

                            existingLineIndex = i;

                            existingQty = parseFloat(
                                transferRec.getSublistValue({
                                    sublistId: 'inventory',
                                    fieldId: 'adjustqtyby',
                                    line: i
                                }) || 0
                            );

                            break;
                        }
                    }

                    if (existingLineIndex !== -1) {

                        if (requiredQty > existingQty) {

                            transferRec.selectLine({
                                sublistId: 'inventory',
                                line: existingLineIndex
                            });

                            transferRec.setCurrentSublistValue({
                                sublistId: 'inventory',
                                fieldId: 'adjustqtyby',
                                value: requiredQty
                            });

                            transferRec.commitLine({ sublistId: 'inventory' });

                            log.audit("Transfer Qty Updated", {
                                item: item.itemId,
                                newQty: requiredQty
                            });
                        }

                    } else {

                        transferRec.selectNewLine({ sublistId: 'inventory' });

                        transferRec.setCurrentSublistValue({
                            sublistId: 'inventory',
                            fieldId: 'item',
                            value: item.itemId
                        });

                        transferRec.setCurrentSublistValue({
                            sublistId: 'inventory',
                            fieldId: 'adjustqtyby',
                            value: requiredQty
                        });

                        var invDetail = transferRec.getCurrentSublistSubrecord({
                            sublistId: 'inventory',
                            fieldId: 'inventorydetail'
                        });

                        invDetail.selectNewLine({
                            sublistId: 'inventoryassignment'
                        });

                        invDetail.setCurrentSublistValue({
                            sublistId: 'inventoryassignment',
                            fieldId: 'binnumber',
                            value: item.sourceBinId
                        });

                        invDetail.setCurrentSublistValue({
                            sublistId: 'inventoryassignment',
                            fieldId: 'tobinnumber',
                            value: destinationBin
                        });

                        invDetail.setCurrentSublistValue({
                            sublistId: 'inventoryassignment',
                            fieldId: 'quantity',
                            value: requiredQty
                        });

                        invDetail.commitLine({
                            sublistId: 'inventoryassignment'
                        });

                        transferRec.commitLine({
                            sublistId: 'inventory'
                        });
                    }

                });

                var transferId = transferRec.save({
                    enableSourcing: true,
                    ignoreMandatoryFields: false
                });

                log.audit("Transfer Saved", transferId);
            }

        } catch (e) {
            log.error("Single IF Transfer Error", e);
            throw e;
        }
    }


    function getItemAvailableQtyMapByLocation(locationId, itemIdsInOrder) {

        var itemQtyMap = {};

        var filters = [
            ["binonhand.quantityonhand", "greaterthan", "0"],
            "AND",
            ["binonhand.location", "anyof", locationId],
            "AND",
            ["binonhand.binnumber", "anyof", "16692", "4859"]
        ];

        //  Apply item filter only if itemIdsInOrder exists and is not empty
        if (itemIdsInOrder && Array.isArray(itemIdsInOrder) && itemIdsInOrder.length > 0) {
            filters.push("AND");
            filters.push(["internalid", "anyof"].concat(itemIdsInOrder));
        }

        var itemSearchObj = search.create({
            type: "item",
            filters: filters,
            columns: [
                search.createColumn({ name: "internalid" }),
                search.createColumn({
                    name: "quantityavailable",
                    join: "binOnHand",
                    label: "available"
                })
            ]
        });

        var pagedData = itemSearchObj.runPaged({
            pageSize: 1000
        });

        log.debug("Total records", pagedData.count);

        pagedData.pageRanges.forEach(function (pageRange) {

            var page = pagedData.fetch({ index: pageRange.index });

            page.data.forEach(function (result) {

                var internalId = result.getValue({ name: "internalid" });

                var availableQty = result.getValue({
                    name: "quantityavailable",
                    join: "binOnHand"
                });

                if (!itemQtyMap[internalId]) {
                    itemQtyMap[internalId] = 0;
                }

                itemQtyMap[internalId] += parseFloat(availableQty || 0);
            });
        });
       // log.error("itemQtyMap", itemQtyMap)
        return itemQtyMap;
    }

    function trackingLines(id) {
        try {
            var headerID = id;

            var trackingSearch = search.create({
                type: "customrecord_jyswms_sales_order_track",
                filters: [
                    ["custrecord_jyswms_track_so_id.mainline", "is", "T"],
                    "AND",
                    ["custrecord_jyswms_so_header", "anyof", headerID]
                ],
                columns: [
                    search.createColumn({ name: "custrecord_jyswms_track_item", label: "Item" }),
                    search.createColumn({ name: "custrecord_jyswms_track_number", label: "Tracking Number" }),
                    search.createColumn({ name: "custrecord_jyswms_track_so_id", label: "Sales Order #" }),
                    search.createColumn({ name: "custrecord_jyswms_so_header", label: "Sales Order Header" }),
                    search.createColumn({ name: "custrecord_jyswms_track_qty", label: "Tracking Qty" }),
                    search.createColumn({ name: "custrecord_jyswms_track_uniqueid", label: "Unique ID" }),
                    search.createColumn({ name: "weight", join: "CUSTRECORD_JYSWMS_TRACK_ITEM", label: "Weight" }),
                    search.createColumn({ name: "upccode", join: "CUSTRECORD_JYSWMS_TRACK_ITEM", label: "UPC Code" }),
                    search.createColumn({ name: "otherrefnum", join: "CUSTRECORD_JYSWMS_TRACK_SO_ID", label: "PO/Check Number" })
                ]
            });

            var results = [];
            trackingSearch.run().each(function (result) {
                var obj = {
                    item: result.getValue({ name: 'custrecord_jyswms_track_item' }),
                    itemId: result.getText({ name: 'custrecord_jyswms_track_item' }),
                    trackingNumber: result.getValue({ name: 'custrecord_jyswms_track_number' }),
                    salesOrder: result.getText({ name: 'custrecord_jyswms_track_so_id' }) || result.getValue({ name: 'custrecord_jyswms_track_so_id' }),
                    soHeader: result.getValue({ name: 'custrecord_jyswms_so_header' }),
                    qty: result.getValue({ name: 'custrecord_jyswms_track_qty' }),
                    uniqueId: result.getValue({ name: 'custrecord_jyswms_track_uniqueid' }),
                    weight: result.getValue({ name: 'weight', join: 'CUSTRECORD_JYSWMS_TRACK_ITEM' }),
                    upcCode: result.getValue({ name: 'upccode', join: 'CUSTRECORD_JYSWMS_TRACK_ITEM' }),
                    poNumber: result.getValue({ name: 'otherrefnum', join: 'CUSTRECORD_JYSWMS_TRACK_SO_ID' })
                };
                results.push(obj);
                return true; // continue iteration
            });

            log.audit('Tracking Object', JSON.stringify(results));
            return results;

        } catch (error) {
            log.error("Error message", error);
        }

    }

    function getInternalIdsBySsccCodes(ssccCodes) {
        try {
            if (!ssccCodes || !ssccCodes.length) {
                log.debug('No SSCC Codes', 'The ssccCodes array is empty.');
                return [];
            }

          //  log.error("ssccCodes", ssccCodes);

            // Build dynamic OR filter for all SSCC codes
            var filters = [];
            for (var i = 0; i < ssccCodes.length; i++) {
                if (i > 0) filters.push('OR');
                filters.push(['custrecordhj_ucc', 'is', ssccCodes[i]]);
            }

            // Create and run search
            var pkgSearch = search.create({
                type: 'customrecordhj_tc_package_contents',
                filters: filters,
                columns: ['internalid']
            });

            var internalIds = [];
            pkgSearch.run().each(function (result) {
                internalIds.push(result.getValue({ name: 'internalid' }));
                return true;
            });

           // log.error('Matched Internal IDs', internalIds);
            return internalIds;

        } catch (e) {
            log.error('Error in getInternalIdsBySsccCodes', e);
            return [];
        }
    }


    function beforeSubmit(context) {
        try {

            if (context.type === context.UserEventType.CREATE ||
                context.type === context.UserEventType.EDIT) {

                var rec = context.newRecord;

                var soId = rec.getValue({
                    fieldId: 'custrecord_jyswms_so_id'
                });

                var itemfulfillmentId = rec.getValue({
                    fieldId: 'custrecord_jyswms_rel_item_ful'
                });
                var approved = rec.getValue({
                    fieldId: 'custrecord_jyswms_approved'
                });
                if (!itemfulfillmentId && !approved) {
                    var linecount = rec.getLineCount({
                        sublistId: 'recmachcustrecord_jyswms_so_header'
                    });

                    rec.setValue({
                        fieldId: 'custrecord_jyswms_total_pick_qty',
                        value: linecount
                    });
                }

            }

        } catch (error) {
            log.error({
                title: "Error in beforeSubmit",
                details: error
            });
        }
    }

    return {
        afterSubmit: afterSubmit,
        beforeSubmit: beforeSubmit
    };
});