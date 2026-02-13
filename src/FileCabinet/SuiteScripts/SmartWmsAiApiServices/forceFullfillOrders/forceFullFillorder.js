/**
 * @NApiVersion 2.x
 * @NModuleScope Public
 */
define(['N/record', 'N/search', 'N/log', 'N/https', 'N/runtime','../JYSWMS_generateToken_API'], function (record, search, log, https, runtime, generateTokenAPI) {


    function fullFillOrder(salesOrderId) {
      //  log.error("fullFillOrder triggered for SO ID", salesOrderId);
        var orderData = sendData(salesOrderId);
      //  log.error("orderData", orderData);
        var transformed = transformItems(orderData);
       // log.error("transformed", transformed);

     // return transformed;
        var orderByLocation = transformed.output;
        var itemIds = transformed.itemIds || [];

    
        //var locationId = Object.keys(orderDataObject)[0]; // Assuming one location per order as per original logic
      
        for (var locationId in orderByLocation) {

            if (!orderByLocation.hasOwnProperty(locationId)) continue;

            var orderDataObject = orderByLocation[locationId];
            // do something with key & value
        //   log.error("orderDataObject", orderDataObject);

            var itemAvailQty = getItemAvailableQtyMapByLocation(itemIds, locationId);

          var adjustmentObj = {};

            for (key in orderDataObject.items) {
                var itemInternalId = key;
                var itemData = orderDataObject.items[key];
                var locationId = itemData.locationId;
                var availableBulkBinQuantity = parseFloat(itemAvailQty[locationId][itemInternalId] || 0);
                var quantity = parseFloat(itemData.quantity) || 0;

                if (quantity) {

                    var trackingNumbersLength = itemData.trackingNumber.length;

                    if (trackingNumbersLength > 0) {
                        var fullfillmentQty = itemData.quantity;
                    }

                    if (availableBulkBinQuantity < fullfillmentQty) {
                        adjustmentObj[itemInternalId] = fullfillmentQty - availableBulkBinQuantity
                    }
                }

            }
              //  log.error("adjustmentObj -- ", adjustmentObj);

                if (Object.keys(adjustmentObj).length > 0) {

                    var response = createAdjustment(adjustmentObj, locationId);
                   /// log.error("Inventory Adjustment Response", response);

                    //inventoryAdjRec.setValue({ fieldId: 'memo', value: 'Auto Positive Adjustment due to Bulk bin shortage for JYSWMS Order Fulfilment Details, ID ' });

                    // record.submitFields({
                    //     type: record.Type.INVENTORY_ADJUSTMENT,
                    //     id: response,
                    //     values: {
                    //         memo: 'Auto Positive Adjustment due to Bulk bin shortage for JYSWMS Order Fulfilment Details, ID : ' + customRecId
                    //     }
                    // });

                    // record.submitFields({
                    //     type: 'customrecord_order_fulfillment_details',
                    //     id: customRecId,
                    //     values: {
                    //         custrecord_jyswms_inventory_adjustment: response
                    //     }
                    // });


                }

                var trackingObjects = buildTrackingObjectsFromJson(orderDataObject);
                log.error("trackingObjects", trackingObjects);

                var fullfillmentId = "";

                try {
                    if (salesOrderId) {
                        var soStatus = search.lookupFields({
                            type: search.Type.SALES_ORDER,
                            id: salesOrderId,
                            columns: ['status']
                        });

                        log.error("soStatus", JSON.stringify(soStatus));

                        if (soStatus.status[0].value === 'closed') { // Check if status is 'B' (Billed)
                            var salesOrderRecord = record.load({
                                type: record.Type.SALES_ORDER,
                                id: salesOrderId,
                                isDynamic: false
                            });

                       //   soStatus	2/9/2026	10:43 am	McCallister, Kevin	{"status":[{"value":"closed","text":"Closed"}]}

                            var itemCount = salesOrderRecord.getLineCount({ sublistId: 'item' });

                            for (var i = 0; i < itemCount; i++) {
                                var itemId = salesOrderRecord.getSublistValue({
                                    sublistId: 'item',
                                    fieldId: 'item',
                                    line: i
                                });
                                // Only the line if it's already closed
                                salesOrderRecord.setSublistValue({
                                    sublistId: 'item',
                                    fieldId: 'isclosed',
                                    line: i,
                                    value: false
                                });
                            }

                            salesOrderRecord.save();
                        }

                    }

                    try {
                        var fullfillorder = record.transform({
                            fromType: record.Type.SALES_ORDER,
                            fromId: salesOrderId,
                            toType: record.Type.ITEM_FULFILLMENT,
                            isDynamic: true
                        });

                        log.error("salesOrderId",salesOrderId);


                        fullfillorder.setValue({ fieldId: 'location', value: locationId});
                       
  //log.error("locationId",locationId);
                        var linecount = fullfillorder.getLineCount({ sublistId: 'item' });
                     // log.error("linecount",linecount);


                     for (var j = 0; j < linecount; j++) {

    // MUST select line in dynamic mode
    fullfillorder.selectLine({
        sublistId: 'item',
        line: j
    });

    var item = fullfillorder.getCurrentSublistValue({
        sublistId: 'item',
        fieldId: 'item'
    });

    if (orderDataObject.items[item]) {

        var dbObj = orderDataObject.items[item];
        var quantity = parseFloat(dbObj.quantity) || 0;

        if (quantity > 0) {

            var trackingNumbersLength =
                (dbObj.trackingNumber && dbObj.trackingNumber.length) || 0;

            var fulfillmentQty = trackingNumbersLength || quantity;

            // set location at line level
            fullfillorder.setCurrentSublistValue({
                sublistId: 'item',
                fieldId: 'location',
                value: locationId
            });

            //  set quantity
            fullfillorder.setCurrentSublistValue({
                sublistId: 'item',
                fieldId: 'quantity',
                value: fulfillmentQty
            });

            // -------- Inventory Detail --------
            var inventoryDetailSubrecord =
                fullfillorder.getCurrentSublistSubrecord({
                    sublistId: 'item',
                    fieldId: 'inventorydetail'
                });

            if (!inventoryDetailSubrecord) {
                inventoryDetailSubrecord =
                    fullfillorder.createCurrentSublistSubrecord({
                        sublistId: 'item',
                        fieldId: 'inventorydetail'
                    });
            }

            // Remove existing inventory assignment lines
            var existingLines =
                inventoryDetailSubrecord.getLineCount({
                    sublistId: 'inventoryassignment'
                });

            for (var k = existingLines - 1; k >= 0; k--) {
                inventoryDetailSubrecord.removeLine({
                    sublistId: 'inventoryassignment',
                    line: k
                });
            }

            var bulkStageBin = (locationId == 9) ? 4859 : 16692;

            inventoryDetailSubrecord.selectNewLine({
                sublistId: 'inventoryassignment'
            });

            inventoryDetailSubrecord.setCurrentSublistValue({
                sublistId: 'inventoryassignment',
                fieldId: 'binnumber',
                value: bulkStageBin
            });

            inventoryDetailSubrecord.setCurrentSublistValue({
                sublistId: 'inventoryassignment',
                fieldId: 'quantity',
                value: fulfillmentQty
            });

            inventoryDetailSubrecord.commitLine({
                sublistId: 'inventoryassignment'
            });
        }
    }

    // MUST commit item line
    fullfillorder.commitLine({
        sublistId: 'item'
    });
}
 fullfillorder.setValue({ fieldId: 'shipstatus', value: 'C' });
                        fullfillmentId = fullfillorder.save();
                      log.error("fullfillmentId",fullfillmentId)
                    }
                    catch (e) {
                        log.error("Error in fullFillOrder", e.message);
                    }

                    if (fullfillmentId) {

                      log.error("ready for packages",fullfillmentId)
                      

                        var obj = trackingObjects;

                        var createAmzccRecord = regularCreateAmazonRecords(obj, salesOrderId);

                        var packageContent = packageContents(obj, fullfillmentId);


                    }
                }

                catch (error) {
                    log.error("Error in fullFillOrder", error.message);
                }

            }
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


        function regularCreateAmazonRecords(trackingObj, salesOrderId) {
            try {
                if (!trackingObj || !trackingObj.length) {
                    log.debug('No SSCC codes provided, skipping Amazon record creation');
                    return;
                }
                log.error("trackingObj - amzcc", trackingObj);
                log.error("salesOrderId - amzcc", salesOrderId);
                var salesOrderRec = record.load({
                    type: record.Type.SALES_ORDER,
                    id: salesOrderId,
                    isDynamic: true
                });

                var sublistId = 'recmachcustrecord_sales_order_id';
                var recordId = '';
                var packageBoxNumber = 0;

                // Track duplicates
                // var seenTrackingNumbers = {};

                trackingObj.forEach(function (line) {

                    var tracking = line.trackingNumber;



                    //  Skip empty tracking
                    // if (!tracking) {
                    //     return;
                    // }

                    //  Normalize tracking
                    // tracking = String(tracking).trim().toUpperCase();

                    // //  Skip duplicate tracking
                    // if (seenTrackingNumbers[tracking]) {
                    //     log.debug('Duplicate Amazon tracking skipped', tracking);
                    //     return;
                    // }

                    // // Mark as processed
                    // seenTrackingNumbers[tracking] = true;

                    recordId = line.recordId;
                    packageBoxNumber++;

                    salesOrderRec.selectNewLine({ sublistId: sublistId });

                    // SSCC handling
                    var amzccCode = line.ssccCode;
                    if (amzccCode) {
                        amzccCode = String(amzccCode);
                        amzccCode = amzccCode.slice(2);
                    }

                    var fieldMap = {
                        custrecord_sales_order_id: salesOrderId,
                        custrecord_amzcc_code: amzccCode,
                        custrecord_itemid: line.itemId,
                        custrecord_ucc_code: line.upcCode,
                        custrecord_wms_bulkbatch_picking: 22306500,
                        custrecord_ponumber: line.poNumber,
                        custrecord_pallet_sscc_code: line.palletNumber,
                        custrecord_bol_tracking_number: line.bolTrackingNumber,
                        custrecord_trackingnumber: tracking
                    };

                    for (var fieldId in fieldMap) {
                        if (fieldMap[fieldId] !== null && fieldMap[fieldId] !== '' && fieldMap[fieldId] !== undefined) {
                            try {
                                salesOrderRec.setCurrentSublistValue({
                                    sublistId: sublistId,
                                    fieldId: fieldId,
                                    value: fieldMap[fieldId]
                                });
                            } catch (err) {
                                log.debug(
                                    'Skipped field',
                                    fieldId + ' - ' + err.message
                                );
                            }
                        }
                    }

                    // log.audit('Amazon Record line added', JSON.stringify(fieldMap));
                    salesOrderRec.commitLine({ sublistId: sublistId });
                });

                salesOrderRec.save({
                    enableSourcing: true,
                    ignoreMandatoryFields: true
                });

                log.audit('Amazon Records linked successfully', 'Sales Order ID: ' + salesOrderId);

                if (recordId) {
                    record.submitFields({
                        type: 'customrecord_order_fulfillment_details',
                        id: recordId,
                        values: {
                            custrecord_jyswms_amzcc_updated: true
                        }
                    });
                }

            } catch (e) {
                log.error('Error linking Amazon Records', e.message);
            }
        }

        function packageContents(trackingObj, fullfillmentId) {
            try {

              log.error("trackingObj -- packages",trackingObj);
              log.error("fullfillmentId -- packages",fullfillmentId);
                trackingObj.forEach(function (track) {

                    // if (!track || !track.ssccCode) {
                    //     log.error("Skipping – SSCC missing", track);
                    //     return;
                    // }


                    if (!track) {
                        log.error("Skipping – track missing", track);
                        return;
                    }

                    // // CHECK IN SUBLIST (not input array)
                    // if (ssccExistsInSublist(headerRec, track.ssccCode)) {
                    //     log.error("Skipping – SSCC already exists in sublist", track.ssccCode);
                    //     return;
                    // }


                    // log.error("track", track);

                    var packageRec = record.create({
                        type: 'customrecordhj_tc_package_contents',
                        isDynamic: true
                    });

                    packageRec.setValue({
                        fieldId: 'custrecord_jyswms_createdfrom',
                        value: true
                    });

                    // packageRec.setValue({
                    //     fieldId: 'custrecord_jyswms_related_cif',
                    //     value: headerId
                    // });

                    // SSCC code
                    packageRec.setValue({
                        fieldId: 'custrecordhj_ucc',
                        value: track.ssccCode || ''
                    });

                    // Tracking number
                    packageRec.setValue({
                        fieldId: 'custrecordhj_pkg_pallet',
                        value: track.palletNumber || ''
                    });

                    // Tracking number
                    packageRec.setValue({
                        fieldId: 'custrecordhj_pkg_trackingnumber',
                        value: track.trackingNumber || ''
                    });

                    // If you want to link to fulfillment/parent record and you have the field, uncomment and set correct field id:
                    // packageRec.setValue({ fieldId: 'custrecord_hj_packagecontents_sublist', value: fulfillmentId });

                    packageRec.setValue({
                        fieldId: 'custrecord_jyswms_item_id',
                        value: track.itemInternalId || ''
                    });

                    packageRec.setValue({
                        fieldId: 'custrecordhj_tc_packagecontentslbs',
                        value: track.weight || 0
                    });

                    var itemText = packageRec.getText({
                        fieldId: 'custrecord_jyswms_item_id'
                    });


                    var packageContent = itemText + "/1";
                    // Tracking number
                    packageRec.setValue({
                        fieldId: 'custrecordhj_pkg_desc',
                        value: packageContent
                    });

                    packageRec.selectNewLine({
                        sublistId: 'recmachcustrecordhj_tc_pkgcont_lineitemparent'
                    });

                    packageRec.setCurrentSublistValue({
                        sublistId: 'recmachcustrecordhj_tc_pkgcont_lineitemparent',
                        fieldId: 'custrecordhj_tc_pkgcontents_lineitemitem',
                        value: track.itemInternalId
                    });

                    // Optionally set quantity on the sublist if you have that field (not in original)
                    // if (line.quantity) {
                    //     try {
                    //         packageRec.setCurrentSublistValue({
                    //             sublistId: 'recmachcustrecordhj_tc_pkgcont_lineitemparent',
                    //             fieldId: 'custrecordhj_tc_pkgcontents_lineitemqty', // change if your qty field id differs
                    //             value: parseFloat(line.quantity) || 0
                    //         });
                    //     } catch (eQty) {
                    //         // field might not exist; ignore silently
                    //     }
                    // }

                    packageRec.commitLine({
                        sublistId: 'recmachcustrecordhj_tc_pkgcont_lineitemparent'
                    });

                    var packageId = packageRec.save({
                        enableSourcing: true,
                        ignoreMandatoryFields: false
                    });

                    // packageLines.push(packageId);




                });
            }

            catch (e) {
                log.error("error in createPackageRecords", e.message);
            }

        }

        function getItemAvailableQtyMapByLocation(itemIdsInOrder,locationId) {

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
                    }),
                    search.createColumn({
                        name: "location",
                        join: "binOnHand"
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
                    var locationId = result.getValue({
                        name: "location",
                        join: "binOnHand"
                    });

                    if (!itemQtyMap[locationId]) {
                        itemQtyMap[locationId] = {};
                    }

                    if (!itemQtyMap[locationId][internalId]) {
                        itemQtyMap[locationId][internalId] = 0;
                    }


                    itemQtyMap[locationId][internalId] += parseFloat(availableQty || 0);
                });
            });

            return itemQtyMap;
        }

        function buildTrackingObjectsFromJson(orderJson) {

          log.error("orderJson",orderJson)
          
            var results = [];

            if (!orderJson || !orderJson.items) {
                return results;
            }
            var carrierCode = orderJson.bolNumber || '';
            for (var itemKey in orderJson.items) {

                if (!orderJson.items.hasOwnProperty(itemKey)) continue;

                var itemObj = orderJson.items[itemKey];

                var upcCode = itemObj.upcCode || '';
                var weight = itemObj.itemWeight || '';


                if (!upcCode || !weight) {
                    upcCode = search.lookupFields({
                        type: search.type.ITEM,
                        id: line.itemId,
                        columns: ['upccode', 'weight']
                    });
                    upcCode = upcCode.upccode || '';
                    weight = upcCode.weight || '';

                }

                // Skip invalid qty
                var qty = parseFloat(itemObj.quantity);
                if (!qty || qty <= 0) continue;

                var trackingArr = itemObj.trackingNumber || [];

                for (var i = 0; i < trackingArr.length; i++) {
                    var track = trackingArr[i];

                    var obj = {
                        itemInternalId: itemObj.itemInternalId || '',      // internal id if available
                        itemId: itemObj.item,                    // item name / SKU
                        trackingNumber: track.tracking_number,
                        salesOrder: orderJson.transactionId,    // SO number
                        soHeader: orderJson.internalId || "",
                        bolTrackingNumber: carrierCode,
                        ssccCode: track.sscc_code,     // SO internal id
                        qty: 1,                                  // 1 per SSCC (standard)
                        uniqueId: itemObj.uniqueId || '',
                        weight: weight || '',
                        palletNumber: track.pallet_number || '',
                        upcCode: upcCode || '',
                        poNumber: orderJson.poNumber || ''
                    };

                    results.push(obj);
                }
            }

            log.audit('Tracking Object (From JSON)', JSON.stringify(results));
            return results;
        }


       function transformItems(inputJson) {

    var result = {};
    var itemIds = [];
    var itemMetaCache = {};

    if (!inputJson || !inputJson.items) {
        log.error("Invalid input JSON", inputJson);
        return { output: result, itemIds: itemIds };
    }

    for (var itemKey in inputJson.items) {
        if (!inputJson.items.hasOwnProperty(itemKey)) continue;

        var itemObj = inputJson.items[itemKey];
        var itemId = itemObj.item_internal_id || itemKey;

        // Track unique item IDs
        if (itemIds.indexOf(itemId) === -1) {
            itemIds.push(itemId);
        }

        // Lookup item metadata once
        if (!itemMetaCache[itemId]) {
            var lookup = search.lookupFields({
                type: search.Type.ITEM,
                id: itemId,
                columns: ['weight', 'upccode']
            });

            itemMetaCache[itemId] = {
                weight: lookup.weight || 0,
                upcCode: lookup.upccode || ''
            };
        }

        var lines = itemObj.lines || [];
        for (var i = 0; i < lines.length; i++) {

            var line = lines[i];
            var qty = parseFloat(line.quantity) || 0;

            // 🔑 Location fallback logic
            var locationId =
                line.location_id ||
                (line.location_name === 'Flemington L41' ? 9 : 15);

            if (!locationId || qty <= 0) continue;

            // Init location bucket
            if (!result[locationId]) {
                result[locationId] = {
                    transactionId: inputJson.transaction_id,
                    internalId: inputJson.internal_id,
                    bolNumber: inputJson.bolNumber,
                    items: {}
                };
            }

            // Merge item into location bucket
            if (result[locationId].items[itemId]) {

                result[locationId].items[itemId].quantity += qty;

                if (line.tracking_numbers && line.tracking_numbers.length) {
                    result[locationId].items[itemId].trackingNumber =
                        result[locationId].items[itemId].trackingNumber
                            .concat(line.tracking_numbers);
                }

            } else {

                result[locationId].items[itemId] = {
                    item: itemObj.item,
                    itemInternalId: itemId,
                    upcCode: itemObj.upc_code || itemMetaCache[itemId].upcCode,
                    itemWeight: itemMetaCache[itemId].weight,
                    locationId: locationId,
                    locationName: line.location_name || '',
                    uniqueId: line.unique_id,
                    quantity: qty,
                    isPicked: line.is_picked,
                    trackingNumber: line.tracking_numbers || []
                };
            }
        }
    }

    return {
        output: result,
        itemIds: itemIds
    };
}


        function sendData(salesOrderId) {

            try {

                const webhookUrl = 'https://api.jyswms.com/sales-order-details?internal_id=' + salesOrderId;
                // custsecret_wms_ai_portal_credientals
                
                var token = generateTokenAPI.generateToken();
             //   log.error("token", token);

                const headers = {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                };

                const response = https.get({
                    url: webhookUrl,
                    headers: headers
                });
                var responseBody = JSON.parse(response.body || '{}');
               // log.error("response", JSON.stringify(responseBody));

                //return JSON.stringify(responseBody);
                return responseBody;

            } catch (e) {
                log.error('Error sendData', e);
                return {
                    success: false,
                    error: e.message
                };
            }
        }

        return {
            fullFillOrder: fullFillOrder
        };

    });

