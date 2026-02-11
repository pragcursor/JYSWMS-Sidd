/**
 * @NApiVersion 2.x
 * @NModuleScope Public
 */
define(['N/record', 'N/file', 'N/search', 'N/log', 'N/runtime'], function (record, file, search, log, runtime) {

    //  return {
    //     getOrders: getOrders,
    //     getDropShipOrders: getDropShipOrders,
    //     dropShipmentData:dropShipmentData,
    //     fullFillOrders: fullFillOrders,
    //     getFullFillOrders: getFullFillOrders,
    //     getInboundRecords: getInboundRecords,
    //     transformInboundShipmentToItemReceipt:transformInboundShipmentToItemReceipt,
    //     getLTLOrders:getLTLOrders,
    //     getUnpicked : getUnpicked,
    //     processPalletUpdate : processPalletUpdate,
    //     createImageFile:createImageFile
    // };




    function getDropShipOrdersPerOrder(context, pageSize, startIndex) {
        try {

            var scriptObj = runtime.getCurrentScript();
            var SalesOrderHeaderId = scriptObj.getParameter({ name: 'custscript_wms_ai_salesorder_header' });
            var SalesOrderItemLevelDataId = scriptObj.getParameter({ name: 'custscript_wms_ai_salesorder_items' });

            var itemPrimaryUnitsMap = itemPrimaryUnits();

            var headerData = {};
            var filters = [];

            if (context.customer_id) {
                filters.push(['entity', 'anyof', context.customer_id]);
            }
            if (context.start_date && context.end_date) {
                filters.push('AND', ['trandate', 'within', context.start_date, context.end_date]);
            }


            var headerSearch = search.load({ id: 4797 });

            // non amazon dropship orders
            //    var headerSearch = search.load({ id: 4831 });

            if (filters.length > 0) {
                headerSearch.filters = (headerSearch.filters || []).concat(filters);
            }

            // var totalCount = headerSearch.runPaged().count;
            // var totalPages = Math.ceil(totalCount / pageSize);

            // var searchResult = headerSearch.run();
            // var searchRange = searchResult.getRange({ start: startIndex, end: startIndex + pageSize });
            var headerIds = context.salesOrderHeaderId;
            var itemsIds = context.itemIds;

            var response = [];
            var itemSearch = search.load({ id: 4798 });

            var itemfilters = itemSearch.filters || [];


            if (headerIds) {
                log.error("headerIds", headerIds)
                try {

                    itemfilters.push(search.createFilter({

                        name: 'internalid',

                        operator: search.Operator.ANYOF,

                        values: headerIds

                    }));


                } catch (e) {

                    log.error("error pushing item filters");

                    var response = e.message + " - " + itemIds;

                }

            }

            if (itemsIds) {
                log.error("itemsIds", itemsIds)

                try {

                    itemfilters.push(search.createFilter({

                        name: 'item',

                        operator: search.Operator.ANYOF,

                        values: itemsIds
                    }));


                } catch (e) {

                    log.error("error pushing item filters");

                    var response = e.message + " - " + itemIds;

                }

            }

            itemSearch.filters = itemfilters;

            if (filters.length > 0) {
                itemSearch.filters = (itemSearch.filters || []).concat(filters);
            }

            log.error("itemSearch - -filters", itemSearch.filters)

            var cartonsIds = {}; // carton counter per internalID
            // var itemSearchResult = itemSearch.run();
            // var itemSearchRange = itemSearchResult.getRange({ start: startIndex, end: startIndex + pageSize });

            // Helper: safe parse int
            function safeInt(v, fallback) {
                var n = parseInt(v);
                return (isNaN(n) ? (fallback === undefined ? "" : fallback) : n);
            }
            function safeFloat(v, fallback) {
                var n = parseFloat(v);
                return (isNaN(n) ? (fallback === undefined ? "" : fallback) : n);
            }


            var pagedData = itemSearch.runPaged({
                pageSize: 1000
            });

            var itemDetails = [];

            // Loop all pages
            pagedData.pageRanges.forEach(function (pageRange) {

                var page = pagedData.fetch({ index: pageRange.index });


                page.data.forEach(function (result) {


                    var internalID = result.id;
                    if (!internalID) return;

                    // init carton counter
                    if (!cartonsIds[internalID]) cartonsIds[internalID] = 1;

                    // ensure header row exists
                    // if (!headerData[internalID]) return;
                    // if (!headerData[internalID].itemDetails) headerData[internalID].itemDetails = [];
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
                            baseItemData["so_items"] = parsedSoItemsArr.length;;
                        } else if (columnName === "unique_id") {
                            unique_id_val = valueText || "";
                            // do not write to baseItemData.unique_id here — the final unique_id will be appended with binIndex later
                            baseItemData["unique_id"] = valueText || "";
                        }
                        else if (columnName == "ship_via") {
                            baseItemData["shipMethodText"] = (result.getText(column) || result.getValue(column));
                            baseItemData["shipMethodValue"] = (result.getValue(column) || result.getText(column));
                        }
                        else {
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

                    var itemslength = parsedSoItemsArr.length || 0;

                    var existBinArr = getBinTransferinfo(result, itemPrimaryUnitsMap); // always array
                    //log.error("existBinArr", existBinArr);

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


                    if (!headerData[internalID]) {
                        headerData[internalID] = {
                            _addedKeys: {}
                        };
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
                        var car = safeInt(convertedLineQuantity, 0);
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

                        // Default customer_url if empty
                        var DEFAULT_CUSTOMER_URL =
                            "https://4809897.app.netsuite.com/core/media/media.nl?id=1448&c=4809897&h=e82baf9136edcc808c8a";

                        if (!itemData.customer_url || itemData.customer_url === "") {
                            itemData.customer_url = DEFAULT_CUSTOMER_URL;
                        }

                        // Set unique_id to include bin index so it stays unique per bin if base had unique_id
                        // var uniqueIdToSet = (unique_id_val ? unique_id_val + "_" + (binObj.binIndex || (b + 1)) : (item_internalid + "_" + (binObj.binIndex || (b + 1))));
                        itemData["unique_id"] = unique_id_val;

                        // Bin-specific fields (guaranteed keys with empty fallback)
                        itemData["cartonInfo"] = cartonInfo;
                        itemData["quantity"] = safeInt(binObj.quantity, "") || convertedLineQuantity; // quantity to pick from this bin (number or "")
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
                        itemDetails.push(itemData);
                    } // end bin loop
                });

            });


            // end itemSearchRange.forEach
            // Remove internal _addedKeys before returning JSON



            return itemDetails;
            // return {
            //     status: 200,
            //     message: 'Data retrieved successfully',
            //     summary: {
            //         total_records: totalCount,
            //         total_pages: totalPages,
            //         records_per_page: pageSize,
            //         current_page: Math.floor(startIndex / pageSize) + 1,
            //         pagination_info: {
            //             start_index: startIndex,
            //             end_index: startIndex + pageSize - 1,
            //             has_next_page: (startIndex + pageSize) < totalCount,
            //             has_previous_page: startIndex > 0
            //         }
            //     },
            //     data: headerData
            // };


        } catch (e) {
            log.error("Error in getDropshipsOrders function", e);
            return {
                status: 500,
                message: e.message
            };
        }
    }




    function getLTLOrders(context) {

        var specialIdMap = getItemIdToCustomFieldMap();
        // log.error("specialIdMap", specialIdMap);
        var logoMap = {};
        try {
            var searchResults = search.create({
                type: "customrecord_ltl_dashboard_logos",
                filters: [
                    ["custrecord_transportation_provider", "isnotempty", ""],
                ],
                columns: [
                    "custrecord_ltl_image_url",
                    search.createColumn({
                        name: "custrecord_transportation_provider",
                        sort: search.Sort.DESC
                    })
                ],
            }).run();

            searchResults.each(function (result) {
                var provider = (result.getValue("custrecord_transportation_provider") || "").toUpperCase();
                var imageUrl = result.getValue("custrecord_ltl_image_url") || null;

                if (imageUrl && imageUrl.startsWith("/")) {
                    // Prepend your RESTlets domain
                    imageUrl = "https://4809897.restlets.api.netsuite.com" + imageUrl;
                }

                logoMap[provider] = imageUrl;
                // log.debug("Logo Loaded", provider + " -> " + imageUrl);
                return true;
            });
        } catch (error) {
            log.error("Error fetching logo mappings", error.message);
        }


        try {
            const palletSC = '';
            let salesorderSearch;

            if (!palletSC) {
                salesorderSearch = search.create({
                    type: search.Type.SALES_ORDER,
                    filters: [
                        ["type", "anyof", "SalesOrd"],
                        "AND",
                        ["mainline", "is", "T"],
                        "AND",
                        ["custbody_reason_approval", "doesnotcontain", "PARTS"],
                        "AND",
                        ["customer.custentity_jyswms_enable", "is", "T"],
                        "AND",
                        ["location", "anyof", "15", "9"],
                        "AND",
                        ["custbody_bol_tracking_number", "isempty", ""],
                        "AND",
                        ["shipmethod", "anyof", "57733"],
                        "AND",
                        ["status", "noneof", "SalesOrd:A", "SalesOrd:C", "SalesOrd:H"],
                        "AND",
                        ["shipdate", "onorafter", "1/1/2026"]
                    ],
                    columns: [
                        search.createColumn({ name: "internalid", summary: "GROUP" }),
                        search.createColumn({ name: "tranid", summary: "GROUP" }),
                        search.createColumn({ name: "otherrefnum", summary: "GROUP" }),
                        search.createColumn({ name: "custbody14", summary: "GROUP" }),
                        search.createColumn({ name: "custbody_wms_current_picked_qty", summary: "GROUP" }),
                        search.createColumn({ name: "custbody_picking_status", summary: "GROUP" }),
                        search.createColumn({ name: "entity", summary: "GROUP" }),
                        search.createColumn({ name: "trandate", summary: "GROUP" }),
                        search.createColumn({ name: "statusref", summary: "GROUP" }),
                        search.createColumn({ name: "custbody_amazon_arn", summary: "GROUP" }),
                        search.createColumn({ name: "custbody_picked_by_whom", summary: "GROUP" }),
                        search.createColumn({ name: "custbody_carrier_changed", summary: "GROUP" }),
                        search.createColumn({ name: "custbody_pickup_date_changed", summary: "GROUP" }),
                        search.createColumn({ name: "shipdate", summary: "GROUP" }),
                        search.createColumn({ name: "custbody_so_items", label: "SO Items", summary: "GROUP" }),
                        search.createColumn({ name: "custbody_bol_tracking_number", summary: "GROUP" }),
                        search.createColumn({ name: "custbody_scheduled_pickup_date", summary: "GROUP" }),

                        search.createColumn({
                            name: "formulatext",
                            formula: "CASE WHEN {custbody_driver_name} IS NULL THEN 'TBD' ELSE {custbody_driver_name} END",
                            summary: "GROUP",
                            label: "driverNameFormula"
                        }),

                        search.createColumn({
                            name: "formulatext",
                            formula: "CASE WHEN {custbody_asin} IS NOT NULL THEN 'SINGLE ASIN - ' || {custbody_asin}  ELSE  'MIXED SKU' END",
                            summary: "GROUP",
                            label: "asinTypeFormula"
                        }),
                        search.createColumn({
                            name: "formulatext",
                            formula: "CASE    WHEN {location} = 'L60-Hardeeville_SC' THEN     'JONATHAN Y DESIGNS L60, ' || {location.address1} ||     CASE WHEN {location.city} IS NOT NULL THEN ', ' || {location.city} ELSE '' END ||     CASE WHEN {location.state} IS NOT NULL THEN ', ' || {location.state} ELSE '' END ||     CASE WHEN {location.zip} IS NOT NULL THEN ' ' || {location.zip} ELSE '' END    WHEN {location} = 'Flemington L41' THEN     'JONATHAN Y DESIGNS L41, ' || {location.address1} ||     CASE WHEN {location.city} IS NOT NULL THEN ', ' || {location.city} ELSE '' END ||     CASE WHEN {location.state} IS NOT NULL THEN ', ' || {location.state} ELSE '' END ||     CASE WHEN {location.zip} IS NOT NULL THEN ' ' || {location.zip} ELSE '' END END",
                            summary: "GROUP",
                            label: "shipFromFormula"
                        }),
                        search.createColumn({
                            name: "formulatext",
                            formula: "'Amazon.com, ' ||  CASE WHEN {shipaddressee} IS NOT NULL THEN {shipaddressee} ELSE ' ' END || ', ' ||  NVL({shipaddress1}, ' ') || ' & ' ||   NVL({shipaddress2}, ' ') || ', ' ||  NVL({shipcity}, ' ') || ', ' ||  NVL({shipstate}, ' ') || ', ' ||  NVL({shipzip}, ' ')",
                            summary: "GROUP",
                            label: "shipToFormula"
                        }),

                        search.createColumn({
                            name: "custitem129",
                            join: "item",
                            summary: "GROUP",
                            label: "amazon_id"
                        }),

                        search.createColumn({ name: "custbody_scheduled_pickup_date", summary: "GROUP" }),
                        search.createColumn({ name: "otherrefnum", summary: "GROUP" }),
                        search.createColumn({ name: "custbody33", summary: "GROUP" }),
                        search.createColumn({ name: "location", summary: "GROUP" })
                    ]
                });
            }


            const searchResults = salesorderSearch.run().getRange({ start: 0, end: 1000 });
            const searchCount = salesorderSearch.runPaged().count;

            const resultsByLocation = { "9": [], "15": [] };

            const seen = new Set();

            if (searchResults.length > 0) {
                searchResults.forEach(result => {

                    const internalId = result.getValue({ name: "internalid", summary: "GROUP" });
                    if (seen.has(internalId)) return; // skip duplicates
                    seen.add(internalId);

                    var asin = "";
                    var asinTyp = "";

                    var str =
                        result.getText({ name: "custbody_so_items", summary: "GROUP", label: "SO Items" }) ||
                        result.getValue({ name: "custbody_so_items", summary: "GROUP", label: "SO Items" });


                    if (!str) str = "";

                    var arr = str.split(";").map(s => s.trim()).filter(s => s.length > 0);
                    var uniqueArr = [...new Set(arr)];


                    asin = "MIXED SKU";
                    asinTyp = "MIXED TYPE";

                    // check if single item
                    if (uniqueArr.length === 1) {
                        var singleItemText = uniqueArr[0];
                        log.error("Single Item Detected", singleItemText);

                        var foundItem = null;

                        for (var key in specialIdMap) {
                            if (specialIdMap.hasOwnProperty(key)) {
                                var mapEntry = specialIdMap[key];
                                if (mapEntry.itemName && mapEntry.itemName.toUpperCase() === singleItemText.toUpperCase()) {
                                    foundItem = mapEntry;
                                    log.error("Item Found", "InternalID: " + key + " | AmazonID: " + mapEntry.amazonId + " | ItemName: " + mapEntry.itemName);
                                    break;
                                }
                            }
                        }

                        if (foundItem) {
                            asin = "SINGLE ASIN - " + foundItem.amazonId;
                            asinTyp = "SINGLE TYPE";
                        } else {
                            log.error("ItemId Not Found", singleItemText);
                        }
                    } else {
                        //log.error("Multiple Items Detected", uniqueArr.join(", "));
                    }


                    const locationId = result.getValue({ name: "location", summary: "GROUP" });
                    const location = result.getText({ name: "location", summary: "GROUP" });
                    const scacCode = result.getValue({ name: "custbody33", summary: "GROUP" });
                    const entityValue = result.getValue({ name: "entity", summary: "GROUP" });
                    const carrierName = result.getValue(result.columns.find(c => c.label === "driverNameFormula"));

                    const data = {
                        internalId: result.getValue({ name: "internalid", summary: "GROUP" }),
                        documentId: result.getValue({ name: "tranid", summary: "GROUP" }),
                        poNumber: result.getValue({ name: "otherrefnum", summary: "GROUP" }),
                        bol: (result.getValue({ name: "otherrefnum", summary: "GROUP" }) || "").replace(/-/g, ""),
                        pickingStatus: result.getValue({ name: "custbody_picking_status", summary: "GROUP" }),
                        arnValue: result.getValue({ name: "custbody_amazon_arn", summary: "GROUP" }),
                        isCarrierChanged: result.getValue({ name: "custbody_carrier_changed", summary: "GROUP" }),
                        isPickUpChanged: result.getValue({ name: "custbody_pickup_date_changed", summary: "GROUP" }),
                        custid: result.getValue({ name: "entity", summary: "GROUP" }),
                        shipdate: result.getValue({ name: "custbody_scheduled_pickup_date", summary: "GROUP" }),
                        proNumber: result.getValue({ name: "custbody_bol_tracking_number", summary: "GROUP" }),
                        // pickupDate: result.getValue({ name: "custbody_bol_tracking_number", summary: "GROUP" }),
                        carrierName: carrierName,
                        asin: asin,
                        asinTyp: asinTyp,
                        shipFrom: result.getValue(result.columns.find(c => c.label === "shipFromFormula")),
                        shipTo: result.getValue(result.columns.find(c => c.label === "shipToFormula")),
                        scacCode: scacCode,
                        locationId: locationId,
                        location: location,
                        isAmazonOrder: ["476", "1807"].indexOf(entityValue) !== -1,
                        imageUrl: logoMap[scacCode] ? logoMap[scacCode] : carrierName
                    };

                    if (locationId === '9' || locationId === '15') {
                        resultsByLocation[locationId].push(data);
                    }
                });
            }

            return {
                status: 200,
                message: 'Data retrieved successfully',
                totalRecords: searchCount,
                data: resultsByLocation
            };

        } catch (error) {
            log.error('Error in restlet', error);
            return {
                status: 500,
                message: 'Error retrieving data',
                data: error.message
            };

        }
    }

    /**
     * Clears old pallet records and updates SSCC-related records with the latest pallet number.
     * Returns a JSON response with details.
     * 
     * @param {Object} data - JSON payload from request.
     * @returns {Object} Response JSON
     */

    function processPalletUpdate(data) {
        var response = {
            success: false,
            palletNumber: '',
            clearedCount: 0,
            updatedCount: 0,
            clearedIds: [],
            updatedIds: [],
            error: ''
        };

        try {

            var latestPalletNumber = '';
            var ssccCodes = [];
            var palletType = (data.type || '').trim().toLowerCase();

            var soId = data.internalId;
            // Step 1: Extract pallet number and SSCC codes
            for (var key in data) {
                if (['action', 'internalId', 'status', 'type', 'palletSize', 'totalPalletSize', 'carrierProNumber', 'palletCount', 'location', 'userName', 'portalId', 'isEmptyPallet'].indexOf(key) !== -1) {
                    continue;
                } else {
                    latestPalletNumber = key; // pallet key
                    var palletItems = data[key];
                    palletItems.forEach(function (line) {
                        if (line.sscc_code) ssccCodes.push(line.sscc_code);
                    });
                }
            }

            if (!latestPalletNumber) {
                response.error = 'Missing pallet number in input data.';
                return response;
            }

            // if (ssccCodes.length === 0) {
            //     response.error = 'No SSCC codes found to process.';
            //     return response;
            // }

            response.palletNumber = latestPalletNumber;

            // Step 2: Clear all old pallet records
            var clearSearch = search.create({
                type: "customrecord_jyswms_sales_order_track",
                filters: [['custrecord_jyswms_track_pallet_number', 'is', latestPalletNumber]],
                columns: ['internalid']
            });

            clearSearch.run().each(function (result) {
                var recId = result.getValue('internalid');
                response.clearedIds.push(recId);

                record.submitFields({
                    type: 'customrecord_jyswms_sales_order_track',
                    id: recId,
                    values: { custrecord_jyswms_track_pallet_number: '' },
                    options: { enableSourcing: false, ignoreMandatoryFields: true }
                });
                return true;
            });

            response.clearedCount = response.clearedIds.length;

            if (ssccCodes.length === 0) {

                var createPackages = createPackageRecords(data);

                log.error("createPackages", createPackages);
                response.createPackages = createPackages;
                response.error = 'No SSCC codes found to process.';
                return response;
            }

            // Step 3: Build combined SSCC filter
            var filters = [];
            ssccCodes.forEach(function (code, index) {
                if (index > 0) filters.push('OR');
                filters.push(['custrecord_jyswms_track_number', 'startswith', code]);
            });

            // Step 4: Find and update SSCC-related records
            var searchObj = search.create({
                type: 'customrecord_jyswms_sales_order_track',
                filters: filters,
                columns: ['internalid', 'custrecord_jyswms_track_number']
            });

            searchObj.run().each(function (result) {
                var recId = result.getValue('internalid');
                response.updatedIds.push(recId);

                record.submitFields({
                    type: 'customrecord_jyswms_sales_order_track',
                    id: recId,
                    values: {
                        custrecord_jyswms_track_pallet_number: latestPalletNumber,
                        custrecord_jyswms_track_type: palletType
                    },
                    options: { enableSourcing: false, ignoreMandatoryFields: true }
                });
                return true;
            });


            var createPackages = createPackageRecords(data);



            if (!soId) throw new Error('Missing internalId in input data');

            palletType = (data.type || '').trim().toLowerCase();



            // Step 2: Map pallet type to numeric value
            var palletTypeMap = {
                'single': 1,
                'double': 2
            };

            var newTypeNum = palletTypeMap[palletType.toLowerCase()] || 0;
            if (!newTypeNum) throw new Error('Invalid pallet type: ' + palletType);

            // Step 3: Directly update the Sales Order field
            var totalPalletSize = data.palletSize || 0;

            // if (data.totalPalletSize) {

            //     totalPalletSize = data.totalPalletSize;

            // } 
            // else {

            //     var soLookup = search.lookupFields({
            //         type: search.Type.SALES_ORDER,
            //         id: soId,
            //         columns: ['custbody46']
            //     });

            //     var rawValue = soLookup.custbody46 || '0';
            //     var custbody46Value = parseInt(rawValue.toString().trim()) || 0;

            //     log.debug('custbody46 Value', custbody46Value);

            //     totalPalletSize += custbody46Value;
            // }

            record.submitFields({
                type: 'salesorder',
                id: soId,
                values: {
                    custbody50: data.palletSize || 0,
                    custbody46: data.palletCount || 0,
                    custbody35: data.palletCount || 0, // total pallet count
                    custbody_jyswms_status: data.status || "",
                    custbody_wms_current_picked_qty: data.palletSize || 0  // 
                }
            });


            log.error("createPackages", createPackages);
            response.updatedCount = response.updatedIds.length;
            response.createPackages = createPackages;
            response.success = true;

        } catch (e) {
            log.error('Error in processPalletUpdate', e);
            response.error = e.message || JSON.stringify(e);
        }

        return response;
    }


    /**
       * Creates an image file in the File Cabinet and returns the file URL
       * @param {Object} data - Input JSON
       * @param {string} data.fileName - Original file name (e.g., "sampleImage.jpg")
       * @param {string} data.fileType - NetSuite file type (e.g., "JPGIMAGE", "PNGIMAGE")
       * @param {string} [data.fileContent] - Base64 encoded image content
       * @param {string} [data.type] - Content type (usually "base64")
       * @param {string} [data.bolNumber] - Optional BOL number to prefix filename
       * @param {number} [data.folderId] - Optional File Cabinet folder ID (default: 11895)
       * @returns {Object} - { success: true/false, message, fileId, fileName, url }
       */


    function createImageFile(data) {
        try {

            var fileName = data.fileName || '';
            var fileType = data.fileType || file.Type.JPGIMAGE;
            var folderId = data.folderId || 11865; // default folder
            var base64Data = data.fileContent;
            var bolNumber = data.bolNumber || '';
            var salesOrderId = data.internalId || '';
            var palletCount = data.palletCount || '';
            var customrecId = null;

            if (!base64Data) {
                return { success: false, message: 'Missing file content (fileContent)' };
            }

            /* ------------------------------
               Search Custom Fulfillment Record
            -------------------------------- */
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

            log.error('Sales Order ID', salesOrderId);
            log.error('Custom Record ID', customrecId);

            /* ------------------------------
               Create Image File
            -------------------------------- */
            var finalFileName = 'SOID_' + salesOrderId;

            var imageFile = file.create({
                name: finalFileName,
                fileType: fileType,
                contents: base64Data,
                folder: folderId,
                isOnline: true
            });

            var fileId = imageFile.save();
            var savedFile = file.load({ id: fileId });

            /* ------------------------------
               Update Sales Order
            -------------------------------- */
            if (salesOrderId && fileId) {

                record.submitFields({
                    type: record.Type.SALES_ORDER,
                    id: salesOrderId,
                    values: {
                        custbody_bol_tracking_number: bolNumber,
                        custbody35: palletCount,
                        // custbody46: palletCount,
                        custbody_wms_bol_tracking_image: fileId
                    },
                    options: {
                        enableSourcing: false,
                        ignoreMandatoryFields: true
                    }
                });

                log.debug('Sales Order Updated', 'SO ID: ' + salesOrderId);
            }

            /* ------------------------------
               LOAD & SUBMIT Custom Record
            -------------------------------- */

            log.error('customrecId ' + customrecId);
            log.error('fileId ' + fileId);
            if (customrecId && fileId) {

                var customRec = record.load({
                    type: 'customrecord_order_fulfillment_details',
                    id: customrecId,
                    isDynamic: false
                });

                customRec.save({
                    enableSourcing: false,
                    ignoreMandatoryFields: true
                });

                log.error('Custom Record Updated', 'CustomRec ID: ' + customrecId);
            }

            return {
                success: true,
                message: 'File uploaded and records updated successfully',
                fileId: fileId,
                customrecId: customrecId,
                fileName: savedFile.name,
                url: savedFile.url
            };

        } catch (error) {
            log.error('File Upload Error', error);
            return {
                success: false,
                message: error.message || error
            };
        }
    }

    // function createImageFile(data) {
    //     try {

    //         const fileName = data.fileName || '';
    //         const fileType = data.fileType || file.Type.JPGIMAGE;
    //         const folderId = data.folderId || 11865;//762; //11895; 11865// default folder
    //         const base64Data = data.fileContent;
    //         const bolNumber = data.bolNumber || '';

    //         var salesOrderId = data.internalId || '';

    //         log.error("salesOrderId", salesOrderId);

    //         if (!base64Data) {
    //             return { success: false, message: 'Missing file content (fileContent)' };
    //         }

    //         // // Construct final filename (prefix with BOL number if provided)
    //         // const finalFileName = bolNumber
    //         //     ? `${bolNumber}_${fileName}`
    //         //     : fileName;
    //         var finalFileName = "SOID_" + salesOrderId;
    //         // Create the file in File Cabinet
    //         const imageFile = file.create({
    //             name: finalFileName,
    //             fileType: fileType,
    //             contents: base64Data,
    //             folder: folderId,
    //             isOnline: true
    //         });

    //         const fileId = imageFile.save();

    //         // Load the file to get its URL
    //         const savedFile = file.load({ id: fileId });

    //         //   var amzccIds =  getCustomRecordIdsBySalesOrder(salesOrderId);

    //         //    if (amzccIds && amzccIds.length > 0){
    //         //     for (var i=0; i<amzccIds.length; i++) {


    //         //     }
    //         //    }

    //         if (salesOrderId && fileId) {
    //             // Update 3 custom fields on the Sales Order
    //             record.submitFields({
    //                 type: record.Type.SALES_ORDER,
    //                 id: salesOrderId,
    //                 values: {
    //                     custbody_bol_tracking_number: data.bolNumber, // bol number
    //                     custbody35: data.palletCount, // total pallet count
    //                     custbody_wms_bol_tracking_image: fileId,
    //                     custbody_wms_current_picked_qty: data.palletCount
    //                 },
    //                 options: {
    //                     enableSourcing: false,
    //                     ignoreMandatoryFields: true
    //                 }
    //             });

    //             log.debug('Sales Order Updated', 'Updated 3 custom fields for SO ID: ' + salesOrderId);
    //         }
    //         else {
    //             log.error('Missing Sales Order ID', 'salesOrderId not provided');
    //         }

    //         return {
    //             success: true,
    //             message: 'File uploaded successfully',
    //             fileId: fileId,
    //             fileName: savedFile.name,
    //             url: savedFile.url
    //         };

    //     }
    //     catch (error) {
    //         log.error('File Upload Error', error);
    //         return { success: false, message: error.message || error };

    //     }
    // }


    function getCustomRecordIdsBySalesOrder(salesorderId) {
        try {
            var internalIds = [];

            if (!salesorderId) {
                log.error('Missing Parameter', 'salesorderId is required');
                return internalIds;
            }

            var customRecSearch = search.create({
                type: 'customrecord_amzcc_custom_rec',
                filters: [
                    ['custrecord_sales_order_id', 'anyof', salesorderId]
                ],
                columns: ['internalid'] // only fetching internal IDs
            });

            var pagedData = customRecSearch.runPaged({ pageSize: 1000 });

            pagedData.pageRanges.forEach(function (pageRange) {
                var page = pagedData.fetch({ index: pageRange.index });
                page.data.forEach(function (result) {
                    internalIds.push(result.id);
                });
            });

            log.audit('Custom Record IDs', internalIds);
            return internalIds;

        } catch (e) {
            log.error('Error in getCustomRecordIdsBySalesOrder', e);
            return [];
        }
    }

    /**
     * Main entry - simplified to call syncPalletPackages per pallet key.
     * data: the input JSON you provided
     */
    function createPackageRecords(data) {
        var summary = {
            created: [],
            deleted: [],
            skipped: [],
            errors: []
        };

        try {
            var itemObj = getInventoryItemDataLarge();
            // log.error('itemObj loaded', Object.keys(itemObj).length + ' items');

            var trackingNumber = '1067502680X0000'; // your hardcoded tracking number (keep/change as required)

            // loop keys (pallet keys)
            for (var key in data) {
                if (!data.hasOwnProperty(key)) continue;
                // skip known header fields
                if (['action', 'internalId', 'carrierProNumber', 'palletSize', 'totalPalletSize', 'status', 'type', 'palletCount', 'location', 'userName', 'portalId', 'isEmptyPallet'].indexOf(key) !== -1) continue;

                var palletLines = data[key];
                log.error("palletLines", palletLines);
                var fulfillmentId = data.internalId || null;
                trackingNumber = key || '1067502680X0000';

                try {
                    //   log.audit('🔎 Syncing pallet', { pallet: key, lines: palletLines.length });

                    var res = syncPalletPackages(key, palletLines, fulfillmentId, trackingNumber, itemObj);

                    // merge results into summary
                    summary.created = summary.created.concat(res.created);
                    summary.deleted = summary.deleted.concat(res.deleted);
                    summary.skipped = summary.skipped.concat(res.skipped);
                    if (res.errors && res.errors.length) {
                        summary.errors = summary.errors.concat(res.errors);
                    }

                } catch (innerE) {
                    log.error('❌ Error syncing pallet ' + key, innerE);
                    summary.errors.push({ pallet: key, message: innerE.message || innerE.toString() });
                }
            }

            log.audit('✅ Finished syncing all pallets', {
                created: summary.created.length,
                deleted: summary.deleted.length,
                skipped: summary.skipped.length,
                errors: summary.errors.length
            });

            return {
                success: true,
                summary: summary
            };

        } catch (e) {
            log.error('Main Error in createPackageRecords', e);
            return {
                success: false,
                message: e.message || e.toString()
            };
        }
    }

    /**
     * Sync a single pallet: compare existing SSCCs and create/delete as needed.
     * Returns { created: [ids], deleted: [ids], skipped: [ssccs], errors: [..] }
     */
    function syncPalletPackages(palletKey, palletLines, fulfillmentId, trackingNumber, itemObj) {

        var created = [];
        var deleted = [];
        var skipped = [];
        var errors = [];

        // 1) Fetch existing packages for this pallet & tracking number
        var existingPackages = getExistingPackages(palletKey);
        // existingPackages: { ssccValue (string) : internalId }

        log.audit('🔎 Existing packages fetched', {
            pallet: palletKey,
            trackingNumber: trackingNumber,
            existingCount: Object.keys(existingPackages).length
        });

        // Box counter starts at 1 per pallet
        var boxCounter = 1;

        // 2) For each input line, either skip or create
        palletLines.forEach(function (line) {
            try {
                var sscc = (line.sscc_code || '').toString();
                // If SSCC exists in NetSuite for this pallet/tracking -> skip & remove from map so it won't be deleted later
                if (sscc && existingPackages.hasOwnProperty(sscc)) {
                    //  log.audit(' Skipping Already Existing Record', { pallet: palletKey, sscc: sscc, id: existingPackages[sscc] });
                    skipped.push(sscc);
                    delete existingPackages[sscc];
                    boxCounter++; // still increment box number to keep consistent numbering
                    return;
                }

                // If SSCC is blank but item exists: still create (based on original code). We match only on SSCC per requirement.
                // Create new package record
                log.audit('Creating New Record', { pallet: palletKey, sscc: sscc, box: boxCounter, item: line.item });

                var packageRec = record.create({
                    type: 'customrecordhj_tc_package_contents',
                    isDynamic: true
                });
                packageRec.setValue({
                    fieldId: 'custrecord_jyswms_createdfrom',
                    value: true
                });
                // Body fields
                packageRec.setValue({
                    fieldId: 'custrecordhj_pkg_pallet',
                    value: palletKey
                });

                packageRec.setValue({
                    fieldId: 'custrecordhj_pkgbox',
                    value: boxCounter.toString()
                });

                // weight: prefer provided weight, else lookup by item
                var itemId = line.item;
                var itemdetails = itemObj[itemId];
                var weightVal = parseFloat(line.weight || (itemdetails ? itemdetails.weight : 0)) || 0;

                packageRec.setValue({
                    fieldId: 'custrecordhj_tc_packagecontentslbs',
                    value: weightVal
                });

                // SSCC code
                packageRec.setValue({
                    fieldId: 'custrecordhj_ucc',
                    value: sscc
                });

                // Tracking number
                packageRec.setValue({
                    fieldId: 'custrecordhj_pkg_trackingnumber',
                    value: trackingNumber
                });

                // If you want to link to fulfillment/parent record and you have the field, uncomment and set correct field id:
                // packageRec.setValue({ fieldId: 'custrecord_hj_packagecontents_sublist', value: fulfillmentId });

                // Sublist line - item must be internal id; lookup from itemObj
                var itemInternalId = (itemdetails && itemdetails.internalId) ? itemdetails.internalId : (line.item || null);

                packageRec.setValue({
                    fieldId: 'custrecord_jyswms_item_id',
                    value: itemInternalId
                });


                var package_Content = itemId + "/1";
                // Tracking number
                packageRec.setValue({
                    fieldId: 'custrecordhj_pkg_desc',
                    value: package_Content
                });

                packageRec.selectNewLine({
                    sublistId: 'recmachcustrecordhj_tc_pkgcont_lineitemparent'
                });

                packageRec.setCurrentSublistValue({
                    sublistId: 'recmachcustrecordhj_tc_pkgcont_lineitemparent',
                    fieldId: 'custrecordhj_tc_pkgcontents_lineitemitem',
                    value: itemInternalId
                });

                // Optionally set quantity on the sublist if you have that field (not in original)
                if (line.quantity) {
                    try {
                        packageRec.setCurrentSublistValue({
                            sublistId: 'recmachcustrecordhj_tc_pkgcont_lineitemparent',
                            fieldId: 'custrecordhj_tc_pkgcontents_lineitemqty', // change if your qty field id differs
                            value: parseFloat(line.quantity) || 0
                        });
                    } catch (eQty) {
                        // field might not exist; ignore silently
                    }
                }

                packageRec.commitLine({
                    sublistId: 'recmachcustrecordhj_tc_pkgcont_lineitemparent'
                });

                var packageId = packageRec.save({
                    enableSourcing: true,
                    ignoreMandatoryFields: false
                });

                created.push(packageId);
                log.audit('Package Created', { pallet: palletKey, box: boxCounter, item: line.item, sscc: sscc, id: packageId });

                boxCounter++;

            } catch (errCreate) {
                log.error('Error Creating Package (pallet ' + palletKey + ' box ' + boxCounter + ')', errCreate);
                errors.push({ pallet: palletKey, box: boxCounter, message: errCreate.message || errCreate.toString() });
                boxCounter++;
            }
        });

        // 3) Any remaining entries in existingPackages were present in NetSuite but NOT in input -> delete them
        Object.keys(existingPackages).forEach(function (ssccRemaining) {
            var recId = existingPackages[ssccRemaining];
            try {
                // Delete the record
                record.delete({
                    type: 'customrecordhj_tc_package_contents',
                    id: recId
                });
                deleted.push(recId);
                log.audit(' Deleting Record Not Found in Input', { pallet: palletKey, sscc: ssccRemaining, id: recId });
            } catch (errDel) {
                log.error('Error Deleting Package ' + recId + ' (sscc: ' + ssccRemaining + ')', errDel);
                errors.push({ pallet: palletKey, id: recId, sscc: ssccRemaining, message: errDel.message || errDel.toString() });
            }
        });

        // Return per-pallet summary
        log.audit(' syncPalletPackages summary', {
            pallet: palletKey,
            created: created.length,
            deleted: deleted.length,
            skipped: skipped.length,
            errors: errors.length
        });

        return {
            created: created,
            deleted: deleted,
            skipped: skipped,
            errors: errors
        };
    }

    /**
     * Get existing package records for a given pallet & tracking number.
     * Returns mapping { sscc : internalId }
     */
    function getExistingPackages(palletKey) {
        var map = {};

        try {
            var pkgSearch = search.create({
                type: 'customrecordhj_tc_package_contents',
                filters: [
                    ['custrecordhj_pkg_pallet', 'is', palletKey]
                ],
                columns: [
                    search.createColumn({ name: 'internalid' }),
                    search.createColumn({ name: 'custrecordhj_ucc' })
                ]
            });

            // Use runPaged (safe for large result sets)
            var paged = pkgSearch.runPaged({ pageSize: 1000 });
            paged.pageRanges.forEach(function (pageRange) {
                var page = paged.fetch({ index: pageRange.index });
                page.data.forEach(function (result) {
                    var sscc = result.getValue({ name: 'custrecordhj_ucc' }) || '';
                    var id = result.getValue({ name: 'internalid' });
                    // store as string key
                    map[sscc.toString()] = id;
                });
            });

        } catch (e) {
            log.error('Error in getExistingPackages', e);
        }

        return map;
    }

    /**
     * Your existing helper - unchanged except small defensive parsing.
     * Returns mapping by itemId (itemid) -> { weight, upc, internalId }
     */
    function getInventoryItemDataLarge() {
        var itemData = {};

        try {
            var itemSearch = search.create({
                type: search.Type.INVENTORY_ITEM,
                filters: [],
                columns: [
                    search.createColumn({ name: 'internalid' }),
                    search.createColumn({ name: 'itemid' }),
                    search.createColumn({ name: 'weight' }),
                    search.createColumn({ name: 'upccode' })
                ]
            });

            var pagedData = itemSearch.runPaged({ pageSize: 1000 });

            pagedData.pageRanges.forEach(function (pageRange) {
                var page = pagedData.fetch({ index: pageRange.index });
                page.data.forEach(function (result) {
                    var itemId = result.getValue({ name: 'itemid' });
                    var internalId = result.getValue({ name: 'internalid' });
                    var weight = parseFloat(result.getValue({ name: 'weight' })) || 0;
                    var upc = result.getValue({ name: 'upccode' }) || '';

                    if (itemId) {
                        itemData[itemId] = {
                            weight: weight,
                            upc: upc,
                            itemId: itemId,
                            internalId: internalId
                        };
                    }
                });
            });

            log.debug('Inventory Items Fetched', Object.keys(itemData).length + ' items');
            return itemData;

        } catch (e) {
            log.error('Error fetching inventory items', e);
            return {};
        }
    }

    /**
   * Returns an array of unique IDs from customrecord_jyswms_sales_order_item search
   */
    function getPickedItemUniqueIds() {
        var uniqueIdList = [];

        var searchObj = search.create({
            type: "customrecord_jyswms_sales_order_item",
            filters: [],
            columns: [
                search.createColumn({ name: "custrecord_jyswms_item_uniqueid" }),
                search.createColumn({ name: "custrecord_jyswms_item_picked_qty" }),
                search.createColumn({ name: "custrecord_jyswms_item_picker_name" })
            ]
        });

        var pagedData = searchObj.runPaged({ pageSize: 1000 });

        pagedData.pageRanges.forEach(function (pageRange) {
            var page = pagedData.fetch({ index: pageRange.index });

            page.data.forEach(function (result) {
                var uniqueId = result.getValue("custrecord_jyswms_item_uniqueid");

                if (uniqueId) {
                    uniqueIdList.push(uniqueId);
                }
            });
        });

        return uniqueIdList;
    }

    function getPickedItemUniqueIdsMap() {
        var uniqueIdListMap = {};

        var searchObj = search.create({
            type: "customrecord_jyswms_sales_order_item",
            filters: [],
            columns: [
                search.createColumn({ name: "custrecord_jyswms_item_uniqueid" }),
                search.createColumn({ name: "custrecord_jyswms_item_picked_qty" }),
                search.createColumn({ name: "custrecord_jyswms_item_picker_name" })
            ]
        });

        var pagedData = searchObj.runPaged({ pageSize: 1000 });

        pagedData.pageRanges.forEach(function (pageRange) {
            var page = pagedData.fetch({ index: pageRange.index });

            page.data.forEach(function (result) {
                var uniqueId = result.getValue("custrecord_jyswms_item_uniqueid");

                if (uniqueId) {
                    //   uniqueIdList.push(uniqueId);
                    uniqueIdListMap[uniqueId] = result.getValue("custrecord_jyswms_item_picker_name");
                }
            });
        });

        return uniqueIdListMap;
    }

    //Helper function for  Debugging...

    function getUnpicked(context, pageSize, startIndex) {
        try {

            var scriptStartTime = new Date().getTime();
            //log.error('Script Started', 'Start Time: ' + scriptStartTime / 1000 + ' seconds');

            var scriptObj = runtime.getCurrentScript();
            var SalesOrderHeaderId = scriptObj.getParameter({ name: 'custscript_wms_ai_salesorder_header' });
            var SalesOrderItemLevelDataId = scriptObj.getParameter({ name: 'custscript_wms_ai_salesorder_items' });

            var pickedItemUniqueIds = getPickedItemUniqueIds();
            var pickedItemUniqueIdsMap = getPickedItemUniqueIdsMap();
            log.error('pickedItemUniqueIds', pickedItemUniqueIds.length);
            var itemPicked = false;
            // log.error('Item Parameter', SalesOrderItemLevelDataId);

            var itemPrimaryUnitsMap = itemPrimaryUnits();
            // log.error('itemPrimaryUnitsMap', JSON.stringify(itemPrimaryUnitsMap));

            var headerData = {};
            var filters = [];

            if (context.customer_id) {
                filters.push(['entity', 'anyof', context.customer_id]);
            }
            if (context.start_date && context.end_date) {
                filters.push('AND', ['trandate', 'within', context.start_date, context.end_date]);
            }



            // Load and apply filters for Header Search
            var headerSearch = search.load({ id: 4751 });



            if (filters.length > 0) {
                headerSearch.filters = (headerSearch.filters || []).concat(filters);
            }

            // Get total count using runPaged().count
            var totalCount = headerSearch.runPaged().count;
            var totalPages = Math.ceil(totalCount / pageSize);

            // Apply pagination
            var searchResult = headerSearch.run();
            var searchRange = searchResult.getRange({ start: startIndex, end: startIndex + pageSize });

            searchRange.forEach(function (result) {

                // log.error("Result", JSON.stringify(result));
                var internalID = result.getValue({ name: 'internalid' });
                log.error('SOID', internalID)
                record.submitFields({
                    type: record.Type.SALES_ORDER,
                    id: internalID,   // Make sure this is the SALES ORDER internal ID
                    values: {
                        custbody_jyswms_sync_complete: true
                    },
                    options: {
                        enableSourcing: true,
                        ignoreMandatoryFields: true
                    }
                });

                var recordData = {};

                result.columns.forEach(function (column) {
                    var columnName = toSnakeCase(column.label || column.name);
                    recordData[columnName] = result.getText(column) || result.getValue(column);
                });

                headerData[internalID] = recordData;
            });

            // Load and apply filters for Item Level Search with pagination
            var itemSearch = search.load({ id: SalesOrderItemLevelDataId });
            if (filters.length > 0) {
                itemSearch.filters = (itemSearch.filters || []).concat(filters);
            }

            var cartonsIds = {};
            var itemSearchResult = itemSearch.run();
            var itemSearchRange = itemSearchResult.getRange({ start: startIndex, end: startIndex + pageSize });

            itemSearchRange.forEach(function (result) {

                //  log.error("Result line level", JSON.stringify(result));
                var internalID = result.id;
                //  log.error("internalID", internalID);

                // Initialize carton counter for this internalID if not already set
                if (!cartonsIds[internalID]) {
                    cartonsIds[internalID] = 1;
                }


                if (headerData[internalID]) {
                    if (!headerData[internalID].itemDetails) {
                        headerData[internalID].itemDetails = [];
                    }

                    var itemData = {};
                    itemPicked = false;
                    result.columns.forEach(function (column) {
                        // log.error("column", JSON.stringify(column));

                        var columnName = toSnakeCase(column.label || column.name);

                        var uniqueId = result.getText(column) || result.getValue(column);

                        if (columnName === "unique_id" && pickedItemUniqueIds.includes(uniqueId)) {

                            var uniqueId = result.getText(column) || result.getValue(column);

                            // var pickername = pickedItemUniqueIdsMap[uniqueId];

                            // If uniqueId does exist → skip this line
                            if (pickedItemUniqueIds.includes(uniqueId)) {
                                var pickername = pickedItemUniqueIdsMap[uniqueId];   // skip and go to next line in .each()
                                //itemData["pickername"] = pickername;
                                itemData["unique_id"] = uniqueId;
                                itemPicked = true;
                            }

                            //  return true;

                        }
                        else if (columnName === "so_items") {

                            var str = result.getText(column) || result.getValue(column);

                            if (str) {
                                // Split the string into an array and trim spaces
                                var arr = str.split(";").map(function (s) { return s.trim(); });

                                // Remove empty entries
                                arr = arr.filter(function (s) { return s.length > 0; });

                                var itemslength = arr.length;
                                var lineItemLength = parseInt(result.getText({ name: 'quantity' }) || result.getValue({ name: 'quantity' })) || 0;

                                var itemId = result.getValue({ name: 'item' });

                                var itemText = result.getText({ name: 'item' });
                                var itemValue = result.getValue({ name: 'item' });

                                // Fallback logic (if needed)
                                var itemDisplay = itemText || itemValue;

                                // Log both for debugging
                                //                 log.error('Item Details', {
                                //     text: itemText,
                                //     value: itemValue,
                                //     used: itemDisplay,
                                //      itemId:itemId
                                // });
                                //var unit = result.getText({ name: 'unit' });

                                // ----------------- Primary Unit Conversion -----------------
                                if (itemPrimaryUnitsMap && itemPrimaryUnitsMap[itemId]) {

                                    var itemObj = itemPrimaryUnitsMap[itemId];
                                    // log.error("itemObj", itemObj);

                                    var rate = parseInt(itemObj?.rate || 1);  // default 1 if missing
                                    var unit = itemObj?.unit || '';

                                    // Perform conversion safely
                                    lineItemLength = parseInt(lineItemLength / rate);
                                }

                                var cartonInfo = [];

                                for (var i = 0; i < lineItemLength; i++) {
                                    var num = cartonsIds[internalID];
                                    var carton = num + " of " + itemslength;
                                    cartonInfo.push(carton);
                                    cartonsIds[internalID] = num + 1; // Increment within this order only
                                }
                                itemData["cartonInfo"] = cartonInfo;
                                // Get unique values
                                var uniqueArr = [];

                                for (var i = 0; i < arr.length; i++) {
                                    if (uniqueArr.indexOf(arr[i]) === -1) {
                                        uniqueArr.push(arr[i]);
                                    }
                                }

                                log.debug('Unique Items', uniqueArr);
                                log.debug('Unique Count', uniqueArr.length);

                                // If only one unique item, fetch amazon id
                                if (uniqueArr.length === 1) {
                                    var amazonId = result.getText({
                                        name: "custitem129",
                                        join: "item"
                                    }) || result.getValue({
                                        name: "custitem129",
                                        join: "item"
                                    });

                                    itemData["asin_type_TEST"] = "SINGLE ASIN -" + amazonId;
                                }
                                else {
                                    itemData["asin_type_TEST"] = "MIXED SKU";
                                }
                            }
                        }
                        else if (columnName == "amazon1yz7n_id") {
                            itemData["asin_typ"] = "SINGLE ASIN " + (result.getText(column) || result.getValue(column));
                        }
                        else if (columnName == 'quantity') {

                            var quantity = result.getText(column) || result.getValue(column);
                            quantity = parseInt(quantity);
                            var itemId = result.getValue({ name: 'item' });

                            var itemText = result.getText({ name: 'item' });
                            var itemValue = result.getValue({ name: 'item' });

                            // Fallback logic (if needed)
                            var itemDisplay = itemText || itemValue;

                            // Log both for debugging

                            //var unit = result.getText({ name: 'unit' });

                            // ----------------- Primary Unit Conversion -----------------
                            if (itemPrimaryUnitsMap && itemPrimaryUnitsMap[itemId]) {

                                var itemObj = itemPrimaryUnitsMap[itemId];


                                var rate = parseInt(itemObj?.rate || 1);  // default 1 if missing
                                var unit = itemObj?.unit || '';

                                // Perform conversion safely
                                quantity = parseInt(quantity / rate);
                                // quantity = Math.round(quantity / rate);

                            }

                            itemData["quantity"] = quantity;


                        }
                        else {
                            itemData[columnName] = result.getText(column) || result.getValue(column);
                        }

                    });

                    //   log.error("itemData", JSON.stringify(itemData));
                    if (!itemPicked)
                        headerData[internalID].itemDetails.push(itemData);
                }
            });
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

        }
        catch (e) {
            log.error("Error in getOrders function", e);

            return {
                status: 500,
                message: e.message
            };
        }
    }

    function getBinTransferData(headerIds) {
        var soIds = headerIds;
        var resultObj = {};

        var searchObj = search.create({
            type: "bintransfer",
            filters: [
                ["type", "anyof", "BinTrnfr"],
                "AND",
                ["custbody_realted_sales_order.mainline", "is", "T"],
                "AND",
                ["custbody_realted_sales_order.internalid", "anyof", soIds],
                "AND",
                ["mainline", "is", "T"],
                "AND",
                ["custbody_wms_ai_created_by", "is", "F"],
                "AND",
                ["custbody_realted_sales_order.custbody_jyswms_send_order", "is", "T"],
                "AND",
                ["custbody_realted_sales_order.custbody_bol_tracking_number", "isempty", ""]
            ],
            columns: [
                search.createColumn({ name: "internalid" }),  // added internal id
                search.createColumn({ name: "custbodycustbody_item_bin" }),
                search.createColumn({ name: "custbody_realted_sales_order" }),
                search.createColumn({ name: "custbody_item_name" }),
                search.createColumn({ name: "custbody_item_quantity" }),
                search.createColumn({
                    name: "binnumber",
                    join: "CUSTBODYCUSTBODY_ITEM_BIN"
                }),
                search.createColumn({
                    name: "custrecord_jyswms_sequence_number",
                    join: "CUSTBODYCUSTBODY_ITEM_BIN",
                    label: "Bin index"
                })
            ]
        });

        var pagedData = searchObj.runPaged({ pageSize: 1000 });

        pagedData.pageRanges.forEach(function (pageRange) {
            var page = pagedData.fetch({ index: pageRange.index });

            page.data.forEach(function (result) {
                var itemId = result.getValue("custbody_item_name");

                var row = {
                    internalId: result.getValue("internalid"),  // added
                    binId: result.getValue("custbodycustbody_item_bin"),
                    binNumber: result.getText("custbodycustbody_item_bin"),
                    relatedSalesOrder: result.getValue("custbody_realted_sales_order"),
                    item: result.getValue("custbody_item_name"),
                    quantity: result.getValue("custbody_item_quantity"),
                    binIndex: result.getValue({
                        name: "custrecord_jyswms_sequence_number",
                        join: "custbodycustbody_item_bin"
                    })
                };

                // Handle duplicate item IDs by pushing rows
                if (!resultObj[itemId]) {
                    resultObj[itemId] = [];
                }
                resultObj[itemId].push(row);
            });
        });

        return resultObj;
    }

    function getOrders(context, pageSize, startIndex) {
        try {

            var scriptStartTime = new Date().getTime();
            //log.error('Script Started', 'Start Time: ' + scriptStartTime / 1000 + ' seconds');

            var scriptObj = runtime.getCurrentScript();
            var SalesOrderHeaderId = scriptObj.getParameter({ name: 'custscript_wms_ai_salesorder_header' });
            var SalesOrderItemLevelDataId = scriptObj.getParameter({ name: 'custscript_wms_ai_salesorder_items' });

            var pickedItemUniqueIds = getPickedItemUniqueIds();
            var pickedItemUniqueIdsMap = getPickedItemUniqueIdsMap();
            log.error('pickedItemUniqueIds', pickedItemUniqueIds.length);
            var itemPicked = false;
            // log.error('Item Parameter', SalesOrderItemLevelDataId);

            var itemPrimaryUnitsMap = itemPrimaryUnits();
            // log.error('itemPrimaryUnitsMap', JSON.stringify(itemPrimaryUnitsMap));

            var headerData = {};
            var filters = [];

            if (context.customer_id) {
                filters.push(['entity', 'anyof', context.customer_id]);
            }
            if (context.start_date && context.end_date) {
                filters.push('AND', ['trandate', 'within', context.start_date, context.end_date]);
            }

            // Load and apply filters for Header Search
            var headerSearch = search.load({ id: SalesOrderHeaderId });

            if (filters.length > 0) {
                headerSearch.filters = (headerSearch.filters || []).concat(filters);
            }

            // Get total count using runPaged().count
            var totalCount = headerSearch.runPaged().count;
            var totalPages = Math.ceil(totalCount / pageSize);

            // Apply pagination
            var searchResult = headerSearch.run();
            var searchRange = searchResult.getRange({ start: startIndex, end: startIndex + pageSize });
            var headerIds = [];
            searchRange.forEach(function (result) {

                // log.error("Result", JSON.stringify(result));
                var internalID = result.getValue({ name: 'internalid' });
                if (internalID) {
                    headerIds.push(internalID);
                }

                // log.error('SOID',internalID);

                //       record.submitFields({
                //      type: record.Type.SALES_ORDER,
                //      id: internalID,   // Make sure this is the SALES ORDER internal ID
                //      values: {
                //          custbody_jyswms_sync_complete: true
                //      },
                //      options: {
                //          enableSourcing: true,
                //          ignoreMandatoryFields: true
                //      }
                //  });

                var recordData = {};

                result.columns.forEach(function (column) {
                    var columnName = toSnakeCase(column.label || column.name);
                    recordData[columnName] = result.getText(column) || result.getValue(column);
                });

                headerData[internalID] = recordData;
            });


            log.error("headerIds", headerIds);
            // Declare getBinTransfers
            var getBinTransfers = {};

            // 👉 If headerIds is NOT empty → perform search
            if (headerIds.length > 0) {
                getBinTransfers = getBinTransferData(headerIds);
            }
            log.error("getBinTransfers", getBinTransfers);

            // Load and apply filters for Item Level Search with pagination
            var itemSearch = search.load({ id: SalesOrderItemLevelDataId });
            if (filters.length > 0) {
                itemSearch.filters = (itemSearch.filters || []).concat(filters);
            }
            var cartonsIds = {};
            var itemSearchResult = itemSearch.run();
            var itemSearchRange = itemSearchResult.getRange({ start: startIndex, end: startIndex + pageSize });

            itemSearchRange.forEach(function (result) {

                //  log.error("Result line level", JSON.stringify(result));
                var internalID = result.id;
                //  log.error("internalID", internalID);

                // Initialize carton counter for this internalID if not already set
                if (!cartonsIds[internalID]) {
                    cartonsIds[internalID] = 1;
                }


                if (headerData[internalID]) {
                    if (!headerData[internalID].itemDetails) {
                        headerData[internalID].itemDetails = [];
                    }

                    var itemValue = result.getValue({ name: 'item' });

                    // Get Bin Transfer Data list
                    //  var existBinObj = getBinTransfers[itemValue] || [];
                    var existBinObj = getBinTransferData(result) || [];


                    // If empty → build an object with same fields but empty values
                    if (!existBinObj || !Array.isArray(existBinObj) || existBinObj.length === 0) {
                        existBinObj = [{
                            internalId: "",
                            binId: "",
                            binNumber: "",
                            relatedSalesOrder: "",
                            item: "",
                            quantity: "",
                            binIndex: ""
                        }];
                    }
                    var itemData = {};
                    itemPicked = false;

                    // if (!existBinObj) return;

                    for (var x = 0; x < existBinObj.length; x++) {

                        var binObj = existBinObj[x];

                        // log.error("binObj",binObj);
                        result.columns.forEach(function (column) {
                            // log.error("column", JSON.stringify(column));

                            var columnName = toSnakeCase(column.label || column.name);
                            var columnValue = result.getText(column) || result.getValue(column);


                            var uniqueId = result.getText(column) || result.getValue(column);

                            // if (columnName === "unique_id" && pickedItemUniqueIds.includes(uniqueId)) {

                            //     var uniqueId = result.getText(column) || result.getValue(column);

                            //     // var pickername = pickedItemUniqueIdsMap[uniqueId];

                            //     // If uniqueId does exist → skip this line
                            //     if (pickedItemUniqueIds.includes(uniqueId)) {
                            //         var pickername = pickedItemUniqueIdsMap[uniqueId];   // skip and go to next line in .each()
                            //         //itemData["pickername"] = pickername;
                            //        itemData["unique_id"] = uniqueId;
                            //         itemPicked = true;
                            //     }

                            //   //  return true;

                            // }
                            // else

                            if (columnName === "unique_id") {
                                itemData["unique_id"] = columnValue + "_" + x;

                            }
                            else if (columnName === "so_items") {

                                var str = result.getText(column) || result.getValue(column);

                                if (str) {
                                    // Split the string into an array and trim spaces
                                    var arr = str.split(";").map(function (s) { return s.trim(); });

                                    // Remove empty entries
                                    arr = arr.filter(function (s) { return s.length > 0; });

                                    var itemslength = arr.length;
                                    var lineItemLength = parseInt(result.getText({ name: 'quantity' }) || result.getValue({ name: 'quantity' })) || 0;

                                    var itemId = result.getValue({ name: 'item' });

                                    var itemText = result.getText({ name: 'item' });
                                    var itemValue = result.getValue({ name: 'item' });

                                    // Fallback logic (if needed)
                                    var itemDisplay = itemText || itemValue;

                                    // Log both for debugging
                                    //                 log.error('Item Details', {
                                    //     text: itemText,
                                    //     value: itemValue,
                                    //     used: itemDisplay,
                                    //      itemId:itemId
                                    // });
                                    //var unit = result.getText({ name: 'unit' });

                                    // ----------------- Primary Unit Conversion -----------------
                                    if (itemPrimaryUnitsMap && itemPrimaryUnitsMap[itemId]) {

                                        var itemObj = itemPrimaryUnitsMap[itemId];
                                        // log.error("itemObj", itemObj);

                                        var rate = parseInt(itemObj?.rate || 1);  // default 1 if missing
                                        var unit = itemObj?.unit || '';

                                        // Perform conversion safely
                                        lineItemLength = parseInt(lineItemLength / rate);
                                    }

                                    var cartonInfo = [];
                                    var car = parseInt(binObj.quantity);

                                    if (!car || car <= 0) {

                                        car = lineItemLength
                                    }

                                    for (var i = 0; i < car; i++) {
                                        var num = cartonsIds[internalID];
                                        var carton = num + " of " + itemslength;
                                        cartonInfo.push(carton);
                                        cartonsIds[internalID] = num + 1; // Increment within this order only
                                    }
                                    itemData["cartonInfo"] = cartonInfo;
                                    // Get unique values
                                    var uniqueArr = [];

                                    for (var i = 0; i < arr.length; i++) {
                                        if (uniqueArr.indexOf(arr[i]) === -1) {
                                            uniqueArr.push(arr[i]);
                                        }
                                    }

                                    log.debug('Unique Items', uniqueArr);
                                    log.debug('Unique Count', uniqueArr.length);

                                    // If only one unique item, fetch amazon id
                                    if (uniqueArr.length === 1) {
                                        var amazonId = result.getText({
                                            name: "custitem129",
                                            join: "item"
                                        }) || result.getValue({
                                            name: "custitem129",
                                            join: "item"
                                        });

                                        itemData["asin_type_TEST"] = "SINGLE ASIN -" + amazonId;
                                    }
                                    else {
                                        itemData["asin_type_TEST"] = "MIXED SKU";
                                    }
                                }
                            }
                            else if (columnName == "amazon1yz7n_id") {
                                itemData["asin_typ"] = "SINGLE ASIN " + (result.getText(column) || result.getValue(column));
                            }
                            else if (columnName == 'quantity') {


                                var quantity = columnValue // parseInt(binObj.quantity || 0);
                                var itemId = result.getValue({ name: 'item' });


                                // ----------------- Primary Unit Conversion -----------------
                                if (itemPrimaryUnitsMap && itemPrimaryUnitsMap[itemId]) {

                                    var itemObj = itemPrimaryUnitsMap[itemId];


                                    var rate = parseInt(itemObj?.rate || 1);  // default 1 if missing
                                    var unit = itemObj?.unit || '';

                                    // Perform conversion safely
                                    quantity = parseInt(quantity / rate);
                                    // quantity = Math.round(quantity / rate);

                                }

                                itemData["quantity"] = parseInt(binObj.quantity || quantity);
                                itemData["bin_id"] = parseInt(binObj.binId || "");
                                itemData["bin_index"] = parseInt(binObj.binIndex)
                                itemData["bin_name"] = parseInt(binObj.binNumber || " ");
                                itemData["bin_transfer_internalid"] = parseInt(binObj.internalId || "");
                                itemData["item_quantity"] = quantity;// parseInt(binObj.quantity || 0);


                            }
                            else {
                                itemData[columnName] = result.getText(column) || result.getValue(column);
                            }

                        });

                        //   log.error("itemData", JSON.stringify(itemData));
                        //  if (itemPicked)
                        headerData[internalID].itemDetails.push(itemData);
                    }
                }
            });
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

        }
        catch (e) {
            log.error("Error in getOrders function", e);

            return {
                status: 500,
                message: e.message
            };
        }
    }


    function getOrdersDUP(context) {
        try {

            //  var scriptStartTime = new Date().getTime();
            //log.error('Script Started', 'Start Time: ' + scriptStartTime / 1000 + ' seconds');

            // var scriptObj = runtime.getCurrentScript();
            // var SalesOrderHeaderId = scriptObj.getParameter({ name: 'custscript_wms_ai_salesorder_header' });
            // var SalesOrderItemLevelDataId = scriptObj.getParameter({ name: 'custscript_wms_ai_salesorder_items' });

            // var pickedItemUniqueIds = getPickedItemUniqueIds();
            // var pickedItemUniqueIdsMap = getPickedItemUniqueIdsMap();
            // log.error('pickedItemUniqueIds', pickedItemUniqueIds.length);
            var itemPicked = false;
            // log.error('Item Parameter', SalesOrderItemLevelDataId);

            var itemPrimaryUnitsMap = itemPrimaryUnits();
            // log.error('itemPrimaryUnitsMap', JSON.stringify(itemPrimaryUnitsMap));

            var headerData = {};
            var itemDetails = []
            var filters = [];

            // if (context.customer_id) {
            //     filters.push(['entity', 'anyof', context.customer_id]);
            // }
            // if (context.start_date && context.end_date) {
            //     filters.push('AND', ['trandate', 'within', context.start_date, context.end_date]);
            // }


            var headerIds = context.salesOrderHeaderId;
            var itemids = context.salesOrderItemId;

            // Load and apply filters for Item Level Search with pagination
            var itemSearch = search.load({ id: 4904 });

            var itemfilters = itemSearch.filters;
            if (headerIds && headerIds.length > 0) {
                //log.error("headerIds", headerIds);
                try {

                    itemfilters.push(search.createFilter({

                        name: 'internalid',

                        operator: search.Operator.ANYOF,

                        values: headerIds

                    }));


                } catch (e) {

                    log.error("error pushing item filters");

                    var response = e.message + " - " + headerIds;

                }

            }

            if (itemids && itemids.length > 0) {
                log.error("itemids", itemids);
                try {

                    itemfilters.push(search.createFilter({

                        name: 'item',

                        operator: search.Operator.ANYOF,

                        values: itemids
                    }));


                } catch (e) {

                    log.error("error pushing item filters");

                    var response = e.message + " - " + headerIds;

                }

            }



            itemSearch.filters = itemfilters;
            var cartonsIds = {};
            // var itemSearchResult = itemSearch.run();
            // var itemSearchRange = itemSearchResult.getRange({ start: startIndex, end: startIndex + pageSize });
            var pagedData = itemSearch.runPaged({
                pageSize: 1000
            });

            // Loop all pages
            pagedData.pageRanges.forEach(function (pageRange) {

                var page = pagedData.fetch({ index: pageRange.index });
                page.data.forEach(function (result) {

                   // log.error("Result line level", JSON.stringify(result));
                    var internalID = result.id;
                    //  log.error("internalID", internalID);

                    // Initialize carton counter for this internalID if not already set
                    if (!cartonsIds[internalID]) {
                        cartonsIds[internalID] = 1;
                    }

                    var itemValue = result.getValue({ name: 'item' });


                    var itemData = {};
                    itemPicked = false;

                    result.columns.forEach(function (column) {

                        // log.error("result", JSON.stringify(result));

                        var columnName = toSnakeCase(column.label || column.name);
                        var columnValue = result.getText(column) || result.getValue(column);



                        if (columnName === "unique_id") {
                            itemData["unique_id"] = columnValue;

                        }
                        else if (columnName === "so_items") {

                            var str = result.getText(column) || result.getValue(column);

                            if (str) {
                                // Split the string into an array and trim spaces
                                var arr = str.split(";").map(function (s) { return s.trim(); });

                                // Remove empty entries
                                arr = arr.filter(function (s) { return s.length > 0; });

                                var itemslength = arr.length;
                                var lineItemLength = parseInt(result.getText({ name: 'quantity' }) || result.getValue({ name: 'quantity' })) || 0;

                                var itemId = result.getValue({ name: 'item' });

                                var itemText = result.getText({ name: 'item' });
                                var itemValue = result.getValue({ name: 'item' });

                                // Fallback logic (if needed)
                                var itemDisplay = itemText || itemValue;



                                // ----------------- Primary Unit Conversion -----------------
                                if (itemPrimaryUnitsMap && itemPrimaryUnitsMap[itemId]) {

                                    var itemObj = itemPrimaryUnitsMap[itemId];
                                    // log.error("itemObj", itemObj);

                                    var rate = parseInt(itemObj?.rate || 1);  // default 1 if missing
                                    var unit = itemObj?.unit || '';

                                    // Perform conversion safely
                                    lineItemLength = parseInt(lineItemLength / rate);
                                }

                                var cartonInfo = [];
                                var car = lineItemLength;

                                if (!car || car <= 0) {

                                    car = lineItemLength
                                }

                                for (var i = 0; i < car; i++) {
                                    var num = cartonsIds[internalID];
                                    var carton = num + " of " + itemslength;
                                    cartonInfo.push(carton);
                                    cartonsIds[internalID] = num + 1; // Increment within this order only
                                }
                                itemData["cartonInfo"] = cartonInfo;
                                // Get unique values
                                var uniqueArr = [];

                                for (var i = 0; i < arr.length; i++) {
                                    if (uniqueArr.indexOf(arr[i]) === -1) {
                                        uniqueArr.push(arr[i]);
                                    }
                                }

                              //  log.debug('Unique Items', uniqueArr);
                              //  log.debug('Unique Count', uniqueArr.length);

                                // If only one unique item, fetch amazon id
                                if (uniqueArr.length === 1) {
                                    var amazonId = result.getText({
                                        name: "custitem129",
                                        join: "item"
                                    }) || result.getValue({
                                        name: "custitem129",
                                        join: "item"
                                    });

                                    itemData["asin_type_TEST"] = "SINGLE ASIN -" + amazonId;
                                }
                                else {
                                    itemData["asin_type_TEST"] = "MIXED SKU";
                                }
                            }
                        }
                        else if (columnName == "amazon1yz7n_id") {
                            itemData["asin_typ"] = "SINGLE ASIN " + (result.getText(column) || result.getValue(column));
                        }
                        else if (columnName == 'quantity') {


                            var quantity = columnValue // parseInt(binObj.quantity || 0);
                            var itemId = result.getValue({ name: 'item' });


                            // ----------------- Primary Unit Conversion -----------------
                            if (itemPrimaryUnitsMap && itemPrimaryUnitsMap[itemId]) {

                                var itemObj = itemPrimaryUnitsMap[itemId];


                                var rate = parseInt(itemObj?.rate || 1);  // default 1 if missing
                                var unit = itemObj?.unit || '';

                                // Perform conversion safely
                                quantity = parseInt(quantity / rate);
                                // quantity = Math.round(quantity / rate);

                            }

                            itemData["quantity"] = quantity;
                            itemData["bin_id"] = "";
                            itemData["bin_index"] = "";
                            itemData["bin_name"] = " ";
                            itemData["bin_transfer_internalid"] = "";
                            itemData["item_quantity"] = quantity;// parseInt(binObj.quantity || 0);


                        }
                        else {
                            itemData[columnName] = result.getText(column) || result.getValue(column);
                        }

                    });

                  //  log.error("itemData", itemData)
                    itemDetails.push(itemData);


                });

            });
            return itemDetails;

        }
        catch (e) {
            log.error("Error in getOrders function", e);

            return {
                status: 500,
                message: e.message
            };
        }
    }



    function getItemIdToCustomFieldMap() {
        var resultMap = {};
        var itemSearchObj = search.create({
            type: "item",
            filters: [["custitem129", "isnotempty", ""]],
            columns: [
                search.createColumn({ name: "custitem129" }), // Amazon ID
                search.createColumn({ name: "internalid" }),
                search.createColumn({ name: "itemid" })       // Item Name
            ]
        });

        var pagedData = itemSearchObj.runPaged({ pageSize: 1000 });
        //  log.error("Building Item Map", "Total Pages: " + pagedData.pageRanges.length);

        pagedData.pageRanges.forEach(function (pageRange) {
            var page = pagedData.fetch({ index: pageRange.index });
            page.data.forEach(function (result) {
                var internalId = result.getValue({ name: "internalid" });
                var amazonId = result.getValue({ name: "custitem129" });
                var itemName = result.getValue({ name: "itemid" });

                resultMap[internalId] = {
                    amazonId: amazonId || '',
                    itemName: itemName || ''
                };

                //log.error("Item Map Entry", "ID: " + internalId + " | AmazonID: " + amazonId + " | Name: " + itemName);
            });
        });

        // log.error("Item Map Completed", Object.keys(resultMap).length + " items mapped");
        return resultMap;
    }


    function transformInboundShipmentToItemReceipt(data, customRecId) {

        var results = [];
        var adjustmentsToMake = [];
        var count = 0;

        try {
            log.debug('1 Start', 'Received input: ' + JSON.stringify(data));

            var itemPrimaryUnitsMap = itemPrimaryUnits();
            log.debug('itemPrimaryUnitsMap', JSON.stringify(itemPrimaryUnitsMap));

            var conversionMap = getUOMMapByUnitType();

            log.debug('conversionMap', JSON.stringify(conversionMap));


            var inboundShipmentId = parseInt(data.inboundShipmentId, 10);
            var binId = parseInt(data.binId, 10);
            var location = data.location;
            var userName = data.userName;
            var vesselNumber = data.vesselNumber;
            var itemData = data.itemData || [];
            var itemMemoName = "";
            var itemDataLength = itemData.length;
            var locationName = data.locationName;

            // var uomMapForId = getUOMMapByUnitId();
            // log.error('uomMap id', JSON.stringify(uomMapForId));

            if (location == 0 || location == null || location == '' || location == 'undefined' || location == 9 || location == 15) {
                if (locationName == 'Flemington L41' || location == 9) {
                    location = 9;
                    binId = 1206;
                } else {
                    location = 15;
                    binId = 16691;
                }
            }

            // Step 1: Identify fully closed POs
            var closedPoIds = [];

            for (var i = 0; i < itemData.length; i++) {

                var poId = itemData[i].poId;
                itemMemoName = itemData[i].itemName;
                var enteredQuantity = itemData[i].enteredQuantity || 0;

                if (!enteredQuantity) {
                    count++;
                    continue;
                }

                //   if (enteredQuantity!= 0) {
                //   log.error("enteredQuantity", enteredQuantity);
                // }


                if (!poId) continue;

                var poRecord = record.load({
                    type: record.Type.PURCHASE_ORDER,
                    id: poId,
                    isDynamic: false
                });

                var status = poRecord.getValue({
                    fieldId: 'status'
                });
                //    log.debug("postatus", status);

                if (status == "Closed") {



                    log.error('PO Closed Details',
                        'Purchase Order #' + poId +
                        ' is fully closed. | Entered Quantity: ' + enteredQuantity +
                        ' | Item Name: ' + itemData[i].itemName
                    );


                    var quantity = itemData[i].enteredQuantity;
                    var itemId = itemData[i].itemId;
                    var unitFromJson = itemData[i].unit;
                    var unit = '';

                    if (conversionMap[unitFromJson]) {
                        var itemPrimaryUnitobj = conversionMap[unitFromJson];
                        log.error("itemPrimaryUnitobj", itemPrimaryUnitobj);

                        var itemPrimaryUnit = Number(
                            (itemPrimaryUnitobj && itemPrimaryUnitobj.rate) || 1
                        );


                        quantity = quantity * itemPrimaryUnit;
                    }


                    adjustmentsToMake.push({
                        itemId: itemId,
                        quantity: quantity,
                        location: location,
                        binId: binId,
                        userName: userName,
                        memo: '-{ New Item – not on Inbound-PO || PO fully closed - Item ID: ' + itemMemoName + ', Quantity: ' + quantity + ', Unit : ' + unit + '}-',
                        vesselNumber: vesselNumber,
                        unit: unit,
                    });
                    log.error("adjustment to make -- is fully closed.')", JSON.stringify(adjustmentsToMake));
                    closedPoIds.push(poId);
                }

                if (closedPoIds.length > 0) {
                    log.error("closedPO", closedPoIds);

                    itemData = itemData.filter(function (itm) {
                        return closedPoIds.indexOf(itm.poId) === -1;
                    });

                    log.error("itemData", itemData);

                    var msg = 'Skipped fully closed Purchase Orders: ' + closedPoIds.join(', ');
                    // log.error("msg", msg);

                }

            }

            if (count == itemDataLength) {
                log.error("count", count);
                return {
                    success: true,
                    inboundShipmentId: inboundShipmentId || null,
                    message: " No items were processed as the entered quantities are all zero.",
                };
            }


            var itemDataMap = {};
            log.error("adjustment To Make -- PO CLOSED", JSON.stringify(adjustmentsToMake));
            log.error("inboundShipmentId", inboundShipmentId);
            try {
                var inboundReceiveObj = record.load({
                    type: 'receiveinboundshipment',
                    id: inboundShipmentId,
                    isDynamic: false
                });

            } catch (error) {
                log.error("error message", error.message);
            }




            itemData.forEach(function (itm) {

                //log.error("itm", itm);

                var lotRecordIds = [];
                try {
                    log.error('LOT BLOCK - Item Start', JSON.stringify({
                        itemId: itm.itemId,
                        poId: itm.poId,
                        hasLotArray: !!itm.lotNumbers,
                        lotLength: itm.lotNumbers && itm.lotNumbers.length
                    }));

                    if (itm.lotNumbers && itm.lotNumbers.length > 0) {

                        itm.lotNumbers.forEach(function (lot, lotIdx) {

                            log.error('LOT BLOCK - Single Lot Incoming', JSON.stringify({
                                itemId: itm.itemId,
                                index: lotIdx,
                                lotNumber: lot && lot.lotNumber,
                                expiryDate: lot && lot.expiryDate,
                                quantity: lot && lot.quantity
                            }));

                            try {
                                var lotRec = record.create({
                                    type: 'customrecord_jyswms_lot_numbered_item_da',
                                    isDynamic: true
                                });

                                lotRec.setValue({
                                    fieldId: 'custrecord_lot_inbound_id',
                                    value: inboundShipmentId
                                });
                                lotRec.setValue({
                                    fieldId: 'custrecord_lot_bin_number',
                                    value: binId
                                });
                                lotRec.setValue({
                                    fieldId: 'custrecord_lot_location',
                                    value: location
                                });

                                lotRec.setValue({
                                    fieldId: 'custrecord_lot_item',
                                    value: itm.itemId
                                });

                                lotRec.setValue({
                                    fieldId: 'custrecord_lot_lot_number',
                                    value: lot.lotNumber
                                });

                                // Convert incoming expiry date (e.g. "2025-12-24") to a Date object NetSuite accepts
                                var expiryRaw = lot.expiryDate || '';
                                var expiryToSet = expiryRaw;
                                try {
                                    if (expiryRaw && typeof expiryRaw === 'string') {
                                        // Handle simple "YYYY-MM-DD" strings
                                        var isoMatch = expiryRaw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
                                        if (isoMatch) {
                                            var yearNum = parseInt(isoMatch[1], 10);
                                            var monthNum = parseInt(isoMatch[2], 10) - 1; // JS Date month is 0-based
                                            var dayNum = parseInt(isoMatch[3], 10);
                                            expiryToSet = new Date(yearNum, monthNum, dayNum);
                                        } else {
                                            // Fallback: let JS try to parse other string formats
                                            var tmp = new Date(expiryRaw);
                                            if (!isNaN(tmp.getTime())) {
                                                expiryToSet = tmp;
                                            }
                                        }
                                    }
                                    log.error('LOT BLOCK - Expiry To Set', {
                                        raw: expiryRaw,
                                        parsedType: Object.prototype.toString.call(expiryToSet),
                                        parsedValue: expiryToSet
                                    });
                                } catch (dateErr) {
                                    log.error('LOT BLOCK - Expiry Date Parse Failed', {
                                        raw: expiryRaw,
                                        error: dateErr
                                    });
                                }

                                lotRec.setValue({
                                    fieldId: 'custrecord_lot_expiry_data',
                                    value: expiryToSet
                                });

                                lotRec.setValue({
                                    fieldId: 'custrecord_lot_quantity',
                                    value: lot.quantity
                                });

                                lotRec.setValue({
                                    fieldId: 'custrecord_lot_portal_id',
                                    value: data.inboundShipmentId
                                });

                                var lotRecId = lotRec.save();
                                log.error("LOT BLOCK - Lot Record Created", JSON.stringify({
                                    itemId: itm.itemId,
                                    index: lotIdx,
                                    lotRecId: lotRecId
                                }));

                                lotRecordIds.push(lotRecId);


                            } catch (innerErr) {
                                log.error("LOT BLOCK - Error Creating Single Lot Record", {
                                    itemId: itm.itemId,
                                    error: innerErr
                                });
                            }

                        }); // end forEach lot
                    } else {
                        log.error('LOT BLOCK - No lots for item', JSON.stringify({
                            itemId: itm.itemId,
                            poId: itm.poId
                        }));
                    }

                } catch (lotErr) {
                    log.error("LOT BLOCK - Failed", {
                        itemId: itm && itm.itemId,
                        error: lotErr
                    });
                }

                if (itm.purchaseOrder === "No PO" || itm.purchaseOrder == null || itm.purchaseOrder == "" || itm.purchaseOrder == 0) {
                    log.error("in No PO");
                    if (parseInt(itm.enteredQuantity, 10) > 0) {

                        var quantity = parseInt(itm.enteredQuantity, 10);

                        itemMemoName = itm.itemName;

                        var itemId = itm.itemId;

                        var unitFromJson = itm.unit;
                        var unit = '';

                        if (conversionMap[unitFromJson]) {

                            log.debug("unitFromJson", unitFromJson);
                            var itemPrimaryUnitobj = conversionMap[unitFromJson];
                            log.error("itemPrimaryUnitinside", JSON.stringify(itemPrimaryUnitobj));
                            // Safely get itemPrimaryUnit from itemPrimaryUnitobj

                            var itemPrimaryUnit = (itemPrimaryUnitobj && itemPrimaryUnitobj.rate)
                                ? Number(itemPrimaryUnitobj.rate)
                                : 1;


                            quantity = quantity * itemPrimaryUnit;
                            // log.error("quantity", quantity);
                        }

                        // if (itemPrimaryUnitsMap[itemId]) {
                        //     var itemPrimaryUnit = Number(itemPrimaryUnitsMap[itemId]).toFixed(2);
                        //     quantity = Number(quantity * itemPrimaryUnit).toFixed(2);
                        // }



                        adjustmentsToMake.push({
                            itemId: itemId,
                            quantity: quantity,
                            location: location,
                            binId: binId,
                            userName: userName,
                            memo: '-{ New Item – not on Inbound-PO - Item ID: ' + itemId + ',Quantity: ' + quantity + ', Unit : ' + unit + '}-',
                            vesselNumber: vesselNumber,
                            unit: unit,
                        });

                        //   log.error("adjustment to make --  NO PO");
                        return;
                    }
                }
                // log.error("adjustment to make -- out of NO PO");
                if (itm.enteredQuantity == 0) {
                    return;
                }


                var key = itm.itemId + '_' + itm.poId;

                var quantity = itm.enteredQuantity;

                var itemId = itm.itemId;
                //    log.error('Item Info', 'Key: ' + key + ', Item ID: ' + itemId + ', Quantity: ' + quantity);

                if (itemPrimaryUnitsMap[itemId]) {

                    var itemObj = itemPrimaryUnitsMap[itemId];
                    //  log.error("itemObj", JSON.stringify(itemObj));

                    var itemPrimaryUnit = 1; // default multiplier
                    if (itemObj && itemObj.rate) {
                        itemPrimaryUnit = Number(itemObj.rate); //  Use the rate directly
                    }

                    quantity = Number(quantity) * itemPrimaryUnit;
                    quantity = Number(quantity.toFixed(2)); // optional: round to 2 decimals
                    // log.error("quantity y", quantity);
                }



                var unitFromJson = itm.unit;
                //  log.error("unitFromJson", unitFromJson);


                itemDataMap[key] = quantity;


                //   log.error('Mapped Item', key + ' => Qty: ' + quantity);


                // ------------------------------------------------------------------
                var itemCount = inboundReceiveObj.getLineCount({
                    sublistId: 'receiveitems'
                });
                log.debug(" item line count", itemCount);

                for (var i = 0; i < itemCount; i++) {

                    var itemIdFromLine = inboundReceiveObj.getSublistValue({
                        sublistId: 'receiveitems',
                        fieldId: 'item',
                        line: i
                    });

                    var poIdFromLine = inboundReceiveObj.getSublistValue({
                        sublistId: 'receiveitems',
                        fieldId: 'purchaseorder',
                        line: i
                    });

                    var expQtyFromLine = inboundReceiveObj.getSublistValue({
                        sublistId: 'receiveitems',
                        fieldId: 'quantity',
                        line: i
                    });

                    var sublistKey = itemIdFromLine + '_' + poIdFromLine;

                    if (sublistKey === key) {

                        log.debug("sublist key ", sublistKey);
                        var matched = true;

                        var enteredQty = itemDataMap[sublistKey];

                        // log.error("enteredQty", enteredQty);

                        if (enteredQty == 0) {
                            continue;
                        }

                        var quantityRemaining = inboundReceiveObj.getSublistValue({
                            sublistId: 'receiveitems',
                            fieldId: 'quantityremaining',
                            line: i
                        });


                        var quantityexpected = inboundReceiveObj.getSublistValue({
                            sublistId: 'receiveitems',
                            fieldId: 'quantityexpected',
                            line: i
                        }) || 0;

                        var quantityreceived = inboundReceiveObj.getSublistValue({
                            sublistId: 'receiveitems',
                            fieldId: 'quantityreceived',
                            line: i
                        }) || 0;
                        //    log.error('Quantities re', {
                        //     expected: quantityexpected,
                        //     received: quantityreceived,
                        //     remaining: quantityRemaining
                        // });

                        if (!quantityRemaining || quantityRemaining === 0) {
                            quantityRemaining = quantityexpected - quantityreceived;
                        }

                        // log.error('Quantities', {
                        //     expected: quantityexpected,
                        //     received: quantityreceived,
                        //     remaining: quantityRemaining
                        // });

                        if (!quantityRemaining || quantityRemaining <= 0) {

                            results.push({
                                success: true,
                                message: 'Line already fully received',
                                itemId: itm.itemId
                            });

                            break; // move to next itm
                        }

                        var diff = enteredQty - quantityRemaining; // +ve = excess, -ve = short  7-5 =2

                        //  log.error("difference", diff);
                        var receiveQty;

                        if (diff > 0) {
                            //log.error("difference is greate tan Zero",diff);

                            receiveQty = quantityRemaining; //

                            var unitFromJson = itm.unit;
                            //  log.error("unitFromJson",unitFromJson);
                            var unit = '';


                            // if (!itemPrimaryUnitsMap[itemId]) {
                            //      // log.error("reciveQty in difference", receiveQty);
                            //    // log.error("conversionMap",conversionMap);
                            //        var itemPrimaryUnit = Number(conversionMap[unitFromJson]?.rate || 1);
                            //        //  log.error("itemPrimaryUnit", itemPrimaryUnit);
                            //         //     var itemPrimaryUnit = itemPrimaryUnitobj.rate;
                            //          diff = diff * itemPrimaryUnit;
                            //      //  log.error("diff - quantity", diff);

                            //      }

                            // ----------------- Primary Unit Conversion -----------------
                            if (itemPrimaryUnitsMap && itemPrimaryUnitsMap[itemId]) {

                                var itemObj = itemPrimaryUnitsMap[itemId];
                                //log.error("itemObj", itemObj);

                                var rate = Number(itemObj?.rate || 1);  // default 1 if missing
                                var unit = itemObj?.unit || '';

                                // Perform conversion safely
                                diff = Number(diff / rate).toFixed(2);
                            }

                            adjustmentsToMake.push({
                                itemId: itemId,
                                quantity: diff, // the overage
                                location: location,
                                binId: binId,
                                userName: userName,
                                memo: '-{ Excess items - Item ID: ' + itemId + ', Quantity: ' + diff + ', Inbound Shipment: ' + inboundShipmentId + ' Quantity: ' + quantity + ', Unit : ' + unit + '}-',
                                vesselNumber: vesselNumber,
                                unit: "",
                            });

                            // log.debug("adjustmentsToMake -- diff",adjustmentsToMake);

                        }
                        else {
                            receiveQty = enteredQty; // either matches remaining or is less
                            //  log.error("reciveQty", receiveQty);

                        }


                        inboundReceiveObj.setSublistValue({
                            sublistId: 'receiveitems',
                            fieldId: 'receiveitem',
                            line: i,
                            value: true
                        });


                        inboundReceiveObj.setSublistValue({
                            sublistId: 'receiveitems',
                            fieldId: 'quantitytobereceived',
                            line: i,
                            value: receiveQty
                        });
                        //  log.error("quantitytobereceived seted",receiveQty);


                        var subrecord = inboundReceiveObj.getSublistSubrecord({
                            sublistId: 'receiveitems',
                            fieldId: 'inventorydetail',
                            line: i
                        });



                        var existingAssignedQty = 0;
                        var assignmentCount = subrecord.getLineCount({
                            sublistId: 'inventoryassignment'
                        });
                        for (var j = 0; j < assignmentCount; j++) {
                            existingAssignedQty += parseFloat(subrecord.getSublistValue({
                                sublistId: 'inventoryassignment',
                                fieldId: 'quantity',
                                line: j
                            })) || 0;
                        }

                        var remainingToAssign = receiveQty - existingAssignedQty;
                        log.error("remainingToAssign", remainingToAssign);

                        if (remainingToAssign > 0) {


                            var newLineIndex = subrecord.getLineCount({
                                sublistId: 'inventoryassignment'
                            });
                            subrecord.setSublistValue({
                                sublistId: 'inventoryassignment',
                                fieldId: 'binnumber',
                                line: newLineIndex,
                                value: binId
                            });
                            subrecord.setSublistValue({
                                sublistId: 'inventoryassignment',
                                fieldId: 'quantity',
                                line: newLineIndex,
                                value: remainingToAssign
                            });
                        }

                        break;
                    }
                }


                if (!matched) {
                    log.error("no matc found");
                    var quantity = itm.enteredQuantity;
                    var itemId = itm.itemId;

                    var unitFromJson = itm.unit;
                    var unit = '';

                    if (conversionMap[unitFromJson]) {
                        // Safely get the conversion object from the map
                        var itemPrimaryUnitobj = conversionMap[unitFromJson];

                        // Log for debugging
                        log.error("unitFromJson", unitFromJson);
                        log.error("itemPrimaryUnitobj", itemPrimaryUnitobj);

                        // Safely get rate (default to 1 if not found)
                        var itemPrimaryUnit = Number(itemPrimaryUnitobj && itemPrimaryUnitobj.rate ? itemPrimaryUnitobj.rate : 1);

                        quantity = quantity * itemPrimaryUnit;
                    }

                    //       if (uomMapForId[unitFromJson]) {
                    //          unit = uomMapForId[unitFromJson];
                    //       }

                    //  if (itemPrimaryUnitsMap[itemId]) {

                    //       var itemPrimaryUnit = Number(itemPrimaryUnitsMap[itemId]).toFixed(2);
                    //         quantity = Number(quantity * itemPrimaryUnit).toFixed(2);
                    // }



                    log.error("adjustmentsToMake --  Excess items ");
                    adjustmentsToMake.push({
                        itemId: itemId,
                        quantity: quantity,
                        location: location,
                        binId: binId,
                        userName: userName,
                        memo: '-{ Excess items -' + itemId + ' with quantity : ' + quantity + ' of Inbound Shipment ' + inboundShipmentId + 'Quantity: ' + quantity + ', Unit : ' + unit + '}-',
                        vesselNumber: vesselNumber,
                        unit: unit,
                    });
                }
            });


            var invAdjId;

            log.error("adjustmentsToMake", JSON.stringify(adjustmentsToMake));

            if (adjustmentsToMake.length > 0) {
                var adjustmentRecord = record.create({
                    type: record.Type.INVENTORY_ADJUSTMENT,
                    isDynamic: true
                });

                adjustmentRecord.setValue({
                    fieldId: 'subsidiary',
                    value: 1
                }); // hard‑coded example
                adjustmentRecord.setValue({
                    fieldId: 'account',
                    value: 464
                }); // adjust‑ment account
                adjustmentRecord.setValue({
                    fieldId: 'custbody_wms_ai_created_by',
                    value: true
                });

                adjustmentsToMake.forEach(function (adj) {
                    try {

                        adjustmentRecord.setValue({
                            fieldId: 'adjlocation',
                            value: adj.location
                        });
                        adjustmentRecord.setValue({
                            fieldId: 'custbody_wms_ai_pickername',
                            value: adj.userName || ''
                        });

                        var tempMemo = adjustmentRecord.getValue({ fieldId: 'custbody_jyswms_excess_items' }) || '';

                        var newMemo = tempMemo;
                        if (adj.memo) {
                            newMemo += (newMemo ? ' | ' : '') + adj.memo;
                        }

                        adjustmentRecord.setValue({
                            fieldId: 'custbody_jyswms_excess_items',
                            value: newMemo
                        });

                        adjustmentRecord.setValue({
                            fieldId: 'memo',
                            value: "Excess items for Inbound " + customRecId
                        });


                        // if (adj.unit) {

                        //   log.error("adj unit", adj.unit);
                        //    adjustmentRecord.setValue({
                        //       fieldId: 'units',
                        //       value: adj.unit
                        //   });
                        // }

                        adjustmentRecord.setValue({
                            fieldId: 'custbody_inboundshipmentlink',
                            value: inboundShipmentId
                        });

                        adjustmentRecord.setValue({
                            fieldId: 'custbody_wms_con_vessel_number',
                            value: adj.vesselNumber
                        });
                        adjustmentRecord.setValue({
                            fieldId: 'custbody_overage_qty_updated',
                            value: true
                        });
                        adjustmentRecord.selectNewLine({
                            sublistId: 'inventory'
                        });
                        adjustmentRecord.setCurrentSublistValue({
                            sublistId: 'inventory',
                            fieldId: 'item',
                            value: adj.itemId
                        });
                        adjustmentRecord.setCurrentSublistValue({
                            sublistId: 'inventory',
                            fieldId: 'location',
                            value: adj.location
                        });
                        adjustmentRecord.setCurrentSublistValue({
                            sublistId: 'inventory',
                            fieldId: 'adjustqtyby',
                            value: adj.quantity
                        });
                        var invDet = adjustmentRecord.getCurrentSublistSubrecord({
                            sublistId: 'inventory',
                            fieldId: 'inventorydetail'
                        });
                        invDet.selectNewLine({
                            sublistId: 'inventoryassignment'
                        });
                        invDet.setCurrentSublistValue({
                            sublistId: 'inventoryassignment',
                            fieldId: 'binnumber',
                            value: parseInt(adj.binId, 10)
                        });
                        invDet.setCurrentSublistValue({
                            sublistId: 'inventoryassignment',
                            fieldId: 'quantity',
                            value: adj.quantity
                        });
                        invDet.commitLine({
                            sublistId: 'inventoryassignment'
                        });
                        adjustmentRecord.commitLine({
                            sublistId: 'inventory'
                        });
                    } catch (itemErr) {
                        log.error('Error processing adjustment line', itemErr);
                        results.push({
                            success: false,
                            message: itemErr.message,
                            itemId: adj.itemId
                        });
                    }
                });
            }
            const hasErrors = results.length > 0;
            log.error("hasErrors", hasErrors);
            if (customRecId) {
                if (hasErrors) {
                    record.submitFields({
                        type: 'customrecord_wms_ai_api_custom_rec',
                        id: customRecId,
                        values: {
                            custrecordwms_ai_api_custrec_error: JSON.stringify(results),
                            custrecord_wms_ai_api_custrec_status: 3,
                            custrecord_wms_ai_api_custrec_processing: false
                        }
                    });


                    return {
                        success: false,
                        message: results,
                    };
                }
                try {
                    var receiptId = inboundReceiveObj.save();
                } catch (error) {
                    log.error("error", error.message);
                }


                // var inboundShipment = record.load({
                //     type: 'inboundShipment',
                //     id: receiptId,
                //     isDynamic: true
                // });

                //  var inboundShipmentId = inboundReceiveObj.save();

                log.error('Inbound Shipment Receipt Saved', 'ID: ' + receiptId);
                log.error('Inbound Shipment Saved', 'ID: ' + inboundShipmentId);
                if (adjustmentRecord) {

                    invAdjId = adjustmentRecord.save({
                        enableSourcing: true,
                        ignoreMandatoryFields: true
                    });
                    log.error('Inventory Adjustment Created', invAdjId);

                }

                record.submitFields({
                    type: 'customrecord_wms_ai_api_custom_rec',
                    id: customRecId,
                    values: {
                        custrecordwms_ai_api_custrec_error: 'Item Receipt created: ' + receiptId + (invAdjId ? ' | InvAdj: ' + invAdjId : ''),
                        custrecord_wms_ai_api_custrec_status: 2, // Success
                        custrecord_wms_ai_api_custrec_processing: false,
                        custrecord_wms_ai_api_related_invadj: invAdjId || null
                    }
                });


                return {
                    success: true,
                    itemReceiptId: receiptId,
                    inventoryAdjustmentId: invAdjId || null,
                    message: "Item receipt created successfully.",
                };
            }

        } catch (e) {
            log.error('Error', e);
            results.push({
                success: false,
                message: e.message
            });

            if (customRecId) {
                record.submitFields({
                    type: 'customrecord_wms_ai_api_custom_rec',
                    id: customRecId,
                    values: {
                        custrecordwms_ai_api_custrec_error: JSON.stringify(results),
                        custrecord_wms_ai_api_custrec_status: 3, // Error
                        custrecord_wms_ai_api_custrec_processing: false
                    }
                });
            }

            return {
                success: false,
                message: results
            };
        }
    }

    function toCamelCase(label) {
        return label
            .replace(/[^a-zA-Z0-9 ]/g, '')
            .replace(/\s+(.)/g, (_, group1) => group1.toUpperCase())
            .replace(/^./, str => str.toLowerCase());
    }

    function getInboundRecords(context, pageSize, startIndex) {
        try {
            var ScriptStartTime = new Date().getTime();
            // log.error('context', JSON.stringify(context));

            var scriptObj = runtime.getCurrentScript();
            var inboundSearchId = scriptObj.getParameter({
                name: 'custscript_wms_ai_inbound_search'
            });

            var itemPrimaryUnitsMap = itemPrimaryUnits();
            log.debug('itemPrimaryUnitsMap', JSON.stringify(itemPrimaryUnitsMap));

            var itemDataPurchaseUnitMap = itemDataPurchaseUnit();
            log.debug('itemDataPurchaseUnitMap', JSON.stringify(itemDataPurchaseUnitMap));

            var uomMap = getUOMMapByUnitType();
            log.debug('uomMap', JSON.stringify(uomMap));

            var inboundSearch = search.load({
                id: inboundSearchId
            });

            const containerNumber = context.containerNumber || null;
            const inboundShipmentID = context.inboundShipmentID || null;

            log.debug('inboundShipmentID', inboundShipmentID + "container Number : " + containerNumber);

            const locationId = context.locationId || null;
            const pageSize = context.pageSize || 1000;

            // Build filters
            var filters = inboundSearch.filters.slice(); // Clone filters   ["vesselnumber","startswith","CAD123456"]

            if (containerNumber) {

                filters = [];

                filters.push(search.createFilter({
                    name: 'vesselnumber',
                    operator: search.Operator.STARTSWITH,
                    values: containerNumber
                }));

                inboundSearch.filters = filters;

            }

            if (locationId) {
                log.error("location", locationId);
                filters.push(search.createFilter({
                    name: 'receivinglocation',
                    operator: search.Operator.ANYOF,
                    values: locationId
                }));
            }

            if (inboundShipmentID) {

                filters = [];

                log.debug("Filtering by Inbound Shipment ID", inboundShipmentID);
                filters.push(search.createFilter({
                    name: 'internalid',
                    operator: search.Operator.ANYOF,
                    values: inboundShipmentID
                }));

                // Remove status and quantityremaining filters if they exist

                inboundSearch.filters = filters;
            }

            inboundSearch.filters = filters;

            var totalCount = inboundSearch.runPaged().count;
            var totalPages = Math.ceil(totalCount / pageSize);

            var searchResult = inboundSearch.run();
            var searchRange = searchResult.getRange({
                start: startIndex,
                end: startIndex + pageSize
            });

            var recordData = {};
            var inboundIds = searchRange.map(result => result.getValue({
                name: 'internalid'
            }));

            // Get bin info from Item Receipts created from these Inbound Shipments
            var binMap = {};

            searchRange.forEach(function (result) {

                var inboundId = result.getValue({
                    name: 'internalid'
                });

                let vendorName = '';
                let upcCode = '';
                let status = '';
                let binId = '';
                let binNumber = '';

                result.columns.forEach(function (col) {
                    var label = col.label || col.name;
                    var value = result.getText(col) || result.getValue(col);

                    if (label === 'Vendor Name') {
                        vendorName = value || '';
                    }
                    if (label === 'UPC Code') {
                        upcCode = value || '';
                    }
                    if (label == 'Bin Name') {
                        binName = value || '';
                    }
                    if (label == 'Bin Id') {
                        binId = value || '';
                    }

                    if (label === 'Status') {
                        status = value || '';
                    }
                });

                if (!recordData[inboundId]) {

                    recordData[inboundId] = {

                        inboundId: inboundId,
                        shipmentNumber: result.getValue({
                            name: 'shipmentnumber'
                        }),
                        containerNumber: result.getValue({
                            name: 'vesselnumber'
                        }) || ' ',
                        vesselNumber: result.getValue({
                            name: 'vesselnumber'
                        }) || ' ',
                        bolNumber: result.getValue({
                            name: 'billoflading'
                        }) || result.getText({
                            name: 'billoflading'
                        }),
                        locationName: result.getText({
                            name: 'receivinglocation'
                        }),
                        location: result.getValue({
                            name: 'receivinglocation'
                        }),
                        binId: binId,
                        binName: binName,
                        status: status,

                        dateCreated: result.getValue({
                            name: 'createddate'
                        }) || '',

                        totalLineCount: 0,
                        itemDetails: []
                    };

                    if (binMap[inboundId] && binMap[inboundId].length > 0) {
                        recordData[inboundId].binId = binMap[inboundId][0].binId;
                        recordData[inboundId].binName = binMap[inboundId][0].binName;
                    }
                }

                var quantityExpected = parseFloat(result.getValue({ name: 'quantityexpected' }) || '0');
                var quantityReceived = parseFloat(result.getValue({ name: 'quantityreceived' }) || '0');
                var quantityRemaining = parseFloat(result.getValue({ name: 'quantityremaining' }) || '0');


                var itemId = result.getValue({ name: 'item' });
                var unit = result.getText({ name: 'unit' });

                // ----------------- Primary Unit Conversion -----------------
                if (itemPrimaryUnitsMap && itemPrimaryUnitsMap[itemId]) {

                    var itemObj = itemPrimaryUnitsMap[itemId];
                    // log.error("itemObj", itemObj);

                    var rate = Number(itemObj?.rate || 1);  // default 1 if missing
                    var unit = itemObj?.unit || '';

                    // Perform conversion safely
                    quantityExpected = Number(quantityExpected / rate).toFixed(2);
                    quantityReceived = Number(quantityReceived / rate).toFixed(2);
                    quantityRemaining = Number(quantityRemaining / rate).toFixed(2);
                }

                // ----------------- Purchase Unit Conversion -----------------
                var purchaseUnit = result.getText({ name: 'unit' });

                if (uomMap && uomMap[purchaseUnit]) {

                    var uomMapobj = uomMap[purchaseUnit];
                    var rate = Number(uomMapobj?.rate || 1);

                    // log.error("set purchase item", itemId);

                    // Perform conversion safely
                    quantityExpected = Number(quantityExpected / rate).toFixed(2);
                    quantityReceived = Number(quantityReceived / rate).toFixed(2);
                    quantityRemaining = Number(quantityRemaining / rate).toFixed(2);
                }


                var poId = result.getValue({
                    name: 'purchaseorder'
                });

                var itemRaw = {
                    itemName: result.getText({
                        name: 'item'
                    }),
                    itemId: result.getValue({
                        name: 'item'
                    }),
                    upcCode: upcCode,
                    purchaseOrder: result.getText({
                        name: 'purchaseorder'
                    }),
                    poId: result.getValue({
                        name: 'purchaseorder'
                    }),
                    perishable: result.getValue({
                        name: "custitem208",
                        join: "item",
                        label: "perishable"
                    }),

                    vendorName: vendorName,
                    vendorId: result.getValue({
                        name: "internalid",
                        join: "vendor",
                        label: "vendor id"
                    }),
                    actualShippingDate: result.getValue({
                        name: 'actualshippingdate'
                    }) || "",
                    reference: inboundId,
                    quantityExpected: Number(quantityExpected),
                    quantityReceived: Number(quantityReceived),
                    quantityRemaining: Number(quantityRemaining),
                    unit: unit,
                    uniqueId: inboundId + "_" + poId + "_" +
                        (result.getValue({
                            name: 'vesselnumber'
                        }) || ' ') + "_" +
                        result.getText({
                            name: 'item'
                        }) + "_" +
                        result.getValue({
                            name: 'quantityremaining'
                        })
                };


                var item = {};
                Object.keys(itemRaw).forEach(function (key) {
                    item[toCamelCase(key)] = itemRaw[key];
                });

                recordData[inboundId].itemDetails.push(item);
            });


            Object.keys(recordData).forEach(function (key) {
                var inboundInternalId = recordData[key].inboundId; // 4092
                var vesselNumber = recordData[key].vesselNumber;
                // log.error("inboundInternalId", inboundInternalId);

                search.create({
                    type: 'transaction',
                    filters: [
                        ["type", "anyof", "InvAdjst"],
                        "AND", ["mainline", "is", "F"],
                        "AND", ["custbody_inboundshipmentlink", "anyof", inboundInternalId]
                    ],
                    columns: [
                        search.createColumn({
                            name: "item",
                            summary: "GROUP",
                            label: "Item"
                        }),
                        search.createColumn({
                            name: "quantity",
                            summary: "SUM",
                            label: "Quantity"
                        }),
                        search.createColumn({
                            name: "upccode",
                            join: "item",
                            summary: "GROUP",
                            label: "UPC Code"
                        })
                    ]
                }).run().each(function (result) {

                    var itemInternalId = result.getValue({
                        name: "item",
                        summary: "GROUP",
                        label: "Item"
                    });

                    var lineQuantity = parseFloat(result.getValue({
                        name: "quantity",
                        summary: "SUM",
                        label: "Quantity"
                    }) || '0');

                    if (itemPrimaryUnitsMap[itemInternalId]) {
                        var itemPrimaryUnit = Number(itemPrimaryUnitsMap[itemInternalId]).toFixed(2);
                        lineQuantity = Number(lineQuantity / itemPrimaryUnit).toFixed(2);
                    }

                    // If not found in existing, prepare as new IA item

                    var newItem = {
                        itemName: result.getText({
                            name: "item",
                            summary: "GROUP",
                            label: "Item"
                        }) || '',

                        itemId: itemInternalId || '',
                        upcCode: result.getValue({
                            name: "upccode",
                            join: "item",
                            summary: "GROUP",
                            label: "UPC Code"
                        }) || '',

                        purchaseOrder: 'INV ADJ',
                        poId: '',
                        vendorName: '',
                        actualShippingDate: '',
                        reference: key || '',
                        quantityExpected: '',
                        quantityReceived: Number(lineQuantity),
                        quantityRemaining: '',
                        unit: "Each",
                        uniqueId: (key || '') + "_" +
                            vesselNumber + "_" +
                            (result.getText({
                                name: "item",
                                summary: "GROUP",
                                label: "Item"
                            }) || '') + "_0"
                    };

                    recordData[key].itemDetails.push(newItem);
                    // log.error("Added new IA item", JSON.stringify(newItem));


                    return true;
                });

                //  Update total line count
                totalCount = recordData[key].totalLineCount = recordData[key].itemDetails.length;

                //     log.error("Final itemDetails length", recordData[key].itemDetails.length);

            });

            // Add line count
            Object.keys(recordData).forEach(function (key) {
                recordData[key].totalLineCount = recordData[key].itemDetails.length;
            });

            var ScriptEndTime = new Date().getTime();
           // log.error('Total Execution Time', ((ScriptEndTime - ScriptStartTime) / 1000) + ' seconds');
            // log.audit('Final recordData', JSON.stringify(recordData));

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
                data: recordData
            };

        } catch (e) {
            log.error("error message", e.message);
            return {
                status: 500,
                message: e.message
            };
        }
    }

    function getUOMMapByUnitType() {
        var uomMap = {};
        try {
            var uomSearch = search.create({
                type: 'unitstype',
                filters: [],
                columns: [
                    search.createColumn({ name: 'unitname' }),
                    search.createColumn({ name: 'conversionrate' })
                ]
            });

            uomSearch.run().each(function (res) {
                var unit = res.getValue({ name: 'unitname' });
                var rate = res.getValue({ name: 'conversionrate' });
                uomMap[unit] = {
                    "unit": unit,
                    "rate": rate
                };
                return true;
            });

        } catch (e) {
            log.error('Error in getUOMMapByUnitType', e);
        }
        // log.error("uomMap Function",uomMap);
        return uomMap;
    }

    function itemDataPurchaseUnit() {
        try {
            var itemDataPurchaseUnit = {};

            // Build UOM conversion map for ALL unit types
            var conversionMap = getUOMMapByUnitType();

            var itemSearch = search.create({
                type: search.Type.ITEM,
                filters: [
                    ["type", "anyof", "InvtPart"],
                    "AND",
                    ["purchaseunit", "noneof", "5"] // exclude Each (ID=5, adjust if neede
                ],
                columns: [
                    'internalid',
                    'purchaseunit'
                ]
            });

            var itemResultSet = itemSearch.run();
            var start = 0;
            var pageSize = 1000;

            do {
                var itemResults = itemResultSet.getRange({
                    start: start,
                    end: start + pageSize
                });

                if (!itemResults || itemResults.length === 0) break;

                for (var i = 0; i < itemResults.length; i++) {
                    var itemId = itemResults[i].getValue('internalid');
                    var purchaseunit = itemResults[i].getText('purchaseunit');
                    // Map item → conversion rate
                    itemDataPurchaseUnit[itemId] = conversionMap[purchaseunit];
                    //   itemDataStockUnit[itemId] = stockUnit || 1;
                }

                start += pageSize;
            } while (true);

            //  log.error('ItemConversionMap345', itemDataStockUnit);
            return itemDataPurchaseUnit;

        } catch (e) {
            log.error("Error in itemPrimaryUnits", e.message);
            throw e;
        }
    }

    function itemPrimaryUnits() {
        try {
            var itemDataStockUnit = {};

            // Build UOM conversion map for ALL unit types
            var conversionMap = getUOMMapByUnitType();

            var itemSearch = search.create({
                type: search.Type.ITEM,
                filters: [
                    ["type", "anyof", "InvtPart"],
                    "AND",
                    ["stockunit", "noneof", "5"] // exclude Each (ID=5, adjust if needed)
                ],
                columns: [
                    'internalid',
                    'stockunit'
                ]
            });

            var itemResultSet = itemSearch.run();
            var start = 0;
            var pageSize = 1000;

            do {
                var itemResults = itemResultSet.getRange({
                    start: start,
                    end: start + pageSize
                });

                if (!itemResults || itemResults.length === 0) break;

                for (var i = 0; i < itemResults.length; i++) {
                    var itemId = itemResults[i].getValue('internalid');
                    var stockUnit = itemResults[i].getText('stockunit');
                    // Map item → conversion rate
                    itemDataStockUnit[itemId] = conversionMap[stockUnit];
                    //   itemDataStockUnit[itemId] = stockUnit || 1;
                }

                start += pageSize;
            } while (true);

            //  log.error('ItemConversionMap345', itemDataStockUnit);
            return itemDataStockUnit;

        } catch (e) {
            log.error("Error in itemPrimaryUnits", e.message);
            throw e;
        }
    }

    function createItemReceipt(context) {
        return {
            success: true
        }
    }

    function toSnakeCase(str) {
        return str
            .trim()
            .replace(/[^a-zA-Z0-9 ]/g, '')
            .replace(/\s+/g, '_')
            .toLowerCase();
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
            var headerSearch = search.load({ id: SalesOrderHeaderId });
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

            var itemfilters = itemSearch.filters || [];


            if (headerIds) {

                try {

                    itemfilters.push(search.createFilter({

                        name: 'internalid',

                        operator: search.Operator.ANYOF,

                        values: headerIds

                    }));


                } catch (e) {

                    log.error("error pushing item filters");

                    var response = e.message + " - " + itemIds;

                }

            }

            itemSearch.filters = itemfilters;

            if (filters.length > 0) {
                itemSearch.filters = (itemSearch.filters || []).concat(filters);
            }

            var cartonsIds = {}; // carton counter per internalID
            // var itemSearchResult = itemSearch.run();
            // var itemSearchRange = itemSearchResult.getRange({ start: startIndex, end: startIndex + pageSize });

            // Helper: safe parse int
            function safeInt(v, fallback) {
                var n = parseInt(v);
                return (isNaN(n) ? (fallback === undefined ? "" : fallback) : n);
            }
            function safeFloat(v, fallback) {
                var n = parseFloat(v);
                return (isNaN(n) ? (fallback === undefined ? "" : fallback) : n);
            }


            var pagedData = itemSearch.runPaged({
                pageSize: 1000
            });

            // Loop all pages
            pagedData.pageRanges.forEach(function (pageRange) {

                var page = pagedData.fetch({ index: pageRange.index });


                page.data.forEach(function (result) {
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
                            baseItemData["so_items"] = parsedSoItemsArr.length;;
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
                    var itemslength = parsedSoItemsArr.length || result.getValue({ name: 'custbody_so_total_qty' });

                    // Get bin rows for this item/result — helper returns an ARRAY (guaranteed)
                    var existBinArr = getBinTransferinfo(result, itemPrimaryUnitsMap); // always array
                    //  log.error("existBinArr", existBinArr);

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
                            var carton = num + " of " + (itemslength || result.getValue({ name: 'custbody_so_total_qty' }));
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
                        itemData["quantity"] = safeInt(binObj.quantity, "") || convertedLineQuantity; // quantity to pick from this bin (number or "")
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
                });

            });


            // end itemSearchRange.forEach
            // Remove internal _addedKeys before returning JSON

            Object.keys(headerData).forEach(function (id) {
                if (headerData[id]._addedKeys) {
                    delete headerData[id]._addedKeys;
                }
            });


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

    function getDropShipOrders(context, pageSize, startIndex) {
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
            // amazon dropship orders
            var headerSearch = search.load({ id: 4797 });

            // non amazon dropship orders
            //    var headerSearch = search.load({ id: 4831 });

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
            // amazon dropship orders
            var itemSearch = search.load({ id: 4798 });

            // non amazon dropship orders
            //    var itemSearch = search.load({ id: 4830 });

            var itemfilters = itemSearch.filters || [];


            if (headerIds) {

                try {

                    itemfilters.push(search.createFilter({

                        name: 'internalid',

                        operator: search.Operator.ANYOF,

                        values: headerIds

                    }));


                } catch (e) {

                    log.error("error pushing item filters");

                    var response = e.message + " - " + itemIds;

                }

            }

            itemSearch.filters = itemfilters;

            if (filters.length > 0) {
                itemSearch.filters = (itemSearch.filters || []).concat(filters);
            }

            var cartonsIds = {}; // carton counter per internalID
            // var itemSearchResult = itemSearch.run();
            // var itemSearchRange = itemSearchResult.getRange({ start: startIndex, end: startIndex + pageSize });

            // Helper: safe parse int
            function safeInt(v, fallback) {
                var n = parseInt(v);
                return (isNaN(n) ? (fallback === undefined ? "" : fallback) : n);
            }
            function safeFloat(v, fallback) {
                var n = parseFloat(v);
                return (isNaN(n) ? (fallback === undefined ? "" : fallback) : n);
            }


            var pagedData = itemSearch.runPaged({
                pageSize: 1000
            });

            // Loop all pages
            pagedData.pageRanges.forEach(function (pageRange) {

                var page = pagedData.fetch({ index: pageRange.index });


                page.data.forEach(function (result) {
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
                            baseItemData["so_items"] = parsedSoItemsArr.length;;
                        } else if (columnName === "unique_id") {
                            unique_id_val = valueText || "";
                            // do not write to baseItemData.unique_id here — the final unique_id will be appended with binIndex later
                            baseItemData["unique_id"] = valueText || "";
                        }
                        else if (columnName == "ship_via") {
                            baseItemData["shipMethodText"] = (result.getText(column) || result.getValue(column));
                            baseItemData["shipMethodValue"] = (result.getValue(column) || result.getText(column));
                        }
                        else {
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
                    var existBinArr = getBinTransferinfo(result, itemPrimaryUnitsMap); // always array
                   // log.error("existBinArr", existBinArr);

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

                        // Default customer_url if empty
                        var DEFAULT_CUSTOMER_URL =
                            "https://4809897.app.netsuite.com/core/media/media.nl?id=1448&c=4809897&h=e82baf9136edcc808c8a";

                        if (!itemData.customer_url || itemData.customer_url === "") {
                            itemData.customer_url = DEFAULT_CUSTOMER_URL;
                        }

                        // Set unique_id to include bin index so it stays unique per bin if base had unique_id
                        var uniqueIdToSet = (unique_id_val ? unique_id_val + "_" + (binObj.binIndex || (b + 1)) : (item_internalid + "_" + (binObj.binIndex || (b + 1))));
                        itemData["unique_id"] = uniqueIdToSet;

                        // Bin-specific fields (guaranteed keys with empty fallback)
                        itemData["cartonInfo"] = cartonInfo;
                        itemData["quantity"] = safeInt(binObj.quantity, "") || convertedLineQuantity; // quantity to pick from this bin (number or "")
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
                });

            });


            // end itemSearchRange.forEach
            // Remove internal _addedKeys before returning JSON

            Object.keys(headerData).forEach(function (id) {
                if (headerData[id]._addedKeys) {
                    delete headerData[id]._addedKeys;
                }
            });


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
            log.error("Error in getDropshipsOrders function", e);
            return {
                status: 500,
                message: e.message
            };
        }
    }

    function getNonAmazonDropShipOrders(context, pageSize, startIndex) {
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
            //  var headerSearch = search.load({ id: 4797 });

            // non amazon dropship orders
            var headerSearch = search.load({ id: 4831 });

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
            //  var itemSearch = search.load({ id: 4798 });

            // non amazon dropship orders
            var itemSearch = search.load({ id: 4830 });

            var itemfilters = itemSearch.filters || [];


            if (headerIds) {

                try {

                    itemfilters.push(search.createFilter({

                        name: 'internalid',

                        operator: search.Operator.ANYOF,

                        values: headerIds

                    }));


                } catch (e) {

                    log.error("error pushing item filters");

                    var response = e.message + " - " + itemIds;

                }

            }

            itemSearch.filters = itemfilters;

            if (filters.length > 0) {
                itemSearch.filters = (itemSearch.filters || []).concat(filters);
            }

            var cartonsIds = {}; // carton counter per internalID
            // var itemSearchResult = itemSearch.run();
            // var itemSearchRange = itemSearchResult.getRange({ start: startIndex, end: startIndex + pageSize });

            // Helper: safe parse int
            function safeInt(v, fallback) {
                var n = parseInt(v);
                return (isNaN(n) ? (fallback === undefined ? "" : fallback) : n);
            }
            function safeFloat(v, fallback) {
                var n = parseFloat(v);
                return (isNaN(n) ? (fallback === undefined ? "" : fallback) : n);
            }


            var pagedData = itemSearch.runPaged({
                pageSize: 1000
            });

            // Loop all pages
            pagedData.pageRanges.forEach(function (pageRange) {

                var page = pagedData.fetch({ index: pageRange.index });


                page.data.forEach(function (result) {
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
                            baseItemData["so_items"] = parsedSoItemsArr.length;;
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
                    var existBinArr = getBinTransferinfo(result, itemPrimaryUnitsMap); // always array
                   // log.error("existBinArr", existBinArr);

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
                        itemData["quantity"] = safeInt(binObj.quantity, "") || convertedLineQuantity; // quantity to pick from this bin (number or "")
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
                });

            });


            // end itemSearchRange.forEach
            // Remove internal _addedKeys before returning JSON

            Object.keys(headerData).forEach(function (id) {
                if (headerData[id]._addedKeys) {
                    delete headerData[id]._addedKeys;
                }
            });


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
            log.error("Error in getDropshipsOrders function", e);
            return {
                status: 500,
                message: e.message
            };
        }
    }
    function dropShipmentData(requestBody) {

        try {

            log.error("Incoming JSON", JSON.stringify(requestBody));

            // Your requestBody is a single object, not an array
            var data = requestBody;

            var action = data.action || "";
            log.error("Action", action);

            var user = data.user || "";
            var shipMethod = data.ship_method || "";
            var trailerId = data.trailer_id || "";
            var arrivalDate = data.date_of_arrival || "";
            var shipmentConfirmId = data.shipment_confirm_id || "";
            var trackingNumbers = Array.isArray(data.tracking_numbers) ? data.tracking_numbers : [];

            log.error("Processing Shipment", {
                user: user,
                shipMethod: shipMethod,
                trailerId: trailerId,
                arrivalDate: arrivalDate
            });


            var headerRec = record.create({
                type: "customrecord_jyswms_dropship_orders",
                isDynamic: true
            });

            headerRec.setValue("custrecord_jyswms_user", user);
            headerRec.setValue("custrecord_jyswms_ship_method", shipMethod);
            headerRec.setValue("custrecord_jyswms_trailer_id", trailerId);

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
            headerRec.setValue("custrecord_jyswms_shipment_confirm_id", shipmentConfirmId);

            // Save complete incoming JSON
            headerRec.setValue("custrecord_jyswms_json", JSON.stringify(data));


            for (var i = 0; i < trackingNumbers.length; i++) {

                var tr = trackingNumbers[i];
                log.error("Tracking Row", tr);

                headerRec.selectNewLine({
                    sublistId: "recmachcustrecord_jyswms_header_id"
                });

                headerRec.setCurrentSublistValue({
                    sublistId: "recmachcustrecord_jyswms_header_id",
                    fieldId: "custrecord_jyswms_tracking_number",
                    value: tr.tracking_number
                });

                headerRec.setCurrentSublistValue({
                    sublistId: "recmachcustrecord_jyswms_header_id",
                    fieldId: "custrecord_jyswms_track_status",
                    value: tr.valid
                });

                headerRec.commitLine({
                    sublistId: "recmachcustrecord_jyswms_header_id"
                });
            }

            log.error("Before DropShip Header Save", {
                user: user,
                shipMethod: shipMethod,
                trailerId: trailerId,
                arrivalDate: arrivalDate,
                shipmentConfirmId: shipmentConfirmId,
                trackingCount: trackingNumbers.length
            });

            var savedId = headerRec.save();
            log.error("Saved DropShip Header", savedId);

            return {
                status: "success",
                message: "Drop Ship Record Saved Successfully",
                internalId: savedId
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



    // Cleaned / unchanged helper — returns ARRAY of bin rows (guaranteed)
    function getBinTransferinfo(result, itemPrimaryUnitsMap) {
        try {
            var lineUniqueId = result.getValue({ name: 'lineuniquekey' });
            var binTransferInternalId = result.getValue({ name: 'custcol_line_level_bin_tranfer_ref' });
            var binData = result.getValue({ name: 'custcol_bin_transfer_details' });
            var itemId = result.getValue({ name: 'item' });
            var quantity = parseFloat(result.getValue({ name: 'quantity' })) || 0;
            var itemPrimaryUnitsMap = itemPrimaryUnitsMap;
            // Primary Unit Conversion applied once to lineQuantityRaw
            var convertedLineQuantity = quantity;

            if (itemPrimaryUnitsMap && itemPrimaryUnitsMap[itemId]) {
                var itemObj = itemPrimaryUnitsMap[itemId];
                var rate = parseInt(itemObj?.rate || 1);
                if (rate > 0) convertedLineQuantity = Math.floor(convertedLineQuantity / rate);
            }

            var btQuantity = 0;
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
                btQuantity += parseFloat(qty) || 0;
                if (!binId || !qty) continue;

                rows.push({
                    internalId: binTransferInternalId || "",
                    binId: safeParseInt(binId),
                    binNumber: result.getText("custbodycustbody_item_bin") || "",
                    relatedSalesOrder: soId || "",
                    item: itemId || "",
                    quantity: safeParseFloat(qty),
                    binIndex: ""
                });
            }

            if (btQuantity < convertedLineQuantity) {

                var variableQty = convertedLineQuantity - btQuantity;

                rows.push({
                    internalId: "",
                    binId: "",
                    binNumber: "",
                    relatedSalesOrder: soId || "",
                    item: itemId || "",
                    quantity: parseFloat(variableQty) || "",
                    binIndex: ""
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
            log.error("ERR_gTransferinfo", e);
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



    return {
        getOrders: getOrders,
        dropShipmentData: dropShipmentData,
        getDropShipOrders: getDropShipOrders,
        getNonAmazonDropShipOrders: getNonAmazonDropShipOrders,
        getOrdersDUP: getOrdersDUP,
        getOrdersOptimized: getOrdersOptimized,
        getInboundRecords: getInboundRecords,
        transformInboundShipmentToItemReceipt: transformInboundShipmentToItemReceipt,
        getLTLOrders: getLTLOrders,
        getDropShipOrdersPerOrder: getDropShipOrdersPerOrder,
        getUnpicked: getUnpicked,
        processPalletUpdate: processPalletUpdate,
        createImageFile: createImageFile
    };
});