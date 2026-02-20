/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define([
    'N/record',
    'N/error',
    'N/log',
    'N/search',
    'N/runtime',
    'N/https',
    './Bin/binUtils',
    './Orders/orderUtils',
  './markAsPicked/markAsPickedUtil'
], function (record, error, log, search, runtime, https, binUtils, orderUtils,markAsPickedUtil) {

    function afterSubmit(context) {

        const rec = context.newRecord;

        const wasChecked = rec.getValue('custrecord_wms_ai_api_custrec_processing');


        if (!wasChecked) {
           
            return;
        }

        if (context.type !== context.UserEventType.EDIT) {
            log.debug("Skipped", "Not an EDIT event");
            return;
        }

       

        const customRecId = rec.id;
       log.debug("wasChecked", customRecId);

        try {
            const fullRecord = record.load({
                type: 'customrecord_wms_ai_api_custom_rec',
                id: customRecId,
                isDynamic: false
            });

            const jsonString = fullRecord.getValue('custrecordwms_ai_api_custrec_json_data');
            const action = fullRecord.getValue('custrecordwms_ai_api_custrec_action');

            log.debug("Action", action);

            if (!jsonString) {
                log.error('Missing JSON', 'No JSON data found in custrecordwms_ai_api_custrec_json_data');
                return;
            }

            let jsonData;
            try {
                jsonData = JSON.parse(jsonString);
                log.error('JSON', jsonData);
            } catch (err) {
                log.error('Invalid JSON', err.message);
                return;
            }

            let result = null;

            switch (action) {
                case 'markAsPicked':
                    result = markAsPickedUtil.markAsPicked(jsonData, customRecId);
                    break;
                case 'fullfillOrders':
                    result = FullFillOrders(context); // Make sure this function exists and is defined
                    break;
                case 'binCount':
                    result = binUtils.binCount(jsonData, customRecId);
                    break;
                case 'binAdjustment':
                    result = binUtils.binAdjustment(jsonData, customRecId);
                    break;
                case 'binTransfer':
                    result = binUtils.binTransfer(jsonData, customRecId);
                    break;
                case 'receiveInbound':
                    result = orderUtils.transformInboundShipmentToItemReceipt(jsonData, customRecId);
                    try {
                        var inboundId = result.itemReceiptId;
                        log.error("get restlet inboundId ", inboundId);


                        if (!inboundId) {
                            log.error("No inbound if blockinboundId", inboundId);
                            inboundId = jsonData.inboundShipmentId
                        }

                        if (!inboundId) {
                            log.error("return response", inboundId);
                            return result;
                        }

                        log.error(" inboundId", inboundId);
                        // log.error("Internal IDs", JSON.stringify(inboundShipmentID));
                        var params = {
                            inboundShipmentID: inboundId,
                            pageSize: 1000
                        };

                        var startIndex = 0;
                        var pageSize = 1000;

                        var response = orderUtils.getInboundRecords(params, pageSize, startIndex);

                        var status = sendData(response);
                    }
                    catch (e) {
                        log.error("error message", e.message);
                    }


                    break;
                default:
                    log.error('Invalid action', `Action "${action}" is not supported.`);
                    return;
            }

fullRecord.setValue({
    fieldId: 'custrecord_wms_ai_api_custrec_response',
    value: JSON.stringify(result)
});

            log.error("Result from action", result);

            if (result && result.success === true) {
                var Reprocessing = fullRecord.getValue({
                    fieldId: 'custrecord_wms_ai_api_custrec_processing'
                });
                var status = fullRecord.getValue({
                    fieldId: 'custrecord_wms_ai_api_custrec_status'
                });
                log.error('Reprocessing & Status', `Processing: ${Reprocessing}, Status: ${status}`);

            }
            else {

                var Reprocessing1 = fullRecord.getValue({
                    fieldId: 'custrecord_wms_ai_api_custrec_processing'
                });
                var status1 = fullRecord.getValue({
                    fieldId: 'custrecord_wms_ai_api_custrec_status'
                });
                log.error('Reprocessing1 & Status1', `Processing: ${Reprocessing1}, Status: ${status1}`);

            }

        } catch (e) {
            log.error('Error in afterSubmit', e.message);
        }
    }


    
    function markAsPicked(requestBody,custid) {
        var headerId = null;
        try {
            log.error('Incoming Data - MarkAsPicked', JSON.stringify(requestBody));
            var savedTransfers = [];
            var savedHeaders = [];
            // STEP 1: Build existing SO map
            var existingMap = {};
            var binMap = getBinNameToIdMap();

            var headerSearch = search.create({
                type: 'customrecord_order_fulfillment_details',
                filters: [
                    // ['custrecord_jyswms_approved', 'is', 'F'], 'AND',
                    ["isinactive", "is", "F"]
                    // , 'AND',
                    //  ['custrecord_jyswms_carrier_pro_number', 'isempty']
                ],
                columns: ['internalid', 'custrecord_jyswms_sales_order_id']
            });
            headerSearch.run().each(function (result) {
                existingMap[result.getValue('custrecord_jyswms_sales_order_id')] = result.id;
                return true;
            });

            log.audit('Existing SO Map', JSON.stringify(existingMap));

            // Validate request body structure
            if (!requestBody || !requestBody.data || !Array.isArray(requestBody.data)) {
                return {
                    status: 'error',
                    message: 'Invalid request body: data array is required'
                };
            }

            // STEP 2: Process each sales order in JSON
            for (var d = 0; d < requestBody.data.length; d++) {
                var Data = requestBody.data[d];
                var salesOrders = Data.salesOrders || [];

                // Skip if no sales orders in this data item
                if (!salesOrders || salesOrders.length === 0) {
                    log.error('No sales orders found in data item', d);
                    continue;
                }

                for (var i = 0; i < salesOrders.length; i++) {

                    var so = salesOrders[i];
                    var salesOrderId = so.salesOrderId;


                    if (!salesOrderId) continue;

                    var itemId = so.itemInternalId || Data.itemInternalId || Data.item || '';
                    var pickQty = Data.picked_quantity || 0;
                    var binId = Data.binInternalId || '';
                    var uniqueId = so.unique_id || '';
                    var isClose = (
                        isTruthyFlag(Data.isClose) ||
                        isTruthyFlag(Data.is_close) ||
                        isTruthyFlag(so.is_close)
                    );
                    var locationId = Data.locationId || null;



                    if (!locationId && Data.location) {
                        locationId = Data.location === "L60-Hardeeville_SC" ? 15 : 9;
                    }

                    if (!binId) {
                        var binNumber = Data.bin;
                        binId = binMap[binNumber]
                    }

                    var savedId = so.bin_transfer_internal_id || "";
                    var portalId = requestBody.portalId || requestBody.portalid;
                    var pickerName = requestBody.userName || requestBody.username || requestBody.pickerName;

                    var trackingNumbers = [];

                    // --- Extract tracking numbers safely ---
                    var trackingList = (so.labelData || [])
                        .map(function (l) {
                            return l.sscc_code || l.tracking_number || "";
                        })
                        .filter(Boolean);

                    // --- Extract SSCC codes ONLY if labelData2 exists ---
                    var ssccList = (so.labelData2 || [])
                        .map(function (l) {
                            return l.sscc_code || l.tracking_number || "";
                        })
                        .filter(Boolean);

                    log.error("trackingList", trackingList);
                    log.error("ssccList", ssccList);


                   if (so.packing_slip) {
                     trackingList = [];

                        trackingList = (so.labelData || [])
                        .map(function (l) {
                            return  l.tracking_number || "";
                        })
                        .filter(Boolean);

                      }

                    // --- CASE 1: labelData2 exists → pair by index ---
                    if (ssccList.length && trackingList.length &&  !so.packing_slip) {

                        var pairCount = Math.min(trackingList.length, ssccList.length);

                        for (var i = 0; i < pairCount; i++) {
                            trackingNumbers.push({
                                ssccCode: ssccList[i],
                                trackingNumber: trackingList[i]
                            });
                        }

                    }
                    // --- CASE 2: labelData2 does NOT exist → tracking only ---
                       else if (!so.packing_slip) { 
                        trackingList.forEach(function (tn) {
                            trackingNumbers.push({
                                ssccCode: tn,       // fallback behavior
                                trackingNumber: ""
                            });
                        });
                    }  
                    else {
                        trackingList.forEach(function (tn) {
                            trackingNumbers.push({
                               trackingNumber: tn,
                                ssccCode: ""    // fallback behavi
                            });
                        });
                    }

                    // log.audit('Processing SO -- tracking numbers', {
                    //     salesOrderId: salesOrderId,
                    //     itemId: itemId,
                    //     binId: binId,
                    //     locationId: locationId,
                    //     pickQty: pickQty,
                    //     trackingNumbers:trackingNumbers
                    // });

                    // fallback lookup location if missing
                    if (!locationId && binId) {
                        var locationLookup = search.lookupFields({
                            type: search.Type.BIN,
                            id: binId,
                            columns: ['location']
                        });
                        locationId = locationLookup.location && locationLookup.location[0] && locationLookup.location[0].value;
                    }

                    // Validate required fields before proceeding
                    if (!itemId) {
                        log.error('Missing itemId for sales order', salesOrderId);
                        continue;
                    }

                    // If caller sent isClose flag, close SO line and skip pick flow
                    if (isClose === true) {
                        log.audit('isClose flag detected - closing SO line', {
                            salesOrderId: salesOrderId,
                            itemId: itemId,
                            uniqueId: uniqueId
                        });
                        closeSalesOrderItem(salesOrderId, itemId, uniqueId);
                        continue;
                    }

                    if (pickQty === null || pickQty === undefined) {


                        log.error('Invalid pickQty for sales order (must be greater than 0)', { salesOrderId: salesOrderId, pickQty: pickQty });
                        continue;

                    }
                    if (!locationId) {
                        log.error('Missing locationId for sales order', salesOrderId);
                        continue;
                    }

                    var bulkStageBin = (locationId === 9) ? 4859 : 16692;

                    // STEP 3: Load or create header
                    headerId = existingMap[salesOrderId];
                    var headerRec;

log.debug("headerId",headerId);
                    if (headerId) {
                        headerRec = record.load({
                            type: 'customrecord_order_fulfillment_details',
                            id: headerId,
                            isDynamic: true
                        });
                    } else {

                        headerRec = record.create({
                            type: 'customrecord_order_fulfillment_details',
                            isDynamic: true
                        });
                        headerRec.setValue('custrecord_jyswms_sales_order_id', salesOrderId);
                        headerRec.setValue('custrecord_jyswms_portal_id', portalId);
                        // Save new record first to get the ID before adding lines
                        headerId = headerRec.save();
                        existingMap[salesOrderId] = headerId;
                       // log.error("Created new header record", headerId);
                    }

                    // STEP 4: Create Bin Transfer
                    if (savedId) {
                        log.debug("savedId -- bintrnasferid", savedId);
                    } else {

                        try {

                            var binTransferRec = record.create({ type: 'bintransfer', isDynamic: true });
                            binTransferRec.setValue({ fieldId: 'subsidiary', value: 1 });
                            binTransferRec.setValue({ fieldId: 'custbody_wms_ai_created_by', value: true });
                            binTransferRec.setValue({ fieldId: 'memo', value: 'Bin Transfer via Restlet' });
                            binTransferRec.setValue({ fieldId: 'location', value: locationId });
                            binTransferRec.setValue({ fieldId: 'custbody_jyswms_item_unique_id', value: uniqueId });
                            binTransferRec.setValue({ fieldId: 'custbody_wms_ai_pickername', value: pickerName });
                            binTransferRec.setValue({ fieldId: 'custbody_realted_sales_order', value: salesOrderId });

                            binTransferRec.selectNewLine({ sublistId: 'inventory' });
                            binTransferRec.setCurrentSublistValue({ sublistId: 'inventory', fieldId: 'item', value: itemId });
                            binTransferRec.setCurrentSublistValue({ sublistId: 'inventory', fieldId: 'quantity', value: pickQty });

                            var inventoryDetail = binTransferRec.getCurrentSublistSubrecord({
                                sublistId: 'inventory',
                                fieldId: 'inventorydetail'
                            });
                            inventoryDetail.selectNewLine({ sublistId: 'inventoryassignment' });
                            inventoryDetail.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'binnumber', value: binId });
                            inventoryDetail.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'quantity', value: pickQty });
                            inventoryDetail.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'tobinnumber', value: bulkStageBin });
                            inventoryDetail.commitLine({ sublistId: 'inventoryassignment' });

                            binTransferRec.commitLine({ sublistId: 'inventory' });

                            log.audit('BinTransfer Record - Before Save', {
                                salesOrderId: salesOrderId,
                                itemId: itemId,
                                pickQty: pickQty,
                                fromBin: binId,
                                toBin: bulkStageBin
                            });

                            try {
                                savedId = binTransferRec.save();
                            } catch (e) {
                                log.error("error saving bintransfer", e.message);
                            }
                            //  log.error("BinTransfer savedId", savedId);
                        } catch (binTransferError) {
                            log.error('Failed to save bin transfer', {
                                error: binTransferError.message,
                                salesOrderId: salesOrderId,
                                itemId: itemId,
                                pickQty: pickQty
                            });
                            // Bin transfer failed, but continue processing to create custom record line

                        }
                    }

                    // STEP 5: Reload header record before adding lines (ensures fresh copy)
                    // This is critical: ensures we have the latest version before adding sublist lines
                    headerRec = record.load({
                        type: 'customrecord_order_fulfillment_details',
                        id: headerId,
                        isDynamic: true
                    });

                    // STEP 6: Add header lines
                    var line = headerRec.selectNewLine({ sublistId: 'recmachcustrecord_sales_order_header' });
                    line.setCurrentSublistValue({ sublistId: 'recmachcustrecord_sales_order_header', fieldId: 'custrecord_jyswms_item', value: itemId });
                    line.setCurrentSublistValue({ sublistId: 'recmachcustrecord_sales_order_header', fieldId: 'custrecord_jyswms_item_order_qty', value: so.quantity });
                    line.setCurrentSublistValue({ sublistId: 'recmachcustrecord_sales_order_header', fieldId: 'custrecord_jyswms_item_picked_qty', value: pickQty });
                    line.setCurrentSublistValue({ sublistId: 'recmachcustrecord_sales_order_header', fieldId: 'custrecord_jyswms_sales_order', value: salesOrderId });
                    line.setCurrentSublistValue({ sublistId: 'recmachcustrecord_sales_order_header', fieldId: 'custrecord_jyswms_item_picked_bin', value: binId });
                    line.setCurrentSublistValue({ sublistId: 'recmachcustrecord_sales_order_header', fieldId: 'custrecord_jswms_item_so_item_qty', value: so.item_quantity });
                    // Initialize inventory adjustment ID
                    var invAdjId = "";

                    // Wrap entire negative inventory adjustment logic in try-catch block
                    try {
                        var soItemQuantity = so.quantity;
                    
                        var userPickedQty = pickQty;

                        // Calculate quantity difference
                        var qtyDiff = soItemQuantity - userPickedQty;
                        if (qtyDiff <= 0) {
                            log.debug("No adjustment needed — fully picked");
                            // Continue processing without adjustment
                        } else {
                            // Create inventory adjustment if there's a shortfall
                            var negativeQty = -qtyDiff;
                            log.debug(" Negative inventory adjustment - NegativeQuanity : ", negativeQty);

                            var inventoryAdjRec = record.create({
                                type: record.Type.INVENTORY_ADJUSTMENT,
                                isDynamic: true
                            });

                            // Set subsidiary (update if your account uses multiple)
                            inventoryAdjRec.setValue({
                                fieldId: 'subsidiary',
                                value: 1
                            });

                            inventoryAdjRec.setValue({ fieldId: 'adjlocation', value: locationId });

                            inventoryAdjRec.setValue({
                                fieldId: 'account',
                                value: 464 // update as needed
                            });

                            inventoryAdjRec.setValue({ fieldId: 'memo', value: 'Auto negative adjustment for bin: ' + binId });

                            // Add inventory line
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

                            // Set quantity before inventory detail
                            inventoryAdjRec.setCurrentSublistValue({
                                sublistId: 'inventory',
                                fieldId: 'adjustqtyby',
                                value: negativeQty
                            });

                            // Lookup item properties safely
                            var itemLookup = search.lookupFields({
                                type: search.Type.ITEM,
                                id: itemId,
                                columns: ['usebins', 'recordtype']
                            });

                            // log.error('Item Lookup', JSON.stringify(itemLookup));

                            var useBins =
                                itemLookup.usebins === true ||
                                itemLookup.usebins === 'T' ||
                                (Array.isArray(itemLookup.usebins) && itemLookup.usebins[0] === 'T');

                            var isInventoryItem =
                                ['inventoryitem', 'serializedinventoryitem', 'lotnumberedinventoryitem'].includes(itemLookup.recordtype);

                            if (useBins && isInventoryItem && binId) {
                                try {
                                    var invDetail = inventoryAdjRec.getCurrentSublistSubrecord({
                                        sublistId: 'inventory',
                                        fieldId: 'inventorydetail'
                                    });

                                    // 1.Remove existing inventory assignment lines
                                    var existingLines = invDetail.getLineCount({ sublistId: 'inventoryassignment' });
                                    for (var k = existingLines - 1; k >= 0; k--) {
                                        invDetail.removeLine({ sublistId: 'inventoryassignment', line: k });
                                    }
                                    // log.error(" Cleared Existing Inventory Lines", existingLines);

                                    // 2: Add new inventory assignment
                                    invDetail.selectNewLine({ sublistId: 'inventoryassignment' });

                                    invDetail.setCurrentSublistValue({
                                        sublistId: 'inventoryassignment',
                                        fieldId: 'binnumber',
                                        value: binId
                                    });


                                    invDetail.setCurrentSublistValue({
                                        sublistId: 'inventoryassignment',
                                        fieldId: 'quantity',
                                        value: negativeQty
                                    });

                                    // Step 3: Verify values before commit
                                    var getBinID = invDetail.getCurrentSublistValue({
                                        sublistId: 'inventoryassignment',
                                        fieldId: 'binnumber'
                                    });


                                    var getQty = invDetail.getCurrentSublistValue({
                                        sublistId: 'inventoryassignment',
                                        fieldId: 'quantity'
                                    });


                                    invDetail.commitLine({ sublistId: 'inventoryassignment' });
                                    log.audit(" Inventory Assignment Added", "Bin: " + binId + ", Qty: " + negativeQty);

                                } catch (invDetailError) {
                                    log.error("Inventory Detail Creation Failed", invDetailError.name + " | " + invDetailError.message);
                                    // Continue with adjustment even if inventory detail fails
                                }
                            } else {
                                log.error("Skipping inventory detail — missing bin or not inventory-managed");
                            }

                            inventoryAdjRec.commitLine({ sublistId: 'inventory' });

                            var summary = {
                                itemId: itemId,
                                binId: binId,
                                locationId: locationId,
                                negativeQty: negativeQty
                            };


                            // Save record
                            invAdjId = inventoryAdjRec.save({
                                enableSourcing: true,
                                ignoreMandatoryFields: true
                            });

                            log.debug(" Inventory Adjustment Created Successfully - MarkAsPicked : ", invAdjId);
                        }
                    } catch (negativeInvError) {
                        log.error(" Negative Inventory Adjustment Error", {
                            error: negativeInvError.name + " | " + negativeInvError.message,
                            salesOrderId: salesOrderId,
                            itemId: itemId,
                            pickQty: pickQty
                        });
                        // Continue processing even if adjustment fails - invAdjId remains null
                    }

                    // Set bin transfer ID and inventory adjustment ID on the line
                    // Only set bin transfer ID if bin transfer was successful
                    if (savedId) {
                        line.setCurrentSublistValue({ sublistId: 'recmachcustrecord_sales_order_header', fieldId: 'custrecord_item_bintransfer_id', value: savedId });
                    }

                    if (invAdjId) {
                        line.setCurrentSublistValue({
                            sublistId: 'recmachcustrecord_sales_order_header',
                            fieldId: 'custrecord_jyswms_item_inv_adjy',
                            value: invAdjId
                        });
                    }

                    line.setCurrentSublistValue({ sublistId: 'recmachcustrecord_sales_order_header', fieldId: 'custrecord_jyswms_item_uniqueid', value: uniqueId });
                    line.setCurrentSublistValue({ sublistId: 'recmachcustrecord_sales_order_header', fieldId: 'custrecord_jyswms_item_portal_id', value: portalId });

                    line.setCurrentSublistValue({
                        sublistId: 'recmachcustrecord_sales_order_header',
                        fieldId: 'custrecord_jyswms_item_picker_name',
                        value: pickerName
                    });
                    line.setCurrentSublistValue({ sublistId: 'recmachcustrecord_sales_order_header', fieldId: 'custrecord_jyswms_item_tracking_numbers', value: trackingNumbers.length || 0 });
                    headerRec.commitLine({ sublistId: 'recmachcustrecord_sales_order_header' });

                    // STEP 7: Add tracking lines
                    // log.error('Tracking Numbers', trackingNumbers);

                    trackingNumbers.forEach(function (track) {

                        // if (!track || !track.ssccCode) {
                        //     log.error("Skipping – SSCC missing", track);
                        //     return;
                        // }
                        if (!track) {
                            log.error("Skipping – track missing", track);
                            return;
                        }

                        // 🔍 CHECK IN SUBLIST (not input array)
                        if (ssccExistsInSublist(headerRec, track.ssccCode)) {
                            log.error("Skipping – SSCC already exists in sublist", track.ssccCode);
                            return;
                        }


                        log.debug("track", track);
                        var trackLine = headerRec.selectNewLine({ sublistId: 'recmachcustrecord_jyswms_so_header' });
                        trackLine.setCurrentSublistValue({ sublistId: 'recmachcustrecord_jyswms_so_header', fieldId: 'custrecord_jyswms_track_item', value: itemId });
                        trackLine.setCurrentSublistValue({ sublistId: 'recmachcustrecord_jyswms_so_header', fieldId: 'custrecord_jyswms_track_number', value: track.ssccCode });
                        trackLine.setCurrentSublistValue({ sublistId: 'recmachcustrecord_jyswms_so_header', fieldId: 'custrecord_jyswms_track_so_id', value: salesOrderId });
                        trackLine.setCurrentSublistValue({ sublistId: 'recmachcustrecord_jyswms_so_header', fieldId: 'custrecord_jyswms_track_qty', value: 1 });
                        trackLine.setCurrentSublistValue({ sublistId: 'recmachcustrecord_jyswms_so_header', fieldId: 'custrecord_jyswms_track_uniqueid', value: uniqueId });
                        trackLine.setCurrentSublistValue({ sublistId: 'recmachcustrecord_jyswms_so_header', fieldId: 'custrecord_jyswms_track_dropship', value: track.trackingNumber || " " });
                        headerRec.commitLine({ sublistId: 'recmachcustrecord_jyswms_so_header' });
                    });

                    // log.error("Started Header line set");

                    //  Get total SO quantity from Sales Order
                    var soLookup = search.lookupFields({
                        type: 'salesorder',
                        id: salesOrderId,
                        columns: ['custbody_so_total_qty']
                    });
                    var totalSOQty = Number(soLookup.custbody_so_total_qty) || 0;

                    //  Calculate total picked quantity from all item lines
                    var totalPickedQty = 0;
                    var lineCount = headerRec.getLineCount({ sublistId: 'recmachcustrecord_sales_order_header' });

                    for (var l = 0; l < lineCount; l++) {
                        var linePicked = Number(headerRec.getSublistValue({
                            sublistId: 'recmachcustrecord_sales_order_header',
                            fieldId: 'custrecord_jyswms_item_picked_qty',
                            line: l
                        })) || 0;
                        totalPickedQty += linePicked;
                    }

                    // Set both totals on header
                    headerRec.setValue({ fieldId: 'custrecord_jyswms_total_so_qty', value: totalSOQty });
                    headerRec.setValue({ fieldId: 'custrecord_jyswms_total_pick_qty', value: totalPickedQty });

                    //  Compare totals and set Approved checkbox
                    var isApproved = (totalSOQty <= totalPickedQty);
                    headerRec.setValue({
                        fieldId: 'custrecord_jyswms_approved',
                        value: isApproved ? true : false
                    });

                    log.debug('Header Totals and Approval', {
                        totalSOQty: totalSOQty,
                        totalPickedQty: totalPickedQty,
                        approved: isApproved
                    });

                    // Save header record with error handling
                    try {
                        headerId = headerRec.save();
                        // log.debug("Saved Header", headerId);
                        existingMap[salesOrderId] = headerId;

                        // Add to response arrays for each sales order
                        // Only add bin transfer ID if bin transfer was successful
                        if (savedId) {
                            savedTransfers.push(savedId);
                        }

                        savedHeaders.push(headerId);
                    } catch (headerSaveError) {
                        log.error('Failed to save header record', {
                            error: headerSaveError.message,
                            salesOrderId: salesOrderId,
                            headerId: headerId
                        });
                        // Continue to next sales order instead of failing entire batch
                        continue;
                    }
                }

                log.audit("MarkAsPicked", "savedTransfers: " + JSON.stringify(savedTransfers) + ", savedHeaders: " + JSON.stringify(savedHeaders));

            }
         

            // Build expected JSON response
            const expectedResponse = {
                status: 'success',
                message: 'Items & tracking numbers processed successfully',
                binTransferId: savedTransfers,
                customRecID: savedHeaders
            };

            // Log the expected JSON response
            log.debug('Expected JSON Response - MarkASpicked', JSON.stringify(expectedResponse));

            return expectedResponse;

        }
        catch (e) {
            log.error('POST Error', e);
            if (headerId) {
                record.submitFields({
                    type: 'customrecord_order_fulfillment_details',
                    id: headerId,
                    values: {
                        custrecord_jyswms_error: e.message,
                        custrecord_jyswms_item_error_: e.message
                    }
                });
            }
            return { status: 'error', message: e.message };
        }
    }


        // dependency for markaspicked function
    function getBinNameToIdMap() {
        try {
            var binMap = {};

            var binSearch = search.create({
                type: search.Type.BIN,
                filters: [],
                columns: [
                    search.createColumn({ name: 'binnumber' }),
                    search.createColumn({ name: 'internalid' })
                ]
            });

            var pagedData = binSearch.runPaged({
                pageSize: 1000
            });

            pagedData.pageRanges.forEach(function (pageRange) {
                var page = pagedData.fetch({
                    index: pageRange.index
                });

                page.data.forEach(function (result) {
                    var binName = result.getValue({ name: 'binnumber' });
                    var binId = result.getValue({ name: 'internalid' });

                    if (binName && binId) {
                        binMap[binName] = binId;
                    }
                });
            });

            return binMap;

        } catch (e) {
            log.error('Error building bin map', e.message);
            return {};
        }
    }
        // Check if SSCC code already exists in the header sublist
        // depency for markaspicked function
    function ssccExistsInSublist(headerRec, ssccCode) {
        var sublistId = 'recmachcustrecord_jyswms_so_header';
        var lineCount = headerRec.getLineCount({ sublistId: sublistId });

        for (var i = 0; i < lineCount; i++) {
            var existingSscc = headerRec.getSublistValue({
                sublistId: sublistId,
                fieldId: 'custrecord_jyswms_track_number',
                line: i
            });

            if (existingSscc && existingSscc === ssccCode) {
                return true;
            }
        }
        return false;
    }



//dependency for markaspicked function

    /**
   * Treat various truthy inputs (boolean true, "true", "True", "1") as true.
   */
    function isTruthyFlag(val) {
        if (val === true) return true;
        if (typeof val === 'string') {
            var lowered = val.trim().toLowerCase();
            return lowered === 'true' || lowered === '1';
        }
        if (val === 1) return true;
        return false;
    }

    /**
     * Close matching item lines on a sales order.
     * This is called when the payload sends isClose=true.
     */

    // dependency for markaspicked function
    function closeSalesOrderItem(salesOrderId, itemId, uniqueId) {
        try {
            var soRec = record.load({
                type: record.Type.SALES_ORDER,
                id: salesOrderId,
                isDynamic: true
            });

            var lineCount = soRec.getLineCount({ sublistId: 'item' });
            var closedLines = [];

            for (var i = 0; i < lineCount; i++) {
                var lineItemId = soRec.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'item',
                    line: i
                });

                if (String(lineItemId) === String(itemId)) {
                    soRec.selectLine({ sublistId: 'item', line: i });
                    soRec.setCurrentSublistValue({
                        sublistId: 'item',
                        fieldId: 'isclosed',
                        value: true
                    });
                    soRec.commitLine({ sublistId: 'item' });
                    closedLines.push(i);
                }
            }

            if (closedLines.length > 0) {
                var updatedId = soRec.save();
                log.audit('Closed SO item lines', {
                    salesOrderId: salesOrderId,
                    itemId: itemId,
                    lines: closedLines,
                    uniqueId: uniqueId,
                    savedId: updatedId
                });
                return true;
            }

            log.error('No matching item lines to close', {
                salesOrderId: salesOrderId,
                itemId: itemId,
                uniqueId: uniqueId
            });
            return false;
        } catch (e) {
            log.error('Failed to close SO item lines', {
                salesOrderId: salesOrderId,
                itemId: itemId,
                uniqueId: uniqueId,
                error: e.message
            });
            return false;
        }
    }

function toSnakeCase(str) {
    return str
        .trim()
        .replace(/[^a-zA-Z0-9 ]/g, '')
        .replace(/\s+/g, '_')
        .toLowerCase();
}

    function generateToken() {
        try {
            var webhookUrl = 'https://api.jyswms.com/user/login'; // prod Url
            var token = "";

            // Convert object to x-www-form-urlencoded string
            var formData = { userid: "jyswms_integration_user", password: "s9u[7zC720%pZr" };
            log.error("formData ", formData);

            var headerObj = {
                'Content-Type': 'application/json'
            };

            try {
                var response = https.post({
                    url: webhookUrl,
                    body: JSON.stringify(formData),
                    headers: headerObj
                });

                log.error("response", JSON.stringify(response));

                log.error('Response Body', response.body);
                var responseBody = response.body;
                var parsedBody = JSON.parse(responseBody); // Convert JSON string to object
                log.error("parsedBody", parsedBody);
                token = parsedBody.access_token;
                log.error("token", token);

            } catch (e) {
                log.error('Error while sending request', e.message);
            }



            return token;

        }
        catch (e) {
            log.error('Error in hash generation', e);
            return {
                success: false,
                error: e.message
            };
        }
    }

    function sendData(body) {

        try {
            const webhookUrl = 'https://api.jyswms.com/update-inbound-shipment-id';
            // custsecret_wms_ai_portal_credientals
            const requestBody = body;
            var token = generateToken();

            log.error("token", token);
            log.error("result", JSON.stringify(body));
            const headers = {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            };

            const response = https.post({
                url: webhookUrl,
                body: JSON.stringify(requestBody),
                headers: headers
            });
            log.error("response", JSON.stringify(response));
            return {
                success: true,
                response: response
            };

        }
        catch (e) {
            log.error('Error sendData', e);
            return {
                success: false,
                error: e.message
            };
        }
    }


    return {
        afterSubmit
    };
});
