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
            var salesOrderId = newRec.getValue({ fieldId: 'custrecord_jyswms_sales_order_id' });
            var headerPickedQty = newRec.getValue({ fieldId: 'custrecord_jyswms_total_pick_qty' });
            var totalSoQuantity = newRec.getValue({ fieldId: 'custrecord_jyswms_total_so_qty' });
            var fulfillPartilly = newRec.getValue({ fieldId: 'custrecord_jyswms_is_partially_fulfilled' });
            var locationId = newRec.getValue({ fieldId: 'custrecord_jyswms_location_id' }) || "";
            var lineLineLocation = locationId;
            var singleIf = newRec.getValue({ fieldId: 'custrecord_jywms_single_if_from_customer' });
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



            if (headerPickedQty < totalSoQuantity && !fulfillPartilly) {
                return;
            }

            if (!isApproved) {
                return;
            }

            log.error('Trigger Info', {
                recordId: recordId,
                isApproved: isApproved,
                itemFulfill: itemFulfill,
                salesOrderId: salesOrderId,
                totalSoQuantity: totalSoQuantity
            });

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
                log.error('itemIdsInOrder', itemIdsInOrder);
                var itemName = '';
                if (itemIdsInOrder.length === 1) {
                    // get the item type from the array 
                    var itemTypeLookup = search.lookupFields({
                        type: search.Type.ITEM,
                        id: Number(itemIdsInOrder[0]),
                        columns: ['recordtype', "itemid"]
                    });
                    log.error('itemTypeLookup', itemTypeLookup);
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
                        log.error('Item Fulfillment Created for Non Inventory Item', fulfillmentId);
                    } else {
                        log.error('Item is not Non Inventory Item', itemTypeLookup.recordtype);
                    }
                }
                if ((itemIdsInOrder.length === 1) && itemName.toLowerCase().includes('parts')) {
                    log.error('Item is Parts - skipping fulfillment creation', itemName);
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
                if (headerPickedQty !== totalQuantity && singleIf ) {

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

                        return;
                    }
                }
              else{
                  record.submitFields({
                            type: 'customrecord_order_fulfillment_details',
                            id: recordId,
                            values: {
                                custrecord_jyswms_total_pick_qty: totalQuantity
                            }
                        });
              }

                log.error("FINAL MERGED LINES", JSON.stringify(lines));



                // Step 2: Build a map of itemId => array of tracking numbers
                var trackingLineCount = newRec.getLineCount({ sublistId: 'recmachcustrecord_jyswms_so_header' });

                // skip creating the package if the tracking line count is 0

                trackingLineCount = 0; // updated by Vamshi to avoid creating packages

                log.debug("trackingLineCount", trackingLineCount);

                var trackingMap = {}; // itemId => [tracking1, tracking2]

                var ssccCodes = [];

                // Step 3: Build trackingNumbers array in same order as lines
                for (var j = 0; j < trackingLineCount; j++) {

                    var trackingItemId = newRec.getSublistValue({
                        sublistId: 'recmachcustrecord_jyswms_so_header',
                        fieldId: 'custrecord_jyswms_track_item',
                        line: j
                    });

                    log.debug("trackingItemId", trackingItemId);

                    var trackingNumber = newRec.getSublistValue({
                        sublistId: 'recmachcustrecord_jyswms_so_header',
                        fieldId: 'custrecord_jyswms_track_number',
                        line: j
                    });

                    ssccCodes.push(trackingNumber)
                    log.debug("trackingNumber", trackingNumber);

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

                log.error('Fulfillment Object', JSON.stringify(obj));

                if (obj) {
                    // log.error("Entering object");
                    response = FullFillOrders(obj, context.newRecord.id, itemIdsInOrder);
                    log.error('response', JSON.stringify(response));


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
            log.error('afterSubmit error', e.message);
        }
    }

    function FullFillOrders(jsonData, customRecId, itemIdsInOrder) {
        var results = {};
        var fulfillmentIds = [];

        for (var salesOrderKey in jsonData) {
            if (salesOrderKey === 'action') continue;

            try {


                var orderData = jsonData[salesOrderKey]; // orderdata has lines, tracking nums, and sales order id
                //log.error("orderData", orderData);
                var trackingObj = trackingLines(customRecId); // your array of items
                var ssccCodes = orderData.ssccCodes;
                var itemIdsInOrder = itemIdsInOrder;
                var locationId = orderData.locationId;

                // var itemAvailQty = getItemAvailableQtyMapByLocation(locationId, itemIdsInOrder)
                log.error("incoming Object - ", {
                    ssccCodes: ssccCodes,
                    trackingObj: trackingObj,
                    orderData: orderData,
                    locationId: locationId
                });
                //  log.error("trackingObj", trackingObj);
                var salesOrderId = orderData.salesOrderId;


                var bulkStageBin// = (line.locationId == 9) ? 4859 : 16692;
                // log.error({ title: 'bulkStageBin', details: bulkStageBin });




                var itemFulfillment = record.transform({
                    fromType: record.Type.SALES_ORDER,
                    fromId: salesOrderId,
                    toType: record.Type.ITEM_FULFILLMENT,
                    isDynamic: true
                });
                // itemFulfillment.setValue({ fieldId: 'location', value: locationId });

                // Set mandatory values
                itemFulfillment.setValue({ fieldId: 'trandate', value: new Date() });


                var itemsFulfilled = false;
                var itemMap = {};

                //  itemMap (aggregate qty + bins by itemId)
                for (var i = 0; i < orderData.lines.length; i++) {

                    var line = orderData.lines[i];
                    if (!line.selected) continue;

                    //  locationId = line.locationId;

                    if (!itemMap[line.itemId]) {
                        itemMap[line.itemId] = {
                            total: 0,
                            bins: []
                        };
                    }

                    // bulkStageBin = (line.locationId == 9) ? 4859 : 16692;
                    if (line.locationId) {
                        log.error("(line.locationId", line.locationId);
                        itemFulfillment.setValue({ fieldId: 'location', value: line.locationId });

                    }

                    itemMap[line.itemId].total += parseFloat(line.quantity) || 0;
                    itemMap[line.itemId].locationId = line.locationId || locationId;

                    itemMap[line.itemId].bins.push({
                        binId: line.binId,
                        qty: parseFloat(line.quantity) || 0,
                        locationId: line.locationId || locationId
                    });

                }


                if (!locationId || locationId == "" || locationId == " " || locationId == "0") {

                    log.error("no locaton - id", locationId);
                    var locationLookup = search.lookupFields({
                        type: search.Type.SALES_ORDER,
                        id: salesOrderId,
                        columns: ['location']
                    });

                    locationId = locationLookup.location.length ? locationLookup.location[0].value : null;
                }
                try {
                    log.error("itemMap", locationId);
                    var itemAvailQty = getItemAvailableQtyMapByLocation(locationId, itemIdsInOrder);

                } catch (error) {
                    log.error("itemAvailQty - error", error.message);
                }
                // //log.error("itemMap", {itemMap:itemMap,});
                // var itemAvailQty = getItemAvailableQtyMapByLocation(locationId, itemIdsInOrder);

                log.error("object -- ", { itemMap: itemMap, itemAvailQty: itemAvailQty });
                var adjustmentObj = {};
                for (key in itemMap) {
                    var itemId = key;
                    var itemData = itemMap[key];
                    var availableBulkBinQunatity = parseFloat(itemAvailQty[itemId] || 0);

                    var fullfillmentQty = itemData.total;

                    if (availableBulkBinQunatity < fullfillmentQty) {
                        adjustmentObj[itemId] = fullfillmentQty - availableBulkBinQunatity
                    }
                }
                log.error("adjustmentObj -- ", adjustmentObj);

                if (Object.keys(adjustmentObj).length > 0) {

                    var response = createAdjustment(adjustmentObj, locationId);
                    log.error("Inventory Adjustment Response", response);

                    //inventoryAdjRec.setValue({ fieldId: 'memo', value: 'Auto Positive Adjustment due to Bulk bin shortage for JYSWMS Order Fulfilment Details, ID ' });

                    record.submitFields({
                        type: record.Type.INVENTORY_ADJUSTMENT,
                        id: response,
                        values: {
                            memo: 'Auto Positive Adjustment due to Bulk bin shortage for JYSWMS Order Fulfilment Details, ID : ' + customRecId
                        }
                    });

                    record.submitFields({
                        type: 'customrecord_order_fulfillment_details',
                        id: customRecId,
                        values: {
                            custrecord_jyswms_inventory_adjustment: response
                        }
                    });


                }

                var fulfillmentLineCount = itemFulfillment.getLineCount({ sublistId: 'item' });

                // log.error("fulfillmentLineCount", fulfillmentLineCount);

                for (var j = 0; j < fulfillmentLineCount; j++) {

                    itemFulfillment.selectLine({ sublistId: 'item', line: j });

                    var itemIdInternal = itemFulfillment.getCurrentSublistValue({
                        sublistId: 'item',
                        fieldId: 'item'
                    });


                    if (itemMap[itemIdInternal]) {
                        var itemData = itemMap[itemIdInternal];


                        //  Set quantity
                        itemFulfillment.setCurrentSublistValue({
                            sublistId: 'item',
                            fieldId: 'quantity',
                            value: itemData.total
                        });


                        try {

                            if (itemData.locationId || itemData.bins[0].locationId) {
                                itemFulfillment.setCurrentSublistValue({
                                    sublistId: 'item',
                                    fieldId: 'location',
                                    value: itemData.bins[0].locationId || itemData.locationId
                                });
                            }
                            // Set location

                            // log.error({ title: 'itemData.bins[0].locationId', details: itemData.bins[0].locationId });
                        } catch (e) {
                            log.error("Error setting location", e.message);
                        }


                        bulkStageBin = (itemData.bins[0].locationId == 9) ? 4859 : 16692;
                        //log.error({ title: 'bulkStageBin', details: bulkStageBin });








                        var inventoryDetailSubrecord = itemFulfillment.getCurrentSublistSubrecord({
                            sublistId: 'item',
                            fieldId: 'inventorydetail',
                            create: true
                        });

                        if (!inventoryDetailSubrecord) {
                            throw new Error(' Unable to create Inventory Detail Subrecord on line ' + j);
                        }

                        // log.error("InventoryDetailSubrecord Created", inventoryDetailSubrecord);

                        // Loop through all bins
                        //  for (var b = 0; b < itemData.bins.length; b++) {
                        // var binLine = itemData.bins[b];
                        // if (binLine.qty <= 0) continue;
                        // Remove any existing lines to prevent double-counting


                        var existingLines = inventoryDetailSubrecord.getLineCount({ sublistId: 'inventoryassignment' });
                        for (var k = existingLines - 1; k >= 0; k--) {
                            inventoryDetailSubrecord.removeLine({ sublistId: 'inventoryassignment', line: k });
                        }

                        inventoryDetailSubrecord.selectNewLine({ sublistId: 'inventoryassignment' });

                        inventoryDetailSubrecord.setCurrentSublistValue({
                            sublistId: 'inventoryassignment',
                            fieldId: 'binnumber',
                            value: bulkStageBin  // Use the first bin directly binLine.binId
                        });

                        var lineQuantity = itemFulfillment.getCurrentSublistValue({
                            sublistId: 'item',
                            fieldId: 'quantity'
                        });

                        var availQuantity = inventoryDetailSubrecord.getCurrentSublistValue({
                            sublistId: 'inventoryassignment',
                            fieldId: 'available'
                        });

                        // log.error('Single Bin Assignment values ', {
                        //     binId: itemData.bins[0].binId,
                        //     qty: lineQuantity,
                        //     availQuantity: availQuantity
                        // });

                        inventoryDetailSubrecord.setCurrentSublistValue({
                            sublistId: 'inventoryassignment',
                            fieldId: 'quantity',
                            value: lineQuantity  // Assign full quantity directly binLine.qty
                        });

                        inventoryDetailSubrecord.commitLine({ sublistId: 'inventoryassignment' });
                        //  Retrieve last committed line values
                        var lineCount = inventoryDetailSubrecord.getLineCount({
                            sublistId: 'inventoryassignment'
                        });

                        var assignedQty = inventoryDetailSubrecord.getSublistValue({
                            sublistId: 'inventoryassignment',
                            fieldId: 'quantity',
                            line: lineCount - 1
                        });

                        var assignedBin = inventoryDetailSubrecord.getSublistValue({
                            sublistId: 'inventoryassignment',
                            fieldId: 'binnumber',
                            line: lineCount - 1
                        });

                        // log.debug('Bin Assignment Verified', {
                        //     binId: assignedBin,
                        //     qty: assignedQty
                        // });
                        itemFulfillment.commitLine({ sublistId: 'item' });

                        // }
                        //}

                        // Commit the item line after everything is done
                        // itemFulfillment.commitLine({ sublistId: 'item' });
                        // log.debug('Complete', {
                        //     binId: itemData.bins[0].binId,
                        //     qty: lineQuantity
                        // });
                        itemsFulfilled = true;
                    }
                }


                if (!itemsFulfilled) {
                    results[salesOrderId] = {
                        salesOrderId: salesOrderId,
                        success: false,
                        message: 'No items were selected or matched for fulfillment.'
                    };
                    continue;
                }

                try {
                    itemFulfillment.setValue({ fieldId: 'shipstatus', value: 'C' });
                } catch (e) {
                    log.error("Error setting ship status", e.message);
                }

                var fulfillmentId = itemFulfillment.save();
                fulfillmentIds.push(fulfillmentId);





                log.debug({ title: 'Item Fulfillment Created', details: `Fulfillment ID: ${fulfillmentId}` });


                results[salesOrderId] = {
                    salesOrderId: salesOrderId,
                    success: true,
                    fulfillmentId: fulfillmentId
                };

                record.submitFields({
                    type: 'customrecord_order_fulfillment_details',
                    id: customRecId,
                    values: {
                        custrecord_jyswms_rel_item_ful: fulfillmentId,
                        custrecord_jyswms_status: 3,
                        custrecord_jyswms_error: ''
                    }
                });


            } catch (e) {
                record.submitFields({
                    type: 'customrecord_order_fulfillment_details',
                    id: customRecId,
                    values: {
                        custrecord_jyswms_error: e.message,
                        custrecord_jyswms_approved: false
                    }
                });

                results[salesOrderId] = {
                    salesOrderId: salesOrderId,
                    success: false,
                    Error_Message: e.message
                };

                log.error("Unexpected error in FullFillOrders", e.message);
            }
        }
        return results;
    }

    function createAdjustment(adjustmentObj, locationId) {
        try {
            if (!adjustmentObj || Object.keys(adjustmentObj).length === 0) {
                log.error("No adjustments required");
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
            log.error("❌ Error creating adjustment", e.name + " : " + e.message);
            return null;
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
            log.error("Error message", error.message);
        }

    }

    function getInternalIdsBySsccCodes(ssccCodes) {
        try {
            if (!ssccCodes || !ssccCodes.length) {
                log.debug('No SSCC Codes', 'The ssccCodes array is empty.');
                return [];
            }

            log.error("ssccCodes", ssccCodes);

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

            log.error('Matched Internal IDs', internalIds);
            return internalIds;

        } catch (e) {
            log.error('Error in getInternalIdsBySsccCodes', e);
            return [];
        }
    }


    return {
        afterSubmit: afterSubmit
    };
});
