/**
 * @NApiVersion 2.1
 * @NScriptType Restlet
 */
define(['N/file', 'N/record', 'N/error', 'N/log', 'N/https', 'N/search', 'N/runtime',
    './Bin/binUtils',
    './Orders/orderUtils',
    './Orders/JY_so_picked_stats_EOD',
    './Items/itemUtils',
    './Inventory/inventoryUtils',
    './Locations/locationUtils',
    './Tracking/trackingUtils',
    './Returns/returnUtils',
    './partsPicking/partsPickedUtil',
    './markAsPicked/markAsPickedUtil'
], function (file, record, error, log, https, search, runtime, binUtils, orderUtils, jySoPickedStatsEOD, itemUtils,
    inventoryUtils, locationUtils, trackingUtils, returnUtils, partsPickedUtil, markAsPickedUtil) {

    function get(context) {
        try {
            //  log.error("GET Request Context", context);

            var action = context.action;

            // var id ='';
            if (!action) {
                return {
                    status: 400,
                    message: "Action is required in URL parameters"
                };
            }
            //  let relatedTransactionIds = [];

            //    log.debug("Action Requested", action);

            // Get pagination parameters with defaults
            var pageSize = parseInt(context.page_size) || 1000;
            var pageNumber = parseInt(context.page_number) || 1;
            var startIndex = (pageNumber - 1) * pageSize;

            switch (action) {

                case 'get_orders':
                    return orderUtils.getOrdersOptimized(context, pageSize, startIndex);
                case 'get_so_for_return':
                    return returnUtils.getSalesOrderForReturn(context);
                case 'get_poOrdersHistory':
                    return getPurchaseOrderHistory(context);
                case 'get_itemBasedInvoices':
                    return getItemBasedInvoices(context);
                case 'get_nonAmazonDropShipOrders':
                    return orderUtils.getNonAmazonDropShipOrders(context, pageSize, startIndex);
                case 'get_dropShipOrders':
                    return orderUtils.getDropShipOrders(context, pageSize, startIndex);
                case 'getDropShipOrdersPerOrder':
                    return orderUtils.getDropShipOrdersPerOrder(context, pageSize, startIndex);
                case 'getOrdersDUP':
                    return orderUtils.getOrdersDUP(context, pageSize, startIndex);
                case 'get_UnpickedOrders':
                    return orderUtils.getUnpicked(context, pageSize, startIndex);
                case 'getItemSalesPerCustomer':
                    return itemUtils.getItemSalesPerCustomer(context, pageSize, startIndex);
                case 'get_items':
                    return itemUtils.getItems(context, pageSize, startIndex);
                case 'get_ScapperIds':
                    return itemUtils.getScapperIds(context, pageSize, startIndex);
                case 'get_AllScapperIds':
                    return itemUtils.getAllScapperIds(context, pageSize, startIndex);
                case 'get_fedExEstimatedCost':
                    return itemUtils.getFedExEstimatedCost(context, pageSize, startIndex);
                case 'get_locations':
                    return locationUtils.getLocations(context, pageSize, startIndex);
                case 'get_bins':
                    return binUtils.getBins(context, pageSize, startIndex);
                case 'get_counts':
                    return inventoryUtils.getCounts(context, pageSize);
                case 'get_salesOrders':
                    return orderUtils.getOrdersOptimized(context, pageSize, startIndex);
                case 'get_allSalesOrders':
                    return getAllSalesOrders(context);
                case 'get_users':
                    return getUsers(context, pageSize, startIndex);
                case 'get_shippingLineData':
                    return trackingUtils.getShippingLineData(context, pageSize, startIndex);
                case 'get_inventory':
                    return inventoryUtils.getInventory(context, pageSize, startIndex);
                case 'get_fullfillOrders':
                    return orderUtils.getFullFillOrders(context, pageSize, startIndex);
                case 'get_binInventoryDetail':
                    return binUtils.getBinInventoryDetail(context);
                case 'get_inboundRecords':
                    return orderUtils.getInboundRecords(context, pageSize, startIndex);
                case 'get_ltlDashboardData':
                    return orderUtils.getLTLOrders(context);
                case 'lookForExistingRecords':
                    var response = lookForExistingRecords(context);
                    // Handle all possible string returns from the function
                    if (response && typeof response === 'string' && response.trim() !== '') {
                        log.debug('Record check', 'Record exists → returning true');
                        return true;
                    } else {
                        log.debug('Record check', 'No record found → returning false');
                        return false;
                    }
                case 'verify_cred':
                    return {
                        success: true
                    };
                default:
                    return {
                        status: 400,
                        message: "Invalid action specified"
                    };
            }
        } catch (e) {
            log.error("Error in GET method", e);

            return {
                status: 500,
                message: e.message
            };
        }
    }



    /**
   * Optimized version of your getOrders function.
   * - Option A uniqueness: one entry per item_internalid + "_" + binId
   * - Parses columns only once per item row
   * - Merges base item data with bin rows from getBinTransferinfo()
   */

    function getOrdersOptimized(context, pageSize, startIndex) {
        try {
            var scriptStartTime = new Date().getTime();
            var scriptObj = runtime.getCurrentScript();
            var SalesOrderHeaderId = scriptObj.getParameter({ name: 'custscript_wms_ai_salesorder_header' });
            var SalesOrderItemLevelDataId = scriptObj.getParameter({ name: 'custscript_wms_ai_salesorder_items' });

            var pickedItemUniqueIds = getPickedItemUniqueIds();
            var pickedItemUniqueIdsMap = getPickedItemUniqueIdsMap();

            var itemPrimaryUnitsMap = itemPrimaryUnits();

            var headerData = {};
            var filters = [];

            if (context.customer_id) {
                filters.push(['entity', 'anyof', context.customer_id]);
            }
            if (context.start_date && context.end_date) {
                filters.push('AND', ['trandate', 'within', context.start_date, context.end_date]);
            }

            // Load header search and apply additional filters
            var headerSearch = search.load({ id: 4761 });
            if (filters.length > 0) {
                headerSearch.filters = (headerSearch.filters || []).concat(filters);
            }

            var totalCount = headerSearch.runPaged().count;
            var totalPages = Math.ceil(totalCount / pageSize);

            var searchResult = headerSearch.run();
            var searchRange = searchResult.getRange({ start: startIndex, end: startIndex + pageSize });
            var headerIds = [];

            // Build headerData map (parse columns once per header row)
            searchRange.forEach(function (result) {
                var internalID = result.getValue({ name: 'internalid' });
                if (internalID) headerIds.push(internalID);

                var recordData = {};
                result.columns.forEach(function (column) {
                    var columnName = toSnakeCase(column.label || column.name);
                    recordData[columnName] = result.getText(column) || result.getValue(column);
                });

                headerData[internalID] = recordData;
            });

            // If you want to prefetch bin transfers for all headers, implement getBinTransferData(headerIds)
            // var getBinTransfers = headerIds.length > 0 ? getBinTransferData(headerIds) : {};

            // Load item-level search and apply filters
            var itemSearch = search.load({ id: SalesOrderItemLevelDataId });
            if (filters.length > 0) {
                itemSearch.filters = (itemSearch.filters || []).concat(filters);
            }

            var cartonsIds = {}; // carton counter per internalID
            var itemSearchResult = itemSearch.run();
            var itemSearchRange = itemSearchResult.getRange({ start: startIndex, end: startIndex + pageSize });

            // Helper: safe parse int
            function safeInt(v, fallback) {
                var n = parseInt(v);
                return (isNaN(n) ? (fallback === undefined ? "" : fallback) : n);
            }
            function safeFloat(v, fallback) {
                var n = parseFloat(v);
                return (isNaN(n) ? (fallback === undefined ? "" : fallback) : n);
            }

            itemSearchRange.forEach(function (result) {
                var internalID = result.id;
                if (!internalID) return;

                // init carton counter
                if (!cartonsIds[internalID]) cartonsIds[internalID] = 1;

                // ensure header row exists
                if (!headerData[internalID]) return;
                if (!headerData[internalID].itemDetails) headerData[internalID].itemDetails = [];

                // Parse item-level columns ONCE and build baseItemData
                var baseItemData = {};
                var so_items_str = "";
                var parsedSoItemsArr = [];
                var lineQuantityRaw = 0;
                var item_internalid = result.getValue({ name: 'item' }); // keep item internal id
                var unique_id_val = ""; // keep original unique_id (if present)

                result.columns.forEach(function (column) {
                    var columnName = toSnakeCase(column.label || column.name);
                    var valueText = result.getText(column) || result.getValue(column);

                    // capture the raw quantity column separately (we'll use it for carton calc / conversions)
                    if (columnName === "quantity") {
                        lineQuantityRaw = parseInt(valueText) || 0;
                    }

                    if (columnName === "so_items") {
                        so_items_str = valueText || "";
                        if (so_items_str) {
                            var arr = so_items_str.split(";").map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; });
                            parsedSoItemsArr = arr;
                        }
                        baseItemData["so_items"] = so_items_str;
                    } else if (columnName === "unique_id") {
                        unique_id_val = valueText || "";
                        // do not write to baseItemData.unique_id here — the final unique_id will be appended with binIndex later
                        baseItemData["unique_id"] = valueText || "";
                    } else {
                        baseItemData[columnName] = valueText;
                    }
                });

                // Primary Unit Conversion applied once to lineQuantityRaw
                var convertedLineQuantity = lineQuantityRaw;
                if (itemPrimaryUnitsMap && itemPrimaryUnitsMap[item_internalid]) {
                    var itemObj = itemPrimaryUnitsMap[item_internalid];
                    var rate = parseInt(itemObj?.rate || 1);
                    if (rate > 0) convertedLineQuantity = Math.floor(lineQuantityRaw / rate);
                }

                // Prepare cartonInfo base properties used per bin
                var itemslength = parsedSoItemsArr.length || 0;

                // Get bin rows for this item/result — helper returns an ARRAY (guaranteed)
                var existBinArr = getBinTransferinfo(result); // always array

                // Safety: ensure it's an array
                if (!Array.isArray(existBinArr) || existBinArr.length === 0) {
                    existBinArr = [{
                        internalId: "",
                        binId: "",
                        binNumber: "",
                        relatedSalesOrder: "",
                        item: "",
                        quantity: "",
                        binIndex: ""
                    }];
                }

                // ensure header-level tracking for uniqueness
                if (!headerData[internalID]._addedKeys) headerData[internalID]._addedKeys = {};

                // For each bin row, build a final itemData by merging baseItemData and bin-specific fields
                for (var b = 0; b < existBinArr.length; b++) {
                    var binObj = existBinArr[b] || {};

                    // Use Option A uniqueness: item_internalid + "_" + binId
                    var uniqueKey = (item_internalid || "") + "_" + (binObj.binId || "");

                    // Skip if already added for this item+bin
                    if (headerData[internalID]._addedKeys[uniqueKey]) {
                        continue;
                    }

                    // Mark as added
                    headerData[internalID]._addedKeys[uniqueKey] = true;

                    // Determine number of cartons (car)
                    var car = safeInt(binObj.quantity, 0);
                    if (!car || car <= 0) {
                        car = convertedLineQuantity || 0;
                    }

                    // Build cartonInfo array
                    var cartonInfo = [];
                    for (var ci = 0; ci < (car || 0); ci++) {
                        var num = cartonsIds[internalID];
                        var carton = num + " of " + (itemslength || 0);
                        cartonInfo.push(carton);
                        cartonsIds[internalID] = num + 1;
                    }

                    // Build final merged itemData (clone baseItemData -> override/add bin fields)
                    var itemData = Object.assign({}, baseItemData);

                    // Set unique_id to include bin index so it stays unique per bin if base had unique_id
                    var uniqueIdToSet = (unique_id_val ? unique_id_val + "_" + (binObj.binIndex || (b + 1)) : (item_internalid + "_" + (binObj.binIndex || (b + 1))));
                    itemData["unique_id"] = uniqueIdToSet;

                    // Bin-specific fields (guaranteed keys with empty fallback)
                    itemData["cartonInfo"] = cartonInfo;
                    itemData["quantity"] = safeInt(binObj.quantity, ""); // quantity to pick from this bin (number or "")
                    itemData["bin_id"] = safeInt(binObj.binId, "");
                    itemData["bin_index"] = safeInt(binObj.binIndex, "");
                    // Preserve bin name as text (do not parseInt)
                    itemData["bin_name"] = (binObj.binNumber === "" ? "" : binObj.binNumber || "");
                    itemData["bin_transfer_internalid"] = (binObj.internalId === "" ? "" : binObj.internalId || "");
                    itemData["item_quantity"] = convertedLineQuantity; // total item qty (after unit conversion)
                    // Keep or override other commonly expected fields from headerData (optional)
                    // e.g., transaction_id, name, location, ship_date, etc are already present in baseItemData or headerData

                    // Some additional derived fields you had before
                    // asin_type_TEST logic (reuse parsedSoItemsArr)
                    if (parsedSoItemsArr.length === 1) {
                        var amazonId = result.getText({ name: "custitem129", join: "item" }) || result.getValue({ name: "custitem129", join: "item" });
                        itemData["asin_type_TEST"] = "SINGLE ASIN -" + (amazonId || "");
                    } else {
                        itemData["asin_type_TEST"] = "MIXED SKU";
                    }

                    // push into headerData items
                    headerData[internalID].itemDetails.push(itemData);
                } // end bin loop
            }); // end itemSearchRange.forEach

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
                data: headerData
            };
        } catch (e) {
            log.error("Error in getOrdersOptimized function", e);
            return {
                status: 500,
                message: e.message
            };
        }
    }

    function getItemBasedInvoices(request) {
        try {
            var soSearch = search.load({ id: 4731 });

            var pageSize = 1000;
            var pageNumber = request.page ? parseInt(request.page, 10) : 1;

            var pagedData = soSearch.runPaged({ pageSize: pageSize });
            var totalPages = pagedData.pageRanges.length;
            var totalRecords = pagedData.count;

            if (pageNumber < 1 || pageNumber > totalPages) {
                return {
                    status: 400,
                    message: 'Invalid page number. Must be between 1 and ' + totalPages
                };
            }

            var page = pagedData.fetch({ index: pageNumber - 1 });
            var results = [];

            page.data.forEach(function (result) {
                var row = {};

                soSearch.columns.forEach(function (col) {
                    var rawKey = col.label || col.name;
                    var key = toSnakeCase(rawKey);

                    var text = result.getText(col);
                    var value = result.getValue(col);

                    row[key] = (text !== null && text !== '') ? text : value;
                });

                results.push(row);
            });


            var startIndex = (pageNumber - 1) * pageSize;
            var endIndex = startIndex + results.length - 1;

            return {
                status: 200,
                message: 'Data retrieved successfully',
                summary: {
                    total_records: totalRecords,
                    total_pages: totalPages,
                    records_per_page: pageSize,
                    current_page: pageNumber,
                    pagination_info: {
                        start_index: startIndex,
                        end_index: endIndex,
                        has_next_page: pageNumber < totalPages,
                        has_previous_page: pageNumber > 1
                    }
                },
                data: results
            };

        } catch (e) {
            return {
                status: 500,
                message: 'Error retrieving data',
                error: e.message
            };
        }
    }

    function getPurchaseOrderHistory(request) {
        try {
            var soSearch = search.load({ id: 4810 });

            var pageSize = 1000;
            var pageNumber = request.page ? parseInt(request.page, 10) : 1;

            var pagedData = soSearch.runPaged({ pageSize: pageSize });
            var totalPages = pagedData.pageRanges.length;
            var totalRecords = pagedData.count;

            if (pageNumber < 1 || pageNumber > totalPages) {
                return {
                    status: 400,
                    message: 'Invalid page number. Must be between 1 and ' + totalPages
                };
            }

            var page = pagedData.fetch({ index: pageNumber - 1 });
            var results = [];

            page.data.forEach(function (result) {
                var row = {};

                soSearch.columns.forEach(function (col) {
                    var rawKey = col.label || col.name;
                    var key = toSnakeCase(rawKey);

                    var text = result.getText(col);
                    var value = result.getValue(col);

                    row[key] = (text !== null && text !== '') ? text : value;
                });

                results.push(row);
            });


            var startIndex = (pageNumber - 1) * pageSize;
            var endIndex = startIndex + results.length - 1;

            return {
                status: 200,
                message: 'Data retrieved successfully',
                summary: {
                    total_records: totalRecords,
                    total_pages: totalPages,
                    records_per_page: pageSize,
                    current_page: pageNumber,
                    pagination_info: {
                        start_index: startIndex,
                        end_index: endIndex,
                        has_next_page: pageNumber < totalPages,
                        has_previous_page: pageNumber > 1
                    }
                },
                data: results
            };

        } catch (e) {
            return {
                status: 500,
                message: 'Error retrieving data',
                error: e.message
            };
        }
    }

    function toSnakeCase(str) {
        return str
            .toLowerCase()
            .trim()
            .replace(/[^\w\s]/g, '')   // remove special chars
            .replace(/\s+/g, '_');     // spaces → underscore
    }



    // Cleaned / unchanged helper — returns ARRAY of bin rows (guaranteed)
    function getBinTransferinfo(result) {
        try {
            var lineUniqueId = result.getValue({ name: 'lineuniquekey' });
            var binTransferInternalId = result.getValue({ name: 'custcol_line_level_bin_tranfer_ref' });
            var binData = result.getValue({ name: 'custcol_bin_transfer_details' });
            var itemId = result.getValue({ name: 'item' });
            var soId = result.id;

            var rows = [];

            // CASE: No binData → return single empty row (so caller always gets array)
            if (!binData || binData === "") {
                return [{
                    internalId: "",
                    binId: "",
                    binNumber: "",
                    relatedSalesOrder: "",
                    item: "",
                    quantity: "",
                    binIndex: ""
                }];
            }

            // Remove trailing ##
            binData = binData.replace(/##$/, "");

            var parts = binData.split("@@");

            // Remove first element (item internal id) if present
            if (parts.length > 0) parts.shift();

            for (var i = 0; i < parts.length; i += 2) {
                var binId = parts[i];
                var qty = parts[i + 1];

                if (!binId || !qty) continue;

                rows.push({
                    internalId: binTransferInternalId || "",
                    binId: safeParseInt(binId),
                    binNumber: result.getText("custbodycustbody_item_bin") || "",
                    relatedSalesOrder: soId || "",
                    item: itemId || "",
                    quantity: safeParseFloat(qty),
                    binIndex: (i / 2) + 1 || ""
                });
            }

            if (rows.length === 0) {
                return [{
                    internalId: "",
                    binId: "",
                    binNumber: "",
                    relatedSalesOrder: "",
                    item: "",
                    quantity: "",
                    binIndex: ""
                }];
            }

            return rows;
        } catch (e) {
            log.error("ERR_getBinTransferinfo", e);
            return [{
                internalId: "",
                binId: "",
                binNumber: "",
                relatedSalesOrder: "",
                item: "",
                quantity: "",
                binIndex: ""
            }];
        }

        // local helpers used by the helper
        function safeParseInt(v) {
            var n = parseInt(v);
            return isNaN(n) ? "" : n;
        }
        function safeParseFloat(v) {
            var n = parseFloat(v);
            return isNaN(n) ? "" : n;
        }
    }


    function post(context) {
        try {

            log.error("POST Request Context", context);

            var action = context.action;
            // log.debug('action',action)
            var id = "";
            //var action = "No permission";
            if (!action) {
                return {
                    status: 400,
                    message: "Action is required in URL parameters"
                };
            }
            var isExistsResp = ""
            // if (action == "post_returnOrders") {
            //     return returnUtils.processReturn(context);
            // }
            if (action == "submitPallet") {
                try {


                    var portalId = context.portalId;
                    //log.error("function in portalId", portalId);

                    var mySearch = search.create({
                        type: 'customrecord_wms_ai_api_custom_rec',
                        filters: [
                            ['custrecordwms_ai_api_custrec_portalid', 'is', portalId]
                        ],
                        columns: [
                            search.createColumn({ name: "internalid" }),
                            search.createColumn({ name: "custrecord_wms_ai_api_custrec_response" })
                        ]
                    });

                    var searchResult = mySearch.run().getRange({ start: 0, end: 1 }) || [];

                    if (searchResult.length > 0 && searchResult[0]) {
                        var firstResult = searchResult[0];
                        var responseValue = firstResult.getValue({ name: "internalid" });
                        id = responseValue || '';
                        log.audit('Record found', id);
                    } else {
                        log.audit('No existing record found for portalId', portalId);
                        id = "";
                    }

                } catch (e) {
                    log.error("Error in lookForExistingRecords", e.message);
                    id = "";
                }

            }
            if (action == "dropShipmentData") {
                try {
                    var shipmentConfirmId = context.shipment_confirm_id || context.portalId || "";
                    //log.error("function in shipmentConfirmId", shipmentConfirmId);

                    if (!shipmentConfirmId) {
                        log.audit('No shipment_confirm_id or portalId provided for dropShipmentData');
                        id = "";
                    } else {
                        var mySearch = search.create({
                            type: 'customrecord_jyswms_dropship_orders',
                            filters: [
                                ['custrecord_jyswms_shipment_confirm_id', 'is', shipmentConfirmId]
                            ],
                            columns: [
                                search.createColumn({ name: "internalid" })
                            ]
                        });

                        var searchResult = mySearch.run().getRange({ start: 0, end: 1 }) || [];

                        if (searchResult.length > 0 && searchResult[0]) {
                            var firstResult = searchResult[0];
                            var responseValue = firstResult.getValue({ name: "internalid" });
                            id = responseValue || '';
                            log.audit('Drop Ship Record found', id);
                        } else {
                            log.audit('No existing record found for shipment_confirm_id', shipmentConfirmId);
                            id = "";
                        }
                    }

                } catch (e) {
                    log.error("Error in dropShipmentData lookForExistingRecords", e.message);
                    id = "";
                }

            }
            if (action != "submitPallet" && action != "dropShipmentData" && action !== "post_returnOrders") {
                isExistsResp = lookForExistingRecords(context);
            }
            // if (action != "submitPallet") {
            //     isExistsResp = lookForExistingRecords(context);
            // }
            if (isExistsResp) {
                log.error("Already exists, Response : ", isExistsResp);
                return isExistsResp
            }

            let recType = '';

            switch (action) {
                case 'fullfillOrders':
                    recType = 'Item Fulfillment';
                    break;
                case 'binCount':
                    recType = 'Inventory Adjustment';
                    break;
                case 'binAdjustment':
                    recType = 'Inventory Adjustment';
                    break;
                case 'binTransfer':
                    recType = 'Bin Transfer';
                    break;
                case 'receiveInbound':
                    recType = 'inbound Shipment';
                    break;
                case 'submitBOL':
                    recType = 'submit BOL';
                    break;
                case 'submitPallet':
                    recType = 'Submit Pallet';
                    break;
                case 'fullFillPartsOrders':
                    recType = 'fullFill parts orders';
                    break;
                case 'markAsPicked':
                    recType = "markAsPicked";
                    break;
                case 'dropShipmentData':
                    recType = "dropShipmentData";
                    break;
                case 'submitRMA':
                    recType = "submitRMA";
                    break;
                case 'post_returnOrders':
                    recType = 'Return Order';
                    break;
                case 'sopicked_endoftheday':
                    recType = 'Sales Order'
                    break;
                default:
                    return {
                        status: 400,
                        message: "Invalid action specified"
                    };
            }


            //=========================== WMS AI API custom Record ================================
            try {

                var rec = record.create({
                    type: 'customrecord_wms_ai_api_custom_rec',
                    isDynamic: true
                });

                if (context.portalId) {
                    rec.setValue({
                        fieldId: 'custrecordwms_ai_api_custrec_portalid',
                        value: context.portalId
                    });
                }
                if (context.portalId == null || context.portalId === '' || context.portalId === undefined) {
                    return {
                        status: 400,
                        message: "Portal ID Missing"
                    };
                }

                if (context.action) {
                    rec.setValue({
                        fieldId: 'custrecordwms_ai_api_custrec_action',
                        value: context.action
                    });
                }

                rec.setValue({
                    fieldId: 'custrecordwms_ai_api_custrec_json_data',
                    value: JSON.stringify(context, null, 2)
                });


                if (context.containerName || context.binName || id) {
                    var combinedValue = [
                        context.containerName,
                        context.binName,
                        id
                    ].filter(Boolean).join(', ');

                    rec.setValue({
                        fieldId: 'custrecord_wms_ai_api_custrec_rel_name',
                        value: combinedValue
                    });
                }

                if (recType) {
                    rec.setValue({
                        fieldId: 'custrecordwms_ai_api_custrec_rectype',
                        value: recType
                    });
                }

                rec.setValue({
                    fieldId: 'custrecordwms_ai_api_custrec_userid',
                    value: context.userName || context.username
                });

                if (context.location) {

                    var locationId = context.location;
                    if (locationId == "15" || locationId == " L60-Hardeeville_SC") {
                        locationId = 15;
                    }
                    else {
                        locationId = 9;
                    }
                    rec.setValue({
                        fieldId: 'custrecord_wms_ai_api_custrec_location',
                        value: locationId
                    });
                }

                rec.setValue({
                    fieldId: 'custrecord_wms_ai_api_custrec_status',
                    value: 1
                });

                id = rec.save();
                log.debug('Custom Record Created', 'ID: ' + id);

            } catch (innerErr) {
                log.error("Error saving custom record", innerErr.message);
            }


            var response = '';
            switch (action) {
                case 'post_returnOrders':
                    response = returnUtils.processReturn(context.data);
                    break;
                case 'fullfillOrders':
                    response = FullFillOrders(context, id);
                    break;
                case 'binCount':
                    response = binUtils.binCount(context, id);
                    break;
                case 'binAdjustment':
                    response = binUtils.binAdjustment(context, id);
                    break;
                case 'submitBOL':
                    response = orderUtils.createImageFile(context, id);
                    break;
                case 'submitPallet':
                    response = orderUtils.processPalletUpdate(context);
                    break;
                case 'sopicked_endoftheday':
                    response = jySoPickedStatsEOD.sopicked_endoftheday(context);
                    break;
                case 'binTransfer':
                    response = binUtils.binTransfer(context, id);
                    break;
                case 'markAsPicked':
                   // log.error("Context before markAsPicked", context);
                   // response = markAsPickedUtil.markAsPicked(context.data);
                     response = markAsPicked(context, id);
                    break;
                case 'fullFillPartsOrders':
                    response = partsPickedUtil.fullFillPartsOrder(context, id);
                    break;
                case 'dropShipmentData':
                    response = dropShipmentData(context);
                    break;
                case 'receiveInbound':
                    response = orderUtils.transformInboundShipmentToItemReceipt(context, id);

                    log.error("Response and InboundId", "response: " + JSON.stringify(response) + ", inboundId: " + response.itemReceiptId);

                    var inboundId = response.itemReceiptId;

                    try {
                        var inboundRec = record.load({
                            type: 'inboundshipment',
                            id: inboundId
                        });


                        var inboundIdSaved = inboundRec.save();

                    } catch (e) {
                        log.error("log.error", e.message);
                    }

                    //Mandatory 3 times record loading is required,, plz do not modify
                    try {

                        var inboundRec = record.load({
                            type: 'inboundshipment',
                            id: inboundId
                        });

                        var inboundIdSaved = inboundRec.save();

                    } catch (e) {
                        log.error("log.error", e.message);
                    }


                    if (!inboundId) {
                        log.error("No inbound if blockinboundId", inboundId);
                        inboundId = context.inboundShipmentId
                    }

                    var params = {
                        inboundShipmentID: inboundId,
                        pageSize: 1000
                    };

                    var inboundRec = record.load({
                        type: 'inboundshipment',
                        id: inboundId
                    });

                    var inboundIdSaved = inboundRec.save();
                    var startIndex = 0;
                    var pageSize = 1000;
                    var response = orderUtils.getInboundRecords(params, pageSize, startIndex);
                    var status = sendData(response);
                    break;

                default:
                    return {
                        status: 400,
                        message: "Invalid action specified"
                    };
            }

            record.submitFields({
                type: 'customrecord_wms_ai_api_custom_rec',
                id: id,
                values: {
                    custrecord_wms_ai_api_custrec_response: JSON.stringify(response),
                    custrecord_wms_ai_api_custrec_status: 2
                }
            });
            log.error("Request - Netsuite Response", response);

            return response;

        } catch (e) {
            log.error("error in main restlet", e);
            record.submitFields({
                type: 'customrecord_wms_ai_api_custom_rec',
                id: id,
                values: {
                    custrecordwms_ai_api_custrec_error: e.message,
                    custrecord_wms_ai_api_custrec_status: 3
                }
            });
        }
    }

    //Ship confirmation data

    function dropShipmentData(requestBody) {

        try {

            log.error("Incoming JSON", JSON.stringify(requestBody));

            // Your requestBody is a single object, not an array
            var data = requestBody;

            var location = data.location || "";
            var shipMethod = data.ship_method || "";
            var trailerId = data.trailer_id || "";
            var arrivalDate = data.date_of_arrival || "";
            var shipmentConfirmId = data.shipment_confirm_id || data.portalId || "";


            // Determine location_id based on location value
            var locationInternalId;
            if (location === "Flemington L41") {
                locationInternalId = 9;
            } else {
                locationInternalId = 15;
            }

            log.error("Location ID Determined", {
                location: location,
                locationInternalId: locationInternalId
            });

            log.error("Extracted Header Fields", {
                location: location,
                locationInternalId: locationInternalId,
                shipMethod: shipMethod,
                trailerId: trailerId,
                arrivalDate: arrivalDate,
                shipmentConfirmId: shipmentConfirmId
            });

            var rawDataItems = Array.isArray(data.data)
                ? data.data
                : [];

            var trackingObjects = [];

            try {
                rawDataItems.forEach(function (item) {
                    if (!item) return;

                    var trackingNumber = item.tracking_number || "";
                    var itemSku = item.item || "";
                    var userName = item.user_name || "";
                    var scannedAt = item.scanned_at || "";

                    trackingObjects.push({
                        item: itemSku,
                        tracking_number: trackingNumber,
                        user_name: userName,
                        scanned_at: scannedAt
                    });
                });
            } catch (e) {
                log.error("Error Processing Data Items", e);
                throw e; // Re-throw to be caught by outer catch
            }

            // Validation check
            if (!trackingObjects.length) {
                log.error("Validation Failed: No data items provided", {
                    rawDataItemsCount: rawDataItems.length,
                    trackingObjectsCount: trackingObjects.length
                });
                return {
                    status: "error",
                    message: "No data items provided"
                };
            }

            log.error("Data Items Processed Successfully", {
                itemsCount: trackingObjects.length
            });

            log.error("Processing Shipment", {
                location: location,
                shipMethod: shipMethod,
                trailerId: trailerId,
                arrivalDate: arrivalDate,
                dataItemsCount: trackingObjects.length,
                shipmentConfirmId: shipmentConfirmId
            });

            // Validation: shipment_confirm_id is required
            if (!shipmentConfirmId) {
                log.error("Validation Failed: shipment_confirm_id is required", {
                    dataKeys: Object.keys(data)
                });
                return {
                    status: "error",
                    message: "shipment_confirm_id or portalId is required"
                };
            }

            // Check if record exists with matching shipment_confirm_id or portalId
            var existingRecordId = null;
            try {
                log.error("Searching for Existing Record", { shipmentConfirmId: shipmentConfirmId });
                var existingSearch = search.create({
                    type: "customrecord_jyswms_dropship_orders",
                    filters: [
                        ["custrecord_jyswms_shipment_confirm_id", "is", shipmentConfirmId]
                    ],
                    columns: ['internalid']
                });

                existingSearch.run().each(function (result) {
                    existingRecordId = result.id;
                    return false; // Stop after first match
                });

                if (existingRecordId) {
                    log.error("Found Existing Record", { existingRecordId: existingRecordId });
                } else {
                    log.error("No Existing Record Found - Will Create New", { shipmentConfirmId: shipmentConfirmId });
                }
            } catch (searchErr) {
                log.error("Error Searching for Existing Record", {
                    error: searchErr,
                    shipmentConfirmId: shipmentConfirmId
                });
                // Continue to create new record if search fails
            }

            var headerRec;
            try {
                if (existingRecordId) {
                    // Load existing record
                    headerRec = record.load({
                        type: "customrecord_jyswms_dropship_orders",
                        id: existingRecordId,
                        isDynamic: true
                    });
                    log.error("Loading Existing Record", { recordId: existingRecordId });
                } else {
                    // Create new record
                    headerRec = record.create({
                        type: "customrecord_jyswms_dropship_orders",
                        isDynamic: true
                    });
                    log.error("Creating New Record");
                }
            } catch (e) {
                log.error("Error Loading/Creating Header Record", e);
                throw e; // Re-throw to be caught by outer catch
            }

            try {
                // Update header fields (for both new and existing records)
                log.error("Setting Header Fields", {
                    hasLocation: !!location,
                    locationInternalId: locationInternalId,
                    hasShipMethod: !!shipMethod,
                    hasTrailerId: !!trailerId,
                    hasArrivalDate: !!arrivalDate
                });

                // Set location_id based on location value (not the location field itself)
                headerRec.setValue("custrecord_jyswms_location_id", locationInternalId);
                log.error("Location ID Set", {
                    location: location,
                    locationInternalId: locationInternalId
                });
                if (shipMethod) {
                    headerRec.setValue("custrecord_jyswms_ship_method", shipMethod);
                }
                if (trailerId) {
                    headerRec.setValue("custrecord_jyswms_trailer_id", trailerId);
                }

                // Parse arrival date string into a Date object for NetSuite
                if (arrivalDate) {
                    var arrivalDateObj = null;
                    try {
                        // Expecting M/D/YYYY like "11/27/2025"
                        arrivalDateObj = new Date(arrivalDate);
                    } catch (dateErr) {
                        log.error("Invalid arrivalDate format", {
                            rawValue: arrivalDate,
                            error: dateErr && dateErr.message
                        });
                    }

                    if (arrivalDateObj && !isNaN(arrivalDateObj.getTime())) {
                        headerRec.setValue("custrecord_jyswms_date_of_arrival", arrivalDateObj);
                    } else {
                        log.error("Skipping date_of_arrival, could not parse to valid Date", arrivalDate);
                    }
                }

                if (shipmentConfirmId) {
                    headerRec.setValue("custrecord_jyswms_shipment_confirm_id", shipmentConfirmId);
                }

                // Save complete incoming JSON (append or update)
                headerRec.setValue("custrecord_jyswms_json", JSON.stringify(data));

                log.error("Starting Sublist Processing", {
                    totalLines: trackingObjects.length
                });

                var addedLinesCount = 0;
                var skippedLinesCount = 0;

                for (var i = 0; i < trackingObjects.length; i++) {

                    var tr = trackingObjects[i];
                    log.error("Processing Sublist Line", {
                        lineIndex: i + 1,
                        totalLines: trackingObjects.length,
                        item: tr.item,
                        trackingNumber: tr.tracking_number
                    });

                    try {
                        // Check if line already exists with same tracking_number and item
                        var lineExists = false;
                        var existingLineCount = headerRec.getLineCount({
                            sublistId: "recmachcustrecord_jyswms_header_id"
                        });

                        log.error("Checking Existing Lines", {
                            existingLineCount: existingLineCount,
                            item: tr.item,
                            trackingNumber: tr.tracking_number
                        });

                        // Loop through existing lines to check for duplicates
                        for (var j = 0; j < existingLineCount; j++) {
                            var existingTrackingNumber = headerRec.getSublistValue({
                                sublistId: "recmachcustrecord_jyswms_header_id",
                                fieldId: "custrecord_jyswms_tracking_number",
                                line: j
                            }) || "";

                            var existingItem = headerRec.getSublistValue({
                                sublistId: "recmachcustrecord_jyswms_header_id",
                                fieldId: "custrecord_jyswms_tracking_item",
                                line: j
                            }) || "";

                            // Check if both tracking_number and item match
                            if (existingTrackingNumber === tr.tracking_number && existingItem === tr.item) {
                                lineExists = true;
                                log.error("Duplicate Line Found - Skipping", {
                                    lineIndex: j + 1,
                                    item: tr.item,
                                    trackingNumber: tr.tracking_number,
                                    existingItem: existingItem,
                                    existingTrackingNumber: existingTrackingNumber
                                });
                                break; // Exit loop once match is found
                            }
                        }

                        // If line already exists, skip adding it
                        if (lineExists) {
                            skippedLinesCount++;
                            log.error("Skipping Duplicate Line", {
                                item: tr.item,
                                trackingNumber: tr.tracking_number,
                                skippedCount: skippedLinesCount
                            });
                            continue; // Skip to next iteration
                        }

                        // Line doesn't exist, proceed with adding new line
                        log.error("No Duplicate Found - Adding New Line", {
                            item: tr.item,
                            trackingNumber: tr.tracking_number
                        });

                        headerRec.selectNewLine({
                            sublistId: "recmachcustrecord_jyswms_header_id"
                        });

                        headerRec.setCurrentSublistValue({
                            sublistId: "recmachcustrecord_jyswms_header_id",
                            fieldId: "custrecord_jyswms_tracking_item",
                            value: tr.item
                        });

                        headerRec.setCurrentSublistValue({
                            sublistId: "recmachcustrecord_jyswms_header_id",
                            fieldId: "custrecord_jyswms_tracking_number",
                            value: tr.tracking_number
                        });

                        headerRec.setCurrentSublistValue({
                            sublistId: "recmachcustrecord_jyswms_header_id",
                            fieldId: "custrecord_jyswms_tracking_user",
                            value: tr.user_name
                        });

                        // Parse scanned_at string into Date object for NetSuite (OPTIONAL FIELD)
                        var scannedDateObj = null;
                        if (tr.scanned_at && tr.scanned_at.trim()) {
                            try {
                                // Parse format like "10:50 am 12/01/2026" or "10:50 am 12/1/2026"
                                var scannedAtStr = tr.scanned_at.trim();

                                // Try direct parsing first
                                scannedDateObj = new Date(scannedAtStr);

                                // If direct parsing fails, try to parse manually
                                if (isNaN(scannedDateObj.getTime())) {
                                    // Format: "10:50 am 12/01/2026"
                                    // Extract time and date parts
                                    var parts = scannedAtStr.split(' ');
                                    if (parts.length >= 3) {
                                        var timeStr = parts[0] + ' ' + parts[1]; // "10:50 am"
                                        var dateStr = parts.slice(2).join(' '); // "12/01/2026"

                                        // Combine and parse
                                        var combinedStr = dateStr + ' ' + timeStr;
                                        scannedDateObj = new Date(combinedStr);
                                    }
                                }

                                // Validate the date
                                if (isNaN(scannedDateObj.getTime())) {
                                    log.error("Invalid scanned_at date format (field is optional, skipping)", {
                                        scanned_at: tr.scanned_at,
                                        item: tr.item
                                    });
                                    scannedDateObj = null;
                                }
                            } catch (dateErr) {
                                log.error("Error parsing scanned_at date (field is optional, skipping)", {
                                    scanned_at: tr.scanned_at,
                                    item: tr.item,
                                    error: dateErr.message || dateErr.toString()
                                });
                                scannedDateObj = null;
                            }
                        }

                        // Only set the field if we have a valid date (field is optional)
                        if (scannedDateObj && !isNaN(scannedDateObj.getTime())) {
                            headerRec.setCurrentSublistValue({
                                sublistId: "recmachcustrecord_jyswms_header_id",
                                fieldId: "custrecord_jyswms_scanned_data",
                                value: scannedDateObj
                            });
                            log.error("Scanned Date Set Successfully", {
                                item: tr.item,
                                scanned_at: tr.scanned_at,
                                parsedDate: scannedDateObj
                            });
                        }
                        // Field is optional - if not provided or invalid, simply skip (no error)

                        headerRec.commitLine({
                            sublistId: "recmachcustrecord_jyswms_header_id"
                        });
                        addedLinesCount++;
                        log.error("Sublist Line Committed Successfully", {
                            lineIndex: i + 1,
                            item: tr.item,
                            addedCount: addedLinesCount
                        });
                    } catch (lineErr) {
                        log.error("Error Processing Sublist Line", {
                            lineIndex: i + 1,
                            totalLines: trackingObjects.length,
                            item: tr.item,
                            trackingNumber: tr.tracking_number,
                            error: lineErr.message || lineErr.toString(),
                            stack: lineErr.stack
                        });
                        // Continue processing other lines
                    }
                }

                log.error("Sublist Processing Completed", {
                    totalLines: trackingObjects.length,
                    addedLines: addedLinesCount,
                    skippedLines: skippedLinesCount,
                    processedLines: addedLinesCount + skippedLinesCount
                });
            } catch (e) {
                log.error("Error Setting Header Fields or Processing Sublist", e);
                throw e; // Re-throw to be caught by outer catch
            }

            log.error("Before DropShip Header Save", {
                location: location,
                shipMethod: shipMethod,
                trailerId: trailerId,
                arrivalDate: arrivalDate,
                shipmentConfirmId: shipmentConfirmId,
                dataItemsCount: trackingObjects.length,
                isExistingRecord: !!existingRecordId,
                existingRecordId: existingRecordId
            });

            var savedId;
            try {
                savedId = headerRec.save();
                log.error("Saved DropShip Header", {
                    savedId: savedId,
                    isExistingRecord: !!existingRecordId,
                    action: existingRecordId ? "Updated Existing Record" : "Created New Record"
                });
            } catch (saveErr) {
                log.error("Error Saving DropShip Header Record", {
                    error: saveErr,
                    existingRecordId: existingRecordId,
                    isExistingRecord: !!existingRecordId
                });
                throw saveErr; // Re-throw to be caught by outer catch
            }

            return {
                status: "success",
                message: existingRecordId ? "Drop Ship Record Updated Successfully" : "Drop Ship Record Created Successfully",
                internalId: savedId,
                isExistingRecord: !!existingRecordId
            };

        } catch (e) {

            log.error("dropShipmentData ERROR", {
                name: e.name,
                message: e.message,
                stack: e.stack,
                toString: e.toString && e.toString()
            });

            return {
                status: "error",
                message: e.message || "Unexpected error in dropShipmentData"
            };
        }
    }




    function generateToken() {
        try {
            var webhookUrl = 'https://api.jyswms.com/user/login'; // prod Url
            var token = "";

            // Convert object to x-www-form-urlencoded string
            var formData = {
                userid: "jyswms_integration_user",
                password: "s9u[7zC720%pZr"
            };

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

                var responseBody = response.body;
                var parsedBody = JSON.parse(responseBody); // Convert JSON string to object

                token = parsedBody.access_token;


            } catch (e) {
                log.error('Error while sending request', e.message);
            }

            return token;

        } catch (e) {
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

        } catch (e) {
            log.error('Error sendData', e);
            return {
                success: false,
                error: e.message
            };
        }
    }

    function lookForExistingRecords(context) {
        try {
            if (!context || !context.portalId) {
                return false;
            }

            var portalId = context.portalId;

            // Check if portalId is in range DSP-467 to DSP-1000
            // if (portalId.indexOf('DSP-') === 0) {
            //     var numPart = portalId.substring(4); // after 'DSP-'
            //     var portalNumber = parseInt(numPart, 10);

            //     if (!isNaN(portalNumber) && portalNumber >= 8440 && portalNumber <= 8442) {
            //         log.debug('PortalId skipped by range rule', portalId);
            //         return false;
            //     }
            // }

            var mySearch = search.create({
                type: 'customrecord_wms_ai_api_custom_rec',
                filters: [
                    ['custrecordwms_ai_api_custrec_portalid', 'is', portalId]
                ],
                columns: [
                    search.createColumn({ name: 'internalid' }),
                    search.createColumn({ name: 'custrecord_wms_ai_api_custrec_response' })
                ]
            });

            var results = mySearch.run().getRange({
                start: 0,
                end: 1
            });

            if (!results || results.length === 0) {
                return false;
            }

            var responseValue = results[0].getValue({
                name: 'custrecord_wms_ai_api_custrec_response'
            });

            return responseValue ? responseValue : 'Record already exists';

        } catch (e) {
            log.error('Error in lookForExistingRecords', e.message);
            return false;
        }
    }

    function markAsPicked(requestBody, jyswmsApiCustRecId) {
        var headerId = null;
        try {

            const startTime = new Date().getTime();

            log.error('Incoming Data - MarkAsPicked', JSON.stringify(requestBody));
            var savedTransfers = [];
            var savedHeaders = [];
            // STEP 1: Build existing SO map
            var existingMap = {};
            var binMap = getBinNameToIdMap();

            var headerSearch = search.create({
                type: 'customrecord_order_fulfillment_details',
                filters: [
                    ["custrecord_jyswms_rel_item_ful", "anyof", "@NONE@"],
                    'AND',
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

                    try {
                        if (salesOrderId && jyswmsApiCustRecId) {
                            record.submitFields({
                                type: 'customrecord_wms_ai_api_custom_rec',
                                id: jyswmsApiCustRecId,
                                values: {
                                    custrecord_jyswms_related_tran_record: salesOrderId
                                },
                                options: {
                                    enableSourcing: false,
                                    ignoreMandatoryFields: true
                                }
                            });
                        }

                    } catch (error) {
                        log.error("error setting the so", error.message)
                    }



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
                                return l.tracking_number || "";
                            })
                            .filter(Boolean);

                    }

                    // --- CASE 1: labelData2 exists → pair by index ---
                    if (ssccList.length && trackingList.length && !so.packing_slip) {

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




                    log.error("trackingNumbers", trackingNumbers);


                    log.audit('Processing SO', {
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
                    log.error("headerId", headerId);
                    var headerRec;

                  
                   var isSingleIf = false;

                    if (headerId) {

                        var lookup = search.lookupFields({
                            type: 'customrecord_order_fulfillment_details',
                            id: headerId,
                            columns: ['custrecord_jywms_single_if_from_customer']
                        });

                        isSingleIf =
                            lookup.custrecord_jywms_single_if_from_customer &&
                            lookup.custrecord_jywms_single_if_from_customer.length > 0 &&
                            lookup.custrecord_jywms_single_if_from_customer[0].value === 'T';
                    }

                    if (headerId && isSingleIf) {

                        // Reuse existing header ONLY when checkbox is checked
                        headerRec = record.load({
                            type: 'customrecord_order_fulfillment_details',
                            id: headerId,
                            isDynamic: true
                        });

                    } else {
                        //  Create new header when:
                        // - no headerId
                        // - OR checkbox is unchecked
                        headerRec = record.create({
                            type: 'customrecord_order_fulfillment_details',
                            isDynamic: true
                        });

                        headerRec.setValue('custrecord_jyswms_sales_order_id', salesOrderId);
                        headerRec.setValue('custrecord_jyswms_portal_id', portalId);
                        headerRec.setValue('custrecord_jyswms_location_id', locationId);

                        headerId = headerRec.save();

                        log.error("Created new header record", headerId);
                    }


                    // STEP 4: Create Bin Transfer
                    if (savedId) {
                        log.error("savedId -- bintrnasferid", savedId);
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

                            // Save bin transfer with error handling
                            // var savedId = null;

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

                    try {

                        var singleIf = headerRec.getValue('custrecord_jywms_single_if_from_customer');
                        if (!singleIf) {
                            headerRec.setValue('custrecord_jyswms_is_partially_fulfilled', true);
                            headerRec.setValue('custrecord_jyswms_approved', true);
                            headerRec.setValue('custrecord_jyswmws_perform_update', true);
                
                        }
                        headerRec.setValue('custrecord_jyswms_location_id', locationId);

                    } catch (error) {
                        log.error("error message", error.message);
                    }


                    // STEP 6: Adding JYSWMS sales order Items (custom recrd lines)
                    var line = headerRec.selectNewLine({ sublistId: 'recmachcustrecord_sales_order_header' });
                    line.setCurrentSublistValue({ sublistId: 'recmachcustrecord_sales_order_header', fieldId: 'custrecord_jyswms_item', value: itemId });
                    line.setCurrentSublistValue({ sublistId: 'recmachcustrecord_sales_order_header', fieldId: 'custrecord_jyswms_item_order_qty', value: so.quantity });
                    line.setCurrentSublistValue({ sublistId: 'recmachcustrecord_sales_order_header', fieldId: 'custrecord_jyswms_item_picked_qty', value: pickQty });
                    line.setCurrentSublistValue({ sublistId: 'recmachcustrecord_sales_order_header', fieldId: 'custrecord_jyswms_sales_order', value: salesOrderId });
                    line.setCurrentSublistValue({ sublistId: 'recmachcustrecord_sales_order_header', fieldId: 'custrecord_jyswms_item_picked_bin', value: binId });
                    line.setCurrentSublistValue({ sublistId: 'recmachcustrecord_sales_order_header', fieldId: 'custrecord_jswms_item_so_item_qty', value: so.item_quantity });
                    line.setCurrentSublistValue({ sublistId: 'recmachcustrecord_sales_order_header', fieldId: 'custrecord_jyswms_item_so_line_loc', value: locationId });
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
                            log.debug("No adjustment needed — fully picked");
                            // Continue processing without adjustment
                        } else {
                            // Create inventory adjustment if there's a shortfall
                            // var negativeQty = -qtyDiff;

                            // new logic for fetching item quantity per bin details

                            var negativeQty = '';
                            const inventorybalanceSearchObj = search.create({
                                type: "inventorybalance",
                                filters:
                                    [
                                        ["item", "anyof", itemId],
                                        "AND",
                                        ["location", "anyof", locationId],
                                        "AND",
                                        ["available", "greaterthan", "0"],
                                        "AND",
                                        ["binnumber.custrecord_jyswms_exclude_from_inventory", "is", "F"],
                                        "AND",
                                        ["binnumber", "anyof", binId],
                                        "AND",
                                        ["binnumber.inactive", "is", "F"]
                                    ],
                                columns:
                                    [
                                        search.createColumn({
                                            name: "onhand",
                                            summary: "SUM",
                                            label: "On Hand"
                                        })
                                    ]
                            });
                            inventorybalanceSearchObj.run().each(function (result) {
                                var onHandQty = result.getValue({ name: "onhand", summary: "SUM" });
                                negativeQty = -onHandQty;
                                return true;
                            });


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


                            // Save record
                            invAdjId = inventoryAdjRec.save({
                                enableSourcing: true,
                                ignoreMandatoryFields: true
                            });

                            log.error(" Inventory Adjustment Created Successfully - MarkAsPicked : ", invAdjId);
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

                    // STEP 7: Add tracking sublist lines lines
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


                        log.error("track", track);
                        var trackLine = headerRec.selectNewLine({ sublistId: 'recmachcustrecord_jyswms_so_header' });
                        trackLine.setCurrentSublistValue({ sublistId: 'recmachcustrecord_jyswms_so_header', fieldId: 'custrecord_jyswms_track_item', value: itemId });
                        trackLine.setCurrentSublistValue({ sublistId: 'recmachcustrecord_jyswms_so_header', fieldId: 'custrecord_jyswms_track_number', value: track.ssccCode });
                        trackLine.setCurrentSublistValue({ sublistId: 'recmachcustrecord_jyswms_so_header', fieldId: 'custrecord_jyswms_track_so_id', value: salesOrderId });
                        trackLine.setCurrentSublistValue({ sublistId: 'recmachcustrecord_jyswms_so_header', fieldId: 'custrecord_jyswms_track_qty', value: 1 });
                        trackLine.setCurrentSublistValue({ sublistId: 'recmachcustrecord_jyswms_so_header', fieldId: 'custrecord_jyswms_track_uniqueid', value: uniqueId });
                        log.error("track.tracking number", track.trackingNumber)
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
                    var totalPickedQty = pickQty;
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
                    var singleIf =  headerRec.getValue({ fieldId: 'custrecord_jywms_single_if_from_customer' });
                  
                  if(singleIf) {
                    headerRec.setValue({
                        fieldId: 'custrecord_jyswms_approved',
                        value: isApproved ? true : false
                    });
                  }

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
            const endTime = new Date().getTime();

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

    function getAllSalesOrders(request) {
        try {
            var scriptObj = runtime.getCurrentScript();
            var savedSearchId = scriptObj.getParameter({
                name: 'custscript_wms_ai_salesorder_header'
            });

            //  var savedSearchId = 'custscript_get_allsalesorders';

            // Load saved search
            var soSearch = search.load({ id: 4752 });

            // Pagination setup
            var pageSize = 1000;
            var pageNumber = request.page ? parseInt(request.page, 10) : 1;

            var pagedData = soSearch.runPaged({ pageSize: pageSize });
            var totalPages = pagedData.pageRanges.length;
            var totalRecords = pagedData.count;

            if (totalPages === 0) {
                return {
                    status: 200,
                    message: 'No records found',
                    summary: {
                        total_records: 0,
                        total_pages: 0,
                        records_per_page: pageSize,
                        current_page: 0,
                        pagination_info: {
                            start_index: 0,
                            end_index: 0,
                            has_next_page: false,
                            has_previous_page: false
                        }
                    },
                    data: []
                };
            }

            if (pageNumber < 1 || pageNumber > totalPages) {
                return {
                    status: 400,
                    message: 'Invalid page number. Must be between 1 and ' + totalPages
                };
            }

            var page = pagedData.fetch({ index: pageNumber - 1 });
            var results = [];


            page.data.forEach(function (result) {
                results.push({
                    internal_id: result.getValue({ name: 'internalid' }),
                    status: result.getText({ name: 'statusref' }),
                    priority: result.getValue({ name: 'custbody_opt_ship_priority' }),
                    location: result.getText({ name: 'location' }),
                    vridNumber: result.getText({ name: 'custbody_jyswms_vrid_number' })
                });
            });

            // Pagination info
            var startIndex = (pageNumber - 1) * pageSize;
            var endIndex = startIndex + results.length - 1;

            return {
                status: 200,
                message: 'Data retrieved successfully',
                summary: {
                    total_records: totalRecords,
                    total_pages: totalPages,
                    records_per_page: pageSize,
                    current_page: pageNumber,
                    pagination_info: {
                        start_index: startIndex,
                        end_index: endIndex,
                        has_next_page: pageNumber < totalPages,
                        has_previous_page: pageNumber > 1
                    }
                },
                data: results
            };

        } catch (e) {
            return {
                status: 500,
                message: 'Error retrieving data',
                error: e.message
            };
        }
    }


    function FullFillOrders(context, id) {
        log.error("fullfillorders");
        return true;
    }

    //Sample functions not used
    function getTrackingNumbers(context, pageSize, startIndex) {
        try {
            var ScriptStartTime = new Date().getTime();
            log.debug('Script Started', 'Start Time: ' + ScriptStartTime / 1000 + ' seconds');

            var scriptObj = runtime.getCurrentScript();
            var TrackingNumberSearchId = scriptObj.getParameter({
                name: 'custscript_wms_ai_tracking_number_search'
            });
            log.debug('Tracking Number Parameter', TrackingNumberSearchId);
            var Data = {};

            var TrackingNumberSearch = search.load({
                id: TrackingNumberSearchId
            });

            // Get total count using runPaged().count
            var totalCount = TrackingNumberSearch.runPaged().count;
            var totalPages = Math.ceil(totalCount / pageSize);

            // Apply pagination
            var searchResult = TrackingNumberSearch.run();
            var searchRange = searchResult.getRange({
                start: startIndex,
                end: startIndex + pageSize
            });

            searchRange.forEach(function (result) {
                var internalId = result.getValue({
                    name: 'internalid'
                });
                var salesOrderId = result.getValue({
                    name: 'custrecord_tracking_number'
                });

                var recordData = {};

                result.columns.forEach(function (column) {
                    var columnName = toSnakeCase(column.label || column.name);
                    recordData[columnName] = result.getText(column) || result.getValue(column);
                });
                Data[salesOrderId] = recordData;
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

    function getUsers(context, pageSize, startIndex) {
        try {
            var ScriptStartTime = new Date().getTime();
            log.debug('Script Started', 'Start Time: ' + ScriptStartTime / 1000 + ' seconds');

            var scriptObj = runtime.getCurrentScript();
            var UserSearchId = scriptObj.getParameter({
                name: 'custscript_wms_ai_user_data_search'
            });
            log.debug('User Parameter', UserSearchId);
            var Data = {};

            var UserSearch = search.load({
                id: UserSearchId
            });

            // Get total count using runPaged().count
            var totalCount = UserSearch.runPaged().count;
            var totalPages = Math.ceil(totalCount / pageSize);

            // Apply pagination
            var searchResult = UserSearch.run();
            var searchRange = searchResult.getRange({
                start: startIndex,
                end: startIndex + pageSize
            });

            var locationSearch = search.create({
                type: search.Type.LOCATION,
                filters: [
                    ['isinactive', 'is', 'F']
                ],
                columns: ['internalid', 'name']
            });

            var locationResults = locationSearch.run().getRange({
                start: 0,
                end: 1000
            });
            var allLocations = locationResults.map(function (loc) {
                return {
                    location_id: loc.getValue({
                        name: 'internalid'
                    }),
                    location_name: loc.getValue({
                        name: 'name'
                    })
                };
            });

            searchRange.forEach(function (result) {
                var internalId = result.getValue({
                    name: 'internalid'
                });
                var recordData = {};

                result.columns.forEach(function (column) {
                    var columnName = toSnakeCase(column.label || column.name);
                    recordData[columnName] = result.getText(column) || result.getValue(column);
                });
                Data[internalId] = recordData;
                recordData['locations'] = allLocations;
            });

            var ScriptEndTime = new Date().getTime();
            //log.debug('Total Execution Time', ((ScriptEndTime - ScriptStartTime) / 1000) + ' seconds');

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

    function toSnakeCase(str) {
        return str
            .trim()
            .replace(/[^a-zA-Z0-9 ]/g, '')
            .replace(/\s+/g, '_')
            .toLowerCase();
    }

    return {
        get: get,
        post: post
    };
});