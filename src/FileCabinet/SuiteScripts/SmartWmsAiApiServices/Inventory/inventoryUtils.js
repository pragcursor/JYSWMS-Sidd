/**
 * @NApiVersion 2.x
 * @NModuleScope Public
 */
define(['N/record', 'N/search', 'N/log', 'N/runtime', 'N/https'], function (record, search, log, runtime, https) {

    function getCounts(context, pageSize) {

        return {
            success: true
        }
    }

    function recentUpdatedItems() {
        try {
            var itemIds = [];
            //  Search for items in transactions modified in the last 30 minutes
            var transactionSearchObj = search.create({
                type: "transaction",
                filters: [
                    ["formulatext: CASE WHEN {lastmodifieddate} >= (CURRENT_TIMESTAMP - (30/1440)) THEN 1 ELSE 0 END", "is", "1"],
                    "AND",
                    ["posting", "is", "T"],
                    "AND",
                    ["lastmodifieddate", "after", "yesterday"],
                    "AND",
                    ["mainline", "is", "F"]
                ],
                columns: [
                    search.createColumn({
                        name: "item",
                        summary: "GROUP",
                        label: "Item"
                    })
                ]
            });

            transactionSearchObj.run().each(function (result) {
                var itemId = result.getValue({
                    name: "item",
                    summary: "GROUP"
                });
                if (itemId && !itemIds.includes(itemId.toString())) {
                    itemIds.push(itemId.toString());
                    log.debug("Last Modified Item (30 mins)", "Item ID: " + itemId);
                }
                return true; // keep iterating
            });

            log.debug("All Last Modified Item IDs (30 mins)", JSON.stringify(itemIds));
            log.audit("Total Unique Item IDs Count", itemIds.length);

            if (itemIds.length > 0) {
                return itemIds;
            }
        } catch (error) {
            log.error("error  recentUpdatedItems meassage", e.message);
        }
    }

    function getAllItems() {

        var itemIds = [];

        try {

            var itemSearch = search.create({
                type: search.Type.ITEM,
                filters: [
                    ["isinactive", "is", "F"]
                ],
                columns: [
                    search.createColumn({
                        name: "internalid",
                        sort: search.Sort.DESC
                    })
                ]
            });

            var pagedData = itemSearch.runPaged({
                pageSize: 500
            });

            pagedData.pageRanges.forEach(function (pageRange) {

                var page = pagedData.fetch({ index: pageRange.index });

                page.data.forEach(function (result) {

                    var id = result.getValue({
                        name: "internalid"
                    });

                    if (id) {
                        itemIds.push(id);
                    }

                });

            });

            log.audit("Total Items Found", itemIds.length);

        } catch (e) {

            log.error("getAllItems Error", e);

        }

        return itemIds;
    }


    function chunkArray(arr, size) {

        var result = [];

        for (var i = 0; i < arr.length; i += size) {
            result.push(arr.slice(i, i + size));
        }

        return result;
    }


    function processAllItems(context, pageSize, startIndex) {

        try {

            var pageSize = 1000;
            var startIndex = 0;

            var allItems = getAllItems();

            var batches = chunkArray(allItems, 500);

          //  log.audit("Total Batches", batches.length);
            var totalCount = 1
            var allResults = [];
            var response = {
                status: 200,
                message: 'Data retrieved successfully',
                summary: {
                    total_records: totalCount,
                    total_pages: 1,
                    records_per_page: pageSize,
                    current_page: Math.floor(startIndex / pageSize) + 1,
                    pagination_info: {
                        start_index: startIndex,
                        end_index: startIndex + pageSize - 1,
                        has_next_page: (startIndex + pageSize) < totalCount,
                        has_previous_page: startIndex > 0
                    }
                },
                data: {}
            };


            batches.forEach(function (batch, index) {


                // log.audit("Processing b", {
                //     "index": index,
                //     "batch": batch
                // });

                var context = {
                    itemIds: batch
                };

                var inventoryData = getInventoryTemp(context);

              //  log.audit("Processing Batch Data", inventoryData);
                //var inventoryData = inventoryData.data;
                var apiStatus = sendData(inventoryData);

                if (inventoryData && inventoryData.data) {
                    response.data = Object.assign(response.data, inventoryData.data);
                }

                //  log.audit("Batch Inventory Data Summary", JSON.stringify(inventoryData));

            });
            log.audit("Final Inventory Data Summary", JSON.stringify(response));
            return true;


        } catch (e) {

            log.error("processAllItems Error", e);

        }

    }


    function getInventory(context, pageSize, startIndex) {
        try {
            var ScriptStartTime = new Date().getTime();
            //   log.error('Script Started', 'Start Time: ' + ScriptStartTime / 1000 + ' seconds');

            var scriptObj = runtime.getCurrentScript();
            var inventorySearchId = scriptObj.getParameter({ name: 'custscript_wms_ai_inventory_detail' });
            //  log.error('inventory Parameter', inventorySearchId);
            var Data = {};
            var binId = context.binId || "";
            var existingBinSequenceMap = BinSequenceSearch();
            // log.error("existingBinSequenceMap",JSON.stringify(existingBinSequenceMap));


            var itemIds = context.itemIds || "";

            //   ---don't remove this section in commnets---
            //    log.audit("itemIds from request", itemIds);
            //    if (!itemIds) {
            //     itemIds = recentUpdatedItems() || "";
            //     log.audit("itemIds", itemIds.length);
            //      }
            //   log.audit("final itemIds", itemIds);

            var inventorySearch = search.load({
                id: inventorySearchId,
                type: search.Type.ITEM
            });
            var filters = inventorySearch.filters || [];
            // log.error("filters",JSON.stringify(filters));
            if (itemIds) {
                try {
                    filters.push(search.createFilter({
                        name: 'internalid',
                        operator: search.Operator.ANYOF,
                        values: itemIds
                    }));
                    //   log.audit("item ids", itemIds);
                } catch (e) {
                    log.error("error pushing item filters", e);
                    var response = e.message + " - " + itemIds;
                    //   log.error("response",JSON.stringify(response));
                }
            }
            if (binId) {

                try {

                    filters.push(search.createFilter({

                        name: 'binnumber',
                        join: "binOnHand",
                        operator: search.Operator.ANYOF,
                        values: binId

                    }));


                } catch (e) {

                    log.error("error pushing item filters", e);

                    var response = e.message + " - " + binId;


                }

            }


            // Apply updated filters back to the search
            inventorySearch.filters = filters;

            var totalCount = inventorySearch.runPaged().count;
            var totalPages = Math.ceil(totalCount / pageSize);

            //log.error("total Count", totalCount);

            var searchResult = inventorySearch.run();
            var searchRange = searchResult.getRange({ start: startIndex, end: startIndex + pageSize });

            searchRange.forEach(function (result) {
                // log.error("item search result", JSON.stringify(result));

                var internalId = result.getValue({ name: "internalid" });
                var locationId = result.getValue({ name: "location", join: "binOnHand" });
                var availableQty = parseFloat(result.getValue({ name: "quantityavailable", join: "binOnHand" })) || 0;

                if (!internalId || !locationId) return;

                if (!Data[internalId]) {
                    Data[internalId] = {};
                }

                if (!Data[internalId][locationId]) {
                    Data[internalId][locationId] = {
                        total_available: 0,
                        itemDetails: []
                    };
                }

                var itemData = {};
                result.columns.forEach(function (column) {
                    var columnName = toSnakeCase(column.label || column.name);
                    if (columnName == 'location') {
                        itemData['loc_internalid'] = result.getValue(column) || " ";
                        itemData['location'] = result.getText(column) || " ";
                    }
                    else if (columnName == 'bin_number') {
                        var binId = result.getValue(column);
                        itemData['bin_internalid'] = result.getValue(column) || " ";
                        itemData['bin_number'] = result.getText(column) || " ";
                        var binData = existingBinSequenceMap[binId];
                        itemData['bin_index'] = binData ? binData.bin_index : " ";
                        itemData['bin_orientation'] = binData.bin_orientation || "";
                        itemData['wh'] = binData.wh || "";
                        itemData['room'] = binData.room || "";
                        itemData['aisle_no'] = binData.aisle_no || "";
                        itemData['bin'] = binData.bin || "";
                    }
                    else {
                        itemData[columnName] = result.getText(column) || result.getValue(column);
                    }
                });

                Data[internalId][locationId].itemDetails.push(itemData);
                Data[internalId][locationId].total_available += availableQty;
            });


            var returnData = {
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
            return returnData;

        } catch (e) {
            log.error("error message", e);

            return {
                status: 500,
                message: e.message
            };
        }
    }


    function getInventoryTemp(context) {
        try {

            var scriptObj = runtime.getCurrentScript();
            var inventorySearchId = scriptObj.getParameter({ name: 'custscript_wms_ai_inventory_detail' });

            var Data = {};
            var binId = context.binId || "";
            var itemIds = context.itemIds || "";

            var existingBinSequenceMap = BinSequenceSearch();

            var inventorySearch = search.load({
                id: inventorySearchId,
                type: search.Type.ITEM
            });

            var filters = inventorySearch.filters || [];

            if (itemIds) {
                filters.push(search.createFilter({
                    name: 'internalid',
                    operator: search.Operator.ANYOF,
                    values: itemIds
                }));
            }

            if (binId) {
                filters.push(search.createFilter({
                    name: 'binnumber',
                    join: "binOnHand",
                    operator: search.Operator.ANYOF,
                    values: binId
                }));
            }

            inventorySearch.filters = filters;

            var pagedData = inventorySearch.runPaged({
                pageSize: 1000
            });

            var totalCount = pagedData.count;

            pagedData.pageRanges.forEach(function (pageRange) {

                var page = pagedData.fetch({ index: pageRange.index });

                page.data.forEach(function (result) {

                    var internalId = result.getValue({ name: "internalid" });
                    var locationId = result.getValue({ name: "location", join: "binOnHand" });
                    var availableQty = parseFloat(result.getValue({ name: "quantityavailable", join: "binOnHand" })) || 0;

                    if (!internalId || !locationId) return;

                    if (!Data[internalId]) {
                        Data[internalId] = {};
                    }

                    if (!Data[internalId][locationId]) {
                        Data[internalId][locationId] = {
                            total_available: 0,
                            itemDetails: []
                        };
                    }

                    var itemData = {};

                    result.columns.forEach(function (column) {

                        var columnName = toSnakeCase(column.label || column.name);

                        if (columnName == 'location') {

                            itemData['loc_internalid'] = result.getValue(column) || " ";
                            itemData['location'] = result.getText(column) || " ";

                        } else if (columnName == 'bin_number') {

                            var binInternalId = result.getValue(column);

                            itemData['bin_internalid'] = binInternalId || " ";
                            itemData['bin_number'] = result.getText(column) || " ";

                            var binData = existingBinSequenceMap[binInternalId] || {};

                            itemData['bin_index'] = binData.bin_index || " ";
                            itemData['bin_orientation'] = binData.bin_orientation || "";
                            itemData['wh'] = binData.wh || "";
                            itemData['room'] = binData.room || "";
                            itemData['aisle_no'] = binData.aisle_no || "";
                            itemData['bin'] = binData.bin || "";

                        } else {

                            itemData[columnName] = result.getText(column) || result.getValue(column);

                        }
                    });

                    Data[internalId][locationId].itemDetails.push(itemData);
                    Data[internalId][locationId].total_available += availableQty;

                });

            });

            return {
                status: 200,
                message: 'Data retrieved successfully',
                summary: {
                    total_records: totalCount
                },
                data: Data
            };

        } catch (e) {

            log.error("error message", e);

            return {
                status: 500,
                message: e.message
            };
        }
    }





    function BinSequenceSearch() {

        try {

            var existingBinSequenceMap = {};

            var BinSearch = search.create({
                type: 'bin',
                filters: [
                ],
                columns: [
                    search.createColumn({ name: "custrecord_jyswms_sequence_number", label: "sequence number" }),
                    search.createColumn({ name: "internalid", label: "internal id" }),
                    search.createColumn({ name: "custrecord_bin_position", label: "Bin Orentation" }),
                    search.createColumn({ name: "custrecord_bin_wh", label: "WH" }),
                    search.createColumn({ name: "custrecord_bin_room", label: "Room" }),
                    search.createColumn({ name: "custrecord_aisle_no", label: "Aisle No" }),
                    search.createColumn({ name: "custrecord_bin_bin", label: "Bin" })
                ]
            });

            var pagedData = BinSearch.runPaged({ pageSize: 1000 });

            pagedData.pageRanges.forEach(function (pageRange) {
                var page = pagedData.fetch({ index: pageRange.index });
                page.data.forEach(function (result) {
                    var binId = result.getValue({ name: 'internalid' });
                    var sequenceNumber = parseFloat(result.getValue({
                        name: "custrecord_jyswms_sequence_number"
                    })) || " ";
                    // even if sequence number is missing, we want to include the bin in the map with empty sequence to avoid missing bin details in inventory response
                    existingBinSequenceMap[binId] = {
                        "bin_index": sequenceNumber,
                        "bin_orientation": result.getValue({ name: "custrecord_bin_position" }),
                        "wh": result.getValue({ name: "custrecord_bin_wh" }),
                        "room": result.getValue({ name: "custrecord_bin_room" }),
                        "aisle_no": result.getValue({ name: "custrecord_aisle_no" }),
                        "bin": result.getValue({ name: "custrecord_bin_bin" })
                    };
                });
            });
            return existingBinSequenceMap;

        } catch (e) {
            log.error("Error in BinSearch", e.toString());
            return {};
        }
    }


    // below is the code for fetching missing inventory details in DB

    function getItemInventorydata(context) {
        try {

            var itemIds = [];
            var data = context.data || [];

            // log.error({
            //     title: "Request Data - getinv",
            //     details: JSON.stringify(data)
            // });

            if (data && data.length && data.length > 0) {

                for (var i = 0; i < data.length; i++) {

                    if (data[i] && data[i].item_internalid) {

                        var itemId = data[i].item_internalid;

                        if (itemIds.indexOf(itemId) === -1) {
                            itemIds.push(itemId);
                        }
                    }
                }
            }

            if (itemIds.length > 0) {
                processInventory(itemIds);
            }

        } catch (e) {
            log.error({
                title: "Error in getItemInventorydata",
                details: e
            });
        }
    }


    function processInventory(itemIds) {

        var params = {
            itemIds: itemIds
        };

        var inventoryData = getInventory(params, 1000, 0);

        // log.error({
        //     title: "Inventory Data - checking",
        //     details: JSON.stringify(inventoryData)
        // });

        var apiStatus = sendData(inventoryData);

        // log.debug({
        //     title: "API Response",
        //     details: JSON.stringify(apiStatus)
        // });
    }


    function sendData(body) {

        var token = generateToken();

        if (!token) {
            return {
                success: false,
                error: "Token generation failed"
            };
        }

        try {

            var response = https.post({
                url: 'https://api.jyswms.com/netsuite/update-inventory',
                body: JSON.stringify(body),
                headers: {
                    'Authorization': 'Bearer ' + token,
                    'Content-Type': 'application/json'
                }
            });

            var raw = response.body ? response.body : "";
            var success = (response.code === 200);

            return {
                success: success,
                response: raw
            };

        } catch (e) {

            log.error({
                title: "sendData Error",
                details: e
            });

            return {
                success: false,
                error: e.message ? e.message : e
            };
        }
    }

    function generateToken() {
        const url = 'https://api.jyswms.com/user/login';
        const creds = {
            userid: 'jyswms_integration_user',
            password: 's9u[7zC720%pZr'
        };

        try {
            const response = https.post({
                url: url,
                body: JSON.stringify(creds),
                headers: { 'Content-Type': 'application/json' }
            });

            const parsed = JSON.parse(response.body || '{}');

            if (parsed.access_token) {
                return parsed.access_token;
            }

            log.error('Token Generation Failed', parsed);
            return null;

        } catch (e) {
            log.error('generateToken Error', e);
            // return null;
        }
    }

    function toSnakeCase(str) {
        return str
            .trim()
            .replace(/[^a-zA-Z0-9 ]/g, '')
            .replace(/\s+/g, '_')
            .toLowerCase();
    }


    function process_No_Inv_items(context) {
        try {
            var record = require('N/record');
            var search = require('N/search');
            var task = require('N/task');
            var log = require('N/log');

            var data = context.data || [];
            var uniqueMap = {};
            var uniqueItems = [];

            if (!data || !data.length) {
                log.error("No data received", context);
                return;
            }

            // 🔹 Deduplicate
            for (var i = 0; i < data.length; i++) {
                var itemId = data[i] && data[i].item_internalid;
                if (itemId && !uniqueMap[itemId]) {
                    uniqueMap[itemId] = true;
                    uniqueItems.push(itemId);
                }
            }

          //  log.audit("Total unique items", uniqueItems.length);

            // =====================================================
            // 🚀 SMALL PAYLOAD → DIRECT PROCESSING
            // =====================================================
            if (uniqueItems.length <= 200) {

                for (var j = 0; j < uniqueItems.length; j++) {
                    var itemId = uniqueItems[j];

                    try {
                        var itemRec;

                        // 🔹 FAST PATH (assume inventory item)
                        try {
                            itemRec = record.load({
                                type: record.Type.INVENTORY_ITEM,
                                id: itemId,
                                isDynamic: false
                            });
                        } catch (loadErr) {
                            // 🔁 FALLBACK: detect type
                            var lookup = search.lookupFields({
                                type: search.Type.ITEM,
                                id: itemId,
                                columns: ['recordtype']
                            });

                            var itemType = lookup.recordtype;
                            if (!itemType) {
                                log.error("Item type not found", itemId);
                                continue;
                            }

                            itemRec = record.load({
                                type: itemType,
                                id: itemId,
                                isDynamic: false
                            });
                        }

                        // 🔹 Save
                        itemRec.save({
                            enableSourcing: false,
                            ignoreMandatoryFields: true
                        });

                    } catch (innerErr) {
                        log.error("Error processing itemId: " + itemId, innerErr);
                    }
                }

                log.audit("Processed in Restlet", uniqueItems.length);
            }

            // =====================================================
            // 🔥 LARGE PAYLOAD → MAP/REDUCE
            // =====================================================
            else {
                var mrTask = task.create({
                    taskType: task.TaskType.MAP_REDUCE,
                    scriptId: 'customscript_item_process_mr',
                    params: {
                        custscript_item_payload: JSON.stringify(uniqueItems)
                    }
                });

                var taskId = mrTask.submit();

                log.audit("MR Triggered", {
                    taskId: taskId,
                    totalItems: uniqueItems.length
                });
            }

        } catch (e) {
            log.error("Fatal error in processItemsHybrid", e);
        }
    }



    return {
        getCounts: getCounts,
        getInventory: getInventory,
        getItemInventorydata: getItemInventorydata,
        processAllItems: processAllItems,
        process_No_Inv_items: process_No_Inv_items
    };
});
