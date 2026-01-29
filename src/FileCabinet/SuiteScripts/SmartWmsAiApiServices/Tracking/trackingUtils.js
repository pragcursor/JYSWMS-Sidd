/**
 * @NApiVersion 2.x
 * @NModuleScope Public
 */
define(['N/record', 'N/search', 'N/log', 'N/runtime'], function (record, search, log, runtime) {

 
      
  
  function getShippingLineData(context, pageSize, startIndex) {
        try {
            var ScriptStartTime = new Date().getTime();
           // log.debug('Script Started', 'Start Time: ' + ScriptStartTime / 1000 + ' seconds');

            var scriptObj = runtime.getCurrentScript();
            var TrackingNumberSearchId = scriptObj.getParameter({ name: 'custscript_wms_ai_tracking_number_search' });
           // log.debug('Tracking Number Parameter', TrackingNumberSearchId);
            var Data = {};

            var TrackingNumberSearch = search.load({ id: 4753 });

            // Get total count using runPaged().count
            var totalCount = TrackingNumberSearch.runPaged().count;
            var totalPages = Math.ceil(totalCount / pageSize);

            // Apply pagination
            var searchResult = TrackingNumberSearch.run();
            var searchRange = searchResult.getRange({ start: startIndex, end: startIndex + pageSize });

            searchRange.forEach(function (result) {
                var internalId = result.getValue({ name: 'internalid' });
                var salesOrderId = result.getValue({ name: 'custrecord_tracking_number' });

                var recordData = {};

                result.columns.forEach(function (column) {
                    var columnName = toSnakeCase(column.label || column.name);
                    recordData[columnName] = result.getText(column) || result.getValue(column);
                });
                Data[internalId] = recordData;
            });

            var ScriptEndTime = new Date().getTime();
           // log.debug('Total Execution Time', ((ScriptEndTime - ScriptStartTime) / 1000) + ' seconds');



            return {
                status: 200,
                message: 'Data retrieved successfully',
                summary: {
                    total_records: totalCount,
                    total_pages: totalPages,
                    records_per_page: pageSize,
                    current_page: Math.floor(startIndex / pageSize) + 1,
                    pagination_info: {
                        start_index: startIndex,
                        end_index: startIndex + pageSize - 1,
                        has_next_page: (startIndex + pageSize) < totalCount,
                        has_previous_page: startIndex > 0
                    }
                },
                data: Data
            };

        } catch (e) {
            log.error("error message", e.message);
            return {
                status: 500,
                message: e.message
            };
        }
    }

     function markAsPicked(requestBody) {
        var headerId = null;
        try {
    
            const startTime = new Date().getTime();
    
            log.error('Incoming Data', JSON.stringify(requestBody));
            var savedTransfers = [];
            var savedHeaders = [];
            // STEP 1: Build existing SO map
            var existingMap = {};
    
    
            var headerSearch = search.create({
                type: 'customrecord_order_fulfillment_details',
                filters: [
                    ['custrecord_jyswms_approved', 'is', 'F'], 'AND',
                    ['custrecord_jyswms_rel_item_ful', 'isempty', '']
                ],
                columns: ['internalid', 'custrecord_jyswms_sales_order_id']
            });
            headerSearch.run().each(function (result) {
                existingMap[result.getValue('custrecord_jyswms_sales_order_id')] = result.id;
                return true;
            });
            log.error('Existing SO Map', JSON.stringify(existingMap));
    
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
                    var pickQty = Data.picked_quantity || so.quantity || 0;
                    var binId = Data.binInternalId || '';
                    var uniqueId = so.unique_id || '';
                    var locationId = Data.locationId || null;
    
                    var portalId = requestBody.portalId || requestBody.portalid;
                    var pickerName = requestBody.userName || requestBody.username || requestBody.pickerName;
                    var trackingNumbers = (so.labelData || []).map(function (label) {
                        return {
                            trackingNumber: label.sscc_code,
                            model: label.model
                        };
                    });
                    log.error('Processing SO', {
                        salesOrderId: salesOrderId,
                        itemId: itemId,
                        binId: binId,
                        locationId: locationId,
                        pickQty: pickQty
                    });
    
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
                    if (pickQty === null || pickQty === undefined || pickQty < 0) {
                        log.error('Invalid pickQty for sales order', { salesOrderId: salesOrderId, pickQty: pickQty });
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
                        log.error("Created new header record", headerId);
                    }
    
                    // STEP 4: Create Bin Transfer
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
    
                    log.error('BinTransfer Record - Before Save', {
                        salesOrderId: salesOrderId,
                        itemId: itemId,
                        pickQty: pickQty,
                        fromBin: binId,
                        toBin: bulkStageBin
                    });
    
                    // Save bin transfer with error handling
                    var savedId;
                    try {
                        savedId = binTransferRec.save();
                      //  log.error("BinTransfer savedId", savedId);
                    } catch (binTransferError) {
                        log.error('Failed to save bin transfer', {
                            error: binTransferError.message,
                            salesOrderId: salesOrderId,
                            itemId: itemId,
                            pickQty: pickQty
                        });
                        // Continue to next sales order instead of failing entire batch
                        continue;
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

                    // Initialize inventory adjustment ID
                    var invAdjId = "";

                    // Wrap entire negative inventory adjustment logic in try-catch block
                    try {
                        var soItemQuantity = so.quantity;
                       // log.error("soItemQuantity", soItemQuantity);

                        var userPickedQty = pickQty;
                      //  log.error("userPickedQty", userPickedQty);

                        // Calculate quantity difference
                        var qtyDiff = soItemQuantity - userPickedQty;
                        if (qtyDiff <= 0) {
                            log.error("✅ No adjustment needed — fully picked");
                            // Continue processing without adjustment
                        } else {
                            // Create inventory adjustment if there's a shortfall
                            var negativeQty = -qtyDiff;
                           // log.error("🧾 Negative inventory adjustment started");

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

                                    // 🔹 Step 1: Remove existing inventory assignment lines
                                    var existingLines = invDetail.getLineCount({ sublistId: 'inventoryassignment' });
                                    for (var k = existingLines - 1; k >= 0; k--) {
                                        invDetail.removeLine({ sublistId: 'inventoryassignment', line: k });
                                    }
                                    log.error(" Cleared Existing Inventory Lines", existingLines);

                                    // 🔹 Step 2: Add new inventory assignment
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

                                    // 🔹 Step 3: Verify values before commit
                                    var getBinID = invDetail.getCurrentSublistValue({
                                        sublistId: 'inventoryassignment',
                                        fieldId: 'binnumber'
                                    });
                                    var getQty = invDetail.getCurrentSublistValue({
                                        sublistId: 'inventoryassignment',
                                        fieldId: 'quantity'
                                    });

                                    log.error("📦 Inventory Assignment Details", {
                                        binId: getBinID,
                                        quantity: getQty
                                    });

                                    invDetail.commitLine({ sublistId: 'inventoryassignment' });
                                    log.error(" Inventory Assignment Added", "Bin: " + binId + ", Qty: " + negativeQty);

                                } catch (invDetailError) {
                                    log.error("❌ Inventory Detail Creation Failed", invDetailError.name + " | " + invDetailError.message);
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
                        //    log.error("🧾 Inventory Adjustment Summary Before Save", JSON.stringify(summary));

                            // Save record
                            invAdjId = inventoryAdjRec.save({
                                enableSourcing: true,
                                ignoreMandatoryFields: true
                            });

                            log.error("✅ Inventory Adjustment Created Successfully", invAdjId);
                        }
                    } catch (negativeInvError) {
                        log.error("❌ Negative Inventory Adjustment Error", {
                            error: negativeInvError.name + " | " + negativeInvError.message,
                            salesOrderId: salesOrderId,
                            itemId: itemId,
                            pickQty: pickQty
                        });
                        // Continue processing even if adjustment fails - invAdjId remains null
                    }

                    // Set bin transfer ID and inventory adjustment ID on the line
                    line.setCurrentSublistValue({ sublistId: 'recmachcustrecord_sales_order_header', fieldId: 'custrecord_item_bintransfer_id', value: savedId });
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
                        var trackLine = headerRec.selectNewLine({ sublistId: 'recmachcustrecord_jyswms_so_header' });
                        trackLine.setCurrentSublistValue({ sublistId: 'recmachcustrecord_jyswms_so_header', fieldId: 'custrecord_jyswms_track_item', value: itemId });
                        trackLine.setCurrentSublistValue({ sublistId: 'recmachcustrecord_jyswms_so_header', fieldId: 'custrecord_jyswms_track_number', value: track.trackingNumber });
                        trackLine.setCurrentSublistValue({ sublistId: 'recmachcustrecord_jyswms_so_header', fieldId: 'custrecord_jyswms_track_so_id', value: salesOrderId });
                        trackLine.setCurrentSublistValue({ sublistId: 'recmachcustrecord_jyswms_so_header', fieldId: 'custrecord_jyswms_track_qty', value: 1 });
                        trackLine.setCurrentSublistValue({ sublistId: 'recmachcustrecord_jyswms_so_header', fieldId: 'custrecord_jyswms_track_uniqueid', value: uniqueId });
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
                    var isApproved = (totalSOQty === totalPickedQty);
                    headerRec.setValue({
                        fieldId: 'custrecord_jyswms_approved',
                        value: isApproved ? true : false
                    });
    
                    log.error('Header Totals and Approval', {
                        totalSOQty: totalSOQty,
                        totalPickedQty: totalPickedQty,
                        approved: isApproved
                    });
    
                    // Save header record with error handling
                    try {
                        headerId = headerRec.save();
                       // log.error("Saved Header", headerId);
                        existingMap[salesOrderId] = headerId;
                        
                        // Add to response arrays for each sales order
                        savedTransfers.push(savedId);
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
                
                log.error("savedTransfers", savedTransfers);
                log.error("savedHeaders", savedHeaders);
            }
            const endTime = new Date().getTime();
    
            // Build expected JSON response
            const expectedResponse = {
                status: 'success',
                message: 'Items & tracking numbers processed successfully',
                binTransferId: savedTransfers,
                customRecID: savedHeaders
            };
            
            // Log the expected JSON response
            log.error('Expected JSON Response', JSON.stringify(expectedResponse));
    
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
    

    function toSnakeCase(str) {
        return str
            .trim()
            .replace(/[^a-zA-Z0-9 ]/g, '')
            .replace(/\s+/g, '_')
            .toLowerCase();
    }
  
    return {
        getShippingLineData: getShippingLineData,
        markAsPicked : markAsPicked
    };

  
});
