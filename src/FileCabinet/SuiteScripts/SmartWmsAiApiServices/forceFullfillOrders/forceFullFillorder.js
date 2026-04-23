/**
 * @NApiVersion 2.x
 * @NModuleScope Public
 */
define(['N/record', 'N/search', 'N/log', 'N/https', 'N/runtime', '../JYSWMS_generateToken_API'], function (record, search, log, https, runtime, generateTokenAPI) {


    function fullFillOrder(salesOrderId) {
        log.error("fullFillOrder triggered for SO ID", salesOrderId);

        var response = {
            salesOrder: salesOrderId
        };
        var customrecId;

        var fullfillmentId = "";
        try {

            var orderData = sendData(salesOrderId);
            log.error("orderData", orderData);
            var transformed = transformItems(orderData);
            log.error("transformed", transformed);

            // var customrecId;
            var bolTrackingNumber;

            // return transformed;
            var orderByLocation = transformed.output;
            var itemIds = transformed.itemIds || [];

            //var locationId = Object.keys(orderDataObject)[0]; // Assuming one location per order as per original logic

            for (var locationId in orderByLocation) {
                log.error("locationId from trasformed data", locationId);
                if (!orderByLocation.hasOwnProperty(locationId)) continue;

                var orderDataObject = orderByLocation[locationId];
                // do something with key & value
                log.error("orderDataObject", orderDataObject);
                log.error("locationId", locationId);
                var itemAvailQty = getItemAvailableQtyMapByLocation(itemIds, locationId);
                log.error("itemAvailQty", itemAvailQty);

                var adjustmentObj = {};

                for (key in orderDataObject.items) {
                    var itemInternalId = key;
                    log.error("itemInternalId", itemInternalId);

                    var itemData = orderDataObject.items[key];
                    log.error("itemData", itemData);
                    var locationId = itemData.locationId;
                    log.error("locationId", locationId);

                    var availableBulkBinQuantity = Number(
                        itemAvailQty?.[locationId]?.[itemInternalId] ?? 0
                    );
                    log.error("availableBulkBinQuantity", availableBulkBinQuantity);

                    var quantity = parseFloat(itemData.quantity) || 0;
                    log.error("quantity", quantity);


                    if (quantity) {

                        var trackingNumbersLength = itemData.trackingNumber.length;
                        log.error("trackingNumbersLength", trackingNumbersLength);


                        if (trackingNumbersLength > 0) {
                            var fullfillmentQty = itemData.quantity;
                        }

                        if (availableBulkBinQuantity < fullfillmentQty) {
                            adjustmentObj[itemInternalId] = fullfillmentQty - availableBulkBinQuantity
                        }
                    }

                }
                log.error("adjustmentObj -- ", adjustmentObj);

                if (Object.keys(adjustmentObj).length > 0) {
                    var fulfillmentSearch = search.create({
                        type: search.Type.ITEM_FULFILLMENT,
                        filters: [
                            ['createdfrom', 'anyof', salesOrderId],
                            'AND',
                            ['mainline', 'is', 'T']
                        ],
                        columns: ['internalid']
                    });

                    var result = fulfillmentSearch.run().getRange({
                        start: 0,
                        end: 1
                    });

                    if (result && result.length) {
                        fullfillmentId = result[0].getValue({
                            name: 'internalid'
                        });
                    }
                    if (result.length == 0) {
                        var responseInv = createAdjustment(adjustmentObj, locationId, salesOrderId);
                        response.inventoryAdjustmentId = responseInv;
                    }
                }

                var trackingObjects = buildTrackingObjectsFromJson(orderDataObject);
                log.error("trackingObjects", trackingObjects);


                try {
                    if (salesOrderId) {
                        var soStatus = search.lookupFields({
                            type: search.Type.SALES_ORDER,
                            id: salesOrderId,
                            columns: ['status', 'custbody_bol_tracking_number']
                        });


                        bolTrackingNumber = soStatus.custbody_bol_tracking_number || '';


                        log.error("soStatus", {
                            status: JSON.stringify(soStatus),
                            bolNumber: bolTrackingNumber
                        }
                        );

                        //var bolTrackingNumber = soStatus.custbody_bol_tracking_number || '';


                        var headerSearch = search.create({
                            type: 'customrecord_order_fulfillment_details',
                            filters: [
                                ['isinactive', 'is', 'F'],
                                'AND',
                                ['custrecord_jyswms_sales_order_id', 'anyof', salesOrderId]
                            ],
                            columns: ['internalid']
                        });

                        headerSearch.run().each(function (result) {
                            customrecId = result.id;
                            return false; // take first match only
                        });



                        if (soStatus.status[0].text.toLowerCase() === 'closed') { // Check if status is 'B' (Billed)

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

                    if (soStatus.status &&
                        soStatus.status.length &&
                        soStatus.status[0].text === 'Pending Fulfillment') {

                        try {
                            var fullfillorder = record.transform({
                                fromType: record.Type.SALES_ORDER,
                                fromId: salesOrderId,
                                toType: record.Type.ITEM_FULFILLMENT,
                                isDynamic: true
                            });

                            log.error("customrecId", customrecId);

                            response.customrecId = customrecId;


                            fullfillorder.setValue({ fieldId: 'location', value: locationId });

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
                            log.error("fullfillmentId", fullfillmentId)
                        }
                        catch (e) {
                            response.salesOrder = e.message
                            log.error("Error in fullFillOrder", e.message);
                        }

                    }

                    if (!fullfillmentId) {

                        var fulfillmentSearch = search.create({
                            type: search.Type.ITEM_FULFILLMENT,
                            filters: [
                                ['createdfrom', 'anyof', salesOrderId],
                                'AND',
                                ['mainline', 'is', 'T']
                            ],
                            columns: ['internalid']
                        });

                        var result = fulfillmentSearch.run().getRange({
                            start: 0,
                            end: 1
                        });

                        if (result && result.length) {
                            fullfillmentId = result[0].getValue({
                                name: 'internalid'
                            });
                        }

                        log.debug("Fetched fulfillmentId", fullfillmentId);
                    }


                    if (fullfillmentId) {

                        response.fulfillmentId = fullfillmentId;

                        var obj = trackingObjects;
                        log.error("ready for packages", {
                            "fullfillmentId": fullfillmentId,
                            "obj": JSON.stringify(obj)
                        });


                        record.submitFields({
                            type: 'customrecord_order_fulfillment_details',
                            id: customrecId,
                            values: {
                                custrecord_jyswms_rel_item_ful: fullfillmentId
                            }
                        });

                        var createAmzccRecord = regularCreateAmazonRecords(obj, salesOrderId, customrecId);
                        log.error("create Amzcc Records", createAmzccRecord);

                        response.AmzccRecord = createAmzccRecord;

                        var packageContent = packageContents(obj, fullfillmentId, customrecId, bolTrackingNumber, salesOrderId);
                        log.error("create packageContent Records", packageContent);
                        response.packageContents = packageContent;


                        if (salesOrderId) {
                            var linesCLosed = {};
                            var soFields = search.lookupFields({
                                type: search.Type.SALES_ORDER,
                                id: salesOrderId,
                                columns: ['shipmethod']
                            });

                            var shipMethodId = soFields.shipmethod && soFields.shipmethod.length
                                ? soFields.shipmethod[0].value
                                : '';

                            log.error("soFields", soFields);

                            log.error("shipMethodId", shipMethodId);



                            if (shipMethodId != '57733') {

                                log.error("obj - create pack -- packageSubmist", obj);
                                var createpack = createPackages(obj, fullfillmentId, salesOrderId, customrecId);
                                response.Packages = createpack;
                            }
                        }


                        var remaining = runtime.getCurrentScript().getRemainingUsage();

                        log.error("Remaining Governance", remaining);

                    }

                    if (salesOrderId) {

                        var soStatus = search.lookupFields({
                            type: search.Type.SALES_ORDER,
                            id: salesOrderId,
                            columns: ['status']
                        });

                        var statusText = soStatus.status && soStatus.status.length
                            ? soStatus.status[0].text
                            : '';

                        log.error("statusText", statusText);

                        if (
                            statusText === 'Partially Fulfilled' ||
                            statusText === 'Pending Billing' ||
                            statusText === 'Pending Billing/Partially Fulfilled'
                        ) {

                            var soRec = record.load({
                                id: salesOrderId,
                                type: 'salesorder'
                            });

                            var lineCount = soRec.getLineCount({ sublistId: 'item' });

                            for (var i = 0; i < lineCount; i++) {

                                var orderedQty = parseFloat(soRec.getSublistValue({
                                    sublistId: 'item',
                                    fieldId: 'quantity',
                                    line: i
                                })) || 0;

                                var fulfilledQty = parseFloat(soRec.getSublistValue({
                                    sublistId: 'item',
                                    fieldId: 'quantityfulfilled',
                                    line: i
                                })) || 0;


                                var itemId = parseFloat(soRec.getSublistValue({
                                    sublistId: 'item',
                                    fieldId: 'item',
                                    line: i
                                })) || 0;

                                var isClosed = soRec.getSublistValue({
                                    sublistId: 'item',
                                    fieldId: 'isclosed',
                                    line: i
                                });

                                // Case 1: nothing fulfilled → close line
                                if (!isClosed && fulfilledQty === 0) {

                                    soRec.setSublistValue({
                                        sublistId: 'item',
                                        fieldId: 'isclosed',
                                        line: i,
                                        value: true
                                    });

                                    linesCLosed[itemId] = orderedQty;

                                    log.debug("Closing line", {
                                        line: i,
                                        orderedQty: orderedQty,
                                        fulfilledQty: fulfilledQty
                                    });
                                }

                                // Case 2: partial fulfilled → reduce order qty
                                else if (!isClosed && fulfilledQty > 0 && fulfilledQty < orderedQty) {

                                    soRec.setSublistValue({
                                        sublistId: 'item',
                                        fieldId: 'quantity',
                                        line: i,
                                        value: fulfilledQty
                                    });


                                    soRec.setSublistValue({
                                        sublistId: 'item',
                                        fieldId: 'custcol_jy_manipulated_quantity',
                                        line: i,
                                        value: orderedQty
                                    });

                                    linesCLosed[itemId] = fulfilledQty;

                                    log.error("Reducing order qty", {
                                        line: i,
                                        oldQty: orderedQty,
                                        newQty: fulfilledQty
                                    });
                                }
                            }


                            response.linesClosed = linesCLosed;

                            soRec.save({
                                enableSourcing: false,
                                ignoreMandatoryFields: true
                            });
                        }
                    }
                    log.error("-- respoonse1 --", response);


                    // return response;
                }

                catch (error) {

                    response.salesOrder = error.message;

                    record.submitFields({
                        type: record.Type.SALES_ORDER,
                        id: salesOrderId,
                        values: {
                            custbody_error_processing_json: JSON.stringify(response)
                        }
                    });
                    log.error("Error in fullFillOrder", error.message);
                }

            }

        } catch (error) {
            response.salesOrder = error.message
        }


        record.submitFields({
            type: 'customrecord_order_fulfillment_details',
            id: customrecId,
            values: {
                custrecord_jyswms_error: JSON.stringify(response),
                custrecord_isupdate_performed: true
            }
        });

        log.error("response after processing stringified", JSON.stringify(response));

        log.error("response after processing", response);

        return response;

    }


    function createAdjustment(adjustmentObj, locationId, salesOrderId) {
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
            inventoryAdjRec.setValue({ fieldId: 'custbody_realted_sales_order', value: salesOrderId });
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


    function regularCreateAmazonRecords(trackingObj, salesOrderId, customrecId) {

        var response = {};
        var amzccIds = [];
        try {
            if (!trackingObj || !trackingObj.length) {
                log.debug('No SSCC codes provided, skipping Amazon record creation');
                return;
            }

            // log.error("trackingObj - amzcc", trackingObj);
            // log.error("salesOrderId - amzcc", salesOrderId);
            // var salesOrderRec = record.load({
            //     type: record.Type.SALES_ORDER,
            //     id: salesOrderId,
            //     isDynamic: true
            // });

            // var sublistId = 'recmachcustrecord_sales_order_id';
            // var recordId = '';
            // var packageBoxNumber = 0;




            var soId = 0;

            search.create({
                type: 'customrecord_amzcc_custom_rec',
                filters: [
                    ['custrecord_sales_order_id', 'anyof', salesOrderId],
                    "AND",
                    ["custrecord_sales_order_id.mainline", "is", "T"],
                    "AND",
                    ["isinactive", "is", "F"]
                ],
                columns: ['internalid']
            }).run().each(function (r) {
                // record.submitFields({
                //     type: 'customrecord_amzcc_custom_rec',
                //     id: r.id,
                //     values: {
                //         isinactive: true
                //     }
                // });
                //  log.error("r.id ", r.id);
                record.delete({
                    type: 'customrecord_amzcc_custom_rec',
                    id: r.id
                });
                soId++;

                return true;
            });
            if (soId >= '1') {

                log.error("soId - removed count ", soId);

                var salesOrderRec = record.load({
                    type: record.Type.SALES_ORDER,
                    id: salesOrderId,
                    isDynamic: true
                });

                salesOrderRec.save({
                    enableSourcing: true,
                    ignoreMandatoryFields: true
                });

            }

            var salesOrderRec = record.load({
                type: record.Type.SALES_ORDER,
                id: salesOrderId,
                isDynamic: true
            });

            var sublistId = 'recmachcustrecord_sales_order_id';
            var recordId = '';
            var packageBoxNumber = 0;

            //log.error("removecount",removecount);

            // Track duplicates
            // var seenTrackingNumbers = {};

            //             trackingObj.forEach(function (line) {

            //                 var tracking = line.trackingNumber;
            // if (tracking) {
            //   amzccIds.push(tracking);

            // } else {
            //    amzccIds.push(line.ssccCode);

            // }

            //                 //  Skip empty tracking
            //                 // if (!tracking) {
            //                 //     return;
            //                 // }

            //                 //  Normalize tracking
            //                 // tracking = String(tracking).trim().toUpperCase();

            //                 // //  Skip duplicate tracking
            //                 // if (seenTrackingNumbers[tracking]) {
            //                 //     log.debug('Duplicate Amazon tracking skipped', tracking);
            //                 //     return;
            //                 // }

            //                 // // Mark as processed
            //                 // seenTrackingNumbers[tracking] = true;

            //                 recordId = line.recordId;
            //                 packageBoxNumber++;

            //                 salesOrderRec.selectNewLine({ sublistId: sublistId });

            //                 // SSCC handling
            //                 var amzccCode = line.ssccCode;
            //                 if (amzccCode) {
            //                     amzccCode = String(amzccCode);
            //                     amzccCode = amzccCode.slice(2);
            //                 }

            //                 var fieldMap = {
            //                     custrecord_sales_order_id: salesOrderId,
            //                     custrecord_amzcc_code: amzccCode,
            //                     custrecord_itemid: line.itemId,
            //                     custrecord_ucc_code: line.upcCode,
            //                     custrecord_wms_bulkbatch_picking: 22306500,
            //                     custrecord_ponumber: line.poNumber,
            //                     custrecord_pallet_sscc_code: line.palletNumber,
            //                     custrecord_bol_tracking_number: line.bolTrackingNumber,
            //                     custrecord_trackingnumber: tracking
            //                 };

            //                 for (var fieldId in fieldMap) {
            //                     if (fieldMap[fieldId] !== null && fieldMap[fieldId] !== '' && fieldMap[fieldId] !== undefined) {
            //                         try {
            //                             salesOrderRec.setCurrentSublistValue({
            //                                 sublistId: sublistId,
            //                                 fieldId: fieldId,
            //                                 value: fieldMap[fieldId]
            //                             });
            //                         } catch (err) {
            //                             log.debug(
            //                                 'Skipped field',
            //                                 fieldId + ' - ' + err.message
            //                             );
            //                         }
            //                     }
            //                 }

            //                 // log.audit('Amazon Record line added', JSON.stringify(fieldMap));
            //                 salesOrderRec.commitLine({ sublistId: sublistId });
            //             });

            trackingObj.forEach(function (line) {

                var tracking = line.trackingNumber;

                if (tracking) {
                    amzccIds.push(tracking);
                } else {
                    amzccIds.push(line.ssccCode);
                }

                recordId = line.recordId;
                packageBoxNumber++;

                // SSCC handling
                var amzccCode = line.ssccCode;
                if (amzccCode) {
                    amzccCode = String(amzccCode);
                    amzccCode = amzccCode.slice(2);
                }

                try {

                    var rec = record.create({
                        type: 'customrecord_amzcc_custom_rec', // 🔥 your custom record
                        isDynamic: true
                    });

                    rec.setValue({
                        fieldId: 'custrecord_sales_order_id',
                        value: salesOrderId
                    });

                    rec.setValue({
                        fieldId: 'custrecord_amzcc_code',
                        value: amzccCode
                    });

                    rec.setValue({
                        fieldId: 'custrecord_itemid',
                        value: line.itemId
                    });

                    rec.setValue({
                        fieldId: 'custrecord_ucc_code',
                        value: line.upcCode
                    });

                    rec.setValue({
                        fieldId: 'custrecord_wms_bulkbatch_picking',
                        value: 22306500
                    });

                    rec.setValue({
                        fieldId: 'custrecord_ponumber',
                        value: line.poNumber
                    });

                    rec.setValue({
                        fieldId: 'custrecord_pallet_sscc_code',
                        value: line.palletNumber
                    });

                    rec.setValue({
                        fieldId: 'custrecord_bol_tracking_number',
                        value: line.bolTrackingNumber
                    });

                    rec.setValue({
                        fieldId: 'custrecord_trackingnumber',
                        value: tracking
                    });

                    var recId = rec.save({
                        enableSourcing: true,
                        ignoreMandatoryFields: true
                    });

                    log.audit('Custom Record Created', recId);

                } catch (e) {
                    log.error('Error creating record', e.message);
                }

            });



            salesOrderRec.save({
                enableSourcing: true,
                ignoreMandatoryFields: true
            });

            log.audit('Amazon Records (AMZCC) linked successfully', 'Sales Order ID: ' + salesOrderId);

            if (customrecId) {

                record.submitFields({
                    type: 'customrecord_order_fulfillment_details',
                    id: customrecId,
                    values: {
                        custrecord_jyswms_amzcc_updated: true
                    }
                });

            }

            response = {
                success: "All Records Processed successsfully",
                amzccIds: amzccIds
            };

        } catch (e) {

            response = {
                success: e.message,
                amzccIds: amzccIds
            }

            record.submitFields({
                type: record.Type.SALES_ORDER,
                id: salesOrderId,
                values: {
                    custbody_error_processing_json: JSON.stringify(response)
                }
            });
            log.error('Error linking Amazon Records', e.message);
        }

        return response;
    }

    function createPackages(trackingObj, fulfillmentId, salesOrderId, customrecId) {

        var response = {};
        var trackingNumbers = [];

        try {
            // CASE 1: Create new package records if none found
            //  if (!packageIds || packageIds.length === 0) {
            log.error("packageIds.length - in ", fulfillmentId);

            var fulfillmentRec = record.load({
                type: record.Type.ITEM_FULFILLMENT,
                id: fulfillmentId,
                isDynamic: true
            });

            var sublistId = 'package';
            var existingCount = fulfillmentRec.getLineCount({ sublistId });

            // Clear existing package lines

            var removecount = 0;
            // var fulfillmentId = fulfillmentRec.id;
            for (var i = existingCount - 1; i >= 0; i--) {
                fulfillmentRec.removeLine({ sublistId, line: i });
                removecount++;
            }

            log.error("removedcount", removecount)


            //log.error("removedcount", removecount)

            // Add new package lines
            var packageBoxNumber = 0;
            var lastRecordId = null;
            var seenTrackingNumbers = {};

            trackingObj.forEach(function (line) {


                var tracking = line.trackingNumber;
                trackingNumbers.push(tracking);

                // log.error('Duplicate tracking skipped', tracking);

                // // Skip if tracking number is empty
                // if (!tracking) {
                //     return;
                // }

                //Skip duplicate tracking numbers
                if (seenTrackingNumbers[tracking]) {
                    //log.debug('Duplicate tracking skipped', tracking);
                    return;
                }

                //Mark as processed
                seenTrackingNumbers[tracking] = true;


                lastRecordId = line.recordId;
                packageBoxNumber++;

                fulfillmentRec.selectNewLine({ sublistId });

                var fieldMap = {
                    packageweight: line.weight || 1,
                    packagetrackingnumber: line.trackingNumber
                };

                Object.keys(fieldMap).forEach(function (fieldId) {
                    var value = fieldMap[fieldId];
                    if (value !== null && value !== '' && value !== undefined) {
                        try {
                            fulfillmentRec.setCurrentSublistValue({
                                sublistId: sublistId,
                                fieldId: fieldId,
                                value: value
                            });
                        } catch (err) {
                            //log.debug('Skipped field', `${fieldId} - ${err.message}`);
                        }
                    }
                });

                fulfillmentRec.commitLine({ sublistId });
                //log.error('Package line added', JSON.stringify(fieldMap));
            });

            fulfillmentRec.save({
                enableSourcing: true,
                ignoreMandatoryFields: true
            });

            log.error('New Packages Created', `Fulfillment ID: ${fulfillmentId}`);

            response = {
                success: "All Records Processed Successfully",
                fulfillmentId: fulfillmentId,
                trackingNumbers: trackingNumbers
            }

            record.submitFields({
                type: 'customrecord_order_fulfillment_details',
                id: customrecId,
                values: {
                    custrecord_jswms_order_ups_packges: true
                }
            });

            //  }

        } catch (error) {
            response = {
                success: error.message,
                trackingNumbers: trackingNumbers
            }

            record.submitFields({
                type: record.Type.SALES_ORDER,
                id: salesOrderId,
                values: {
                    custbody_error_processing_json: JSON.stringify(response)
                }
            });

            log.error("error while updating create packaes", error.message)
        }
        return response;
    }

    //  var packageContent = packageContents(obj, fullfillmentId, customrecId, bolTrackingNumber, salesOrderId);

    function packageContents(trackingObj, fulfillmentId, customrecId, bolTrackingNumber, salesOrderId) {

        var response = {};
        var packageContentIds = [];
        try {

            var fulfillmentRec = record.load({
                type: record.Type.ITEM_FULFILLMENT,
                id: fulfillmentId,
                isDynamic: true
            });

            var sublistId = 'recmachcustrecord_hj_packagecontents_sublist';
            var existingCount = fulfillmentRec.getLineCount({ sublistId });
            // log.error("existingCount - recmachcustrecord_hj_packagecontents_sublist ", existingCount)

            var removecount = 0;

            //          for (var i = existingCount - 1; i >= 0; i--) {

            //     var childId = fulfillmentRec.getSublistValue({
            //         sublistId: sublistId,
            //         fieldId: 'internalid',
            //         line: i
            //     });
            //            log.error("childId 1",childId);

            //     if (childId) {
            //       log.error("childId",childId);
            //          record.delete({
            //             type: 'customrecord_hj_packagecontents',
            //             id: childId
            //         });
            //     }
            // }

            //  var fulfillmentId = fulfillmentRec.id;

            search.create({
                type: "customrecordhj_tc_package_contents",
                filters: [
                    ["custrecord_hj_packagecontents_sublist", "anyof", fulfillmentId],
                    "AND",
                    ["custrecord_hj_packagecontents_sublist.mainline", "is", "T"]
                ],
                columns: ["internalid"]
            }).run().each(function (result) {
                // log.error("result.id", result.id);
                record.delete({
                    type: "customrecordhj_tc_package_contents",
                    id: result.id
                });
                removecount++;

                return true;
            });

            log.error("removed count", removecount);

            var packagelines = [];
            var box = 1;
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


                //   log.error("track", track);

                var packageRec = record.create({
                    type: 'customrecordhj_tc_package_contents',
                    isDynamic: true
                });

                packageRec.setValue({
                    fieldId: 'custrecord_jyswms_createdfrom',
                    value: true
                });

                packageRec.setValue({
                    fieldId: 'custrecord_jyswms_related_cif',
                    value: customrecId
                });

                // SSCC code
                packageRec.setValue({
                    fieldId: 'custrecordhj_ucc',
                    value: track.ssccCode || ''
                });

                packageContentIds.push(track.ssccCode || track.trackingNumber || '');

                // Tracking number
                packageRec.setValue({
                    fieldId: 'custrecordhj_pkg_pallet',
                    value: track.palletNumber || ''
                });

                // Tracking number
                packageRec.setValue({
                    fieldId: 'custrecordhj_pkg_trackingnumber',
                    value: track.trackingNumber || bolTrackingNumber || ''
                });
                // Tracking number
                packageRec.setValue({
                    fieldId: 'custrecordhj_pkgbox',
                    value: box || ''
                });

                box++;

                // If you want to link to fulfillment/parent record and you have the field, uncomment and set correct field id:
                packageRec.setValue({ fieldId: 'custrecord_hj_packagecontents_sublist', value: fulfillmentId });

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

                packagelines.push(packageId);
            });
            response = {
                success: "All Records Processed Successfully",
                packageContentIds: packageContentIds
            }


            record.submitFields({
                type: 'customrecord_order_fulfillment_details',
                id: customrecId,
                values: {
                    custrecord_jyswms_package_updated: true
                }
            });

            log.audit("packagelines", packagelines);

        }

        catch (e) {
            response = {
                success: e.message,
                packageContentIds: packageContentIds
            }

            record.submitFields({
                type: record.Type.SALES_ORDER,
                id: salesOrderId,
                values: {
                    custbody_error_processing_json: JSON.stringify(response)
                }
            });
            log.error("error in createPackageRecords", e.message);
        }
        return response;

    }

    function getItemAvailableQtyMapByLocation(itemIdsInOrder, locationId) {
        log.error("getItemAvailableQtyMapByLocation", itemIdsInOrder, locationId);

        try {

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

            log.error("Total records", pagedData.count);

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

        } catch (error) {
            log.error("Error in getItemAvailableQtyMapByLocation", error.message);

        }
    }

    function buildTrackingObjectsFromJson(orderJson) {

        log.error("orderJson", orderJson)

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

                // Location fallback logic
                var locationId =
                    line.location_id ||
                    (line.location_name === 'Flemington L41' ? 9 : 15);

                //   if (!locationId || qty <= 0 || line.is_picked == null || line.is_picked == 'suspended') continue;

                // var isValidPicked = !isNaN(line.is_picked) && Number(line.is_picked) > 0;

                //   if (!locationId || qty <= 0 || !isValidPicked) continue;

                //               var pickedVal = Number(line.is_picked);

                // var isValidPicked =
                //     !isNaN(pickedVal) &&
                //     pickedVal > 0 &&
                //     parseInt(pickedVal, 10) === pickedVal;

                // if (!locationId || qty <= 0 || !isValidPicked) continue;
                var isValidPicked = line.is_picked === 'picked';
                if (!locationId || qty <= 0 || !isValidPicked) continue;


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
            log.error("response from db api", JSON.stringify(responseBody));

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