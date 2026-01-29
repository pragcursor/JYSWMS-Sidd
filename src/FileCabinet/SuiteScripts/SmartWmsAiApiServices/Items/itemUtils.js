/**
 * @NApiVersion 2.x
 * @NModuleScope Public
 */
define(['N/record', 'N/search', 'N/log', 'N/runtime'], function (record, search, log, runtime) {

    function getItems(context, pageSize, startIndex) {
        try {

            var scriptObj = runtime.getCurrentScript();

            var ItemDataSearchId = scriptObj.getParameter({ name: 'custscript_wms_ai_item_search' });
            var Data = {};

            var ItemSearch = search.load({ id: ItemDataSearchId });

            var hasInternalId = ItemSearch.columns.some(function (col) {
                return col.name === 'internalid';
            });

            // If not, push it into the columns
            if (!hasInternalId) {
                ItemSearch.columns.push(search.createColumn({ name: 'internalid' }));
            }

            // Get total count using runPaged().count
            var totalCount = ItemSearch.runPaged().count;
            var totalPages = Math.ceil(totalCount / pageSize);

            // Apply pagination
            var searchResult = ItemSearch.run();
            var searchRange = searchResult.getRange({ start: startIndex, end: startIndex + pageSize });

            searchRange.forEach(function (result) {

                var internalId = result.id;
                var recordData = {};

                result.columns.forEach(function (column) {
                    var columnName = toSnakeCase(column.label || column.name);
                    recordData[columnName] = result.getText(column) || result.getValue(column);
                });
                Data[internalId] = recordData;
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
    
    
   function getAllScapperIds(context, pageSize, startIndex) {
        try {
           

            var scriptObj = runtime.getCurrentScript();

            var ItemDataSearchId = "4588"; //scriptObj.getParameter({ name: 'custscript_wms_ai_item_search' });
            
            var Data = {};

            var ItemSearch = search.load({ id: ItemDataSearchId});

            var hasInternalId = ItemSearch.columns.some(function (col) {
                return col.name === 'internalid';
            });

            // If not, push it into the columns
            if (!hasInternalId) {
                ItemSearch.columns.push(search.createColumn({ name: 'internalid' }));
            }

            // Get total count using runPaged().count
            var totalCount = ItemSearch.runPaged().count;
            var totalPages = Math.ceil(totalCount / pageSize);

            // Apply pagination
            var searchResult = ItemSearch.run();
            var searchRange = searchResult.getRange({ start: startIndex, end: startIndex + pageSize });

            searchRange.forEach(function (result) {

                // log.debug("search reuslt", JSON.stringify(result));

                var internalId = result.id;
                var recordData = {};

                result.columns.forEach(function (column) {
                    var columnName = toSnakeCase(column.label || column.name);
                    recordData[columnName] = result.getText(column) || result.getValue(column);
                });
                Data[internalId] = recordData;
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
                data: Data
            };

        } catch (e) {
            // log.error("error message", e.message);


            return {
                status: 500,
                message: e.message
            };
        }
    }

    function getScapperIds(context, pageSize, startIndex) {
        try {
            var ScriptStartTime = new Date().getTime();
            // log.debug('Script Started', 'Start Time: ' + ScriptStartTime / 1000 + ' seconds');

            var scriptObj = runtime.getCurrentScript();

            var ItemDataSearchId = scriptObj.getParameter({ name: 'custscript_wms_ai_scapper_id_search' });
            // log.debug('Item Parameter', ItemDataSearchId);
            var Data = {};

            var ItemSearch = search.load({ id: ItemDataSearchId });

            var hasInternalId = ItemSearch.columns.some(function (col) {
                return col.name === 'internalid';
            });

            // If not, push it into the columns
            if (!hasInternalId) {
                ItemSearch.columns.push(search.createColumn({ name: 'internalid' }));
            }

            // Get total count using runPaged().count
            var totalCount = ItemSearch.runPaged().count;
            var totalPages = Math.ceil(totalCount / pageSize);

            // Apply pagination
            var searchResult = ItemSearch.run();
            var searchRange = searchResult.getRange({ start: startIndex, end: startIndex + pageSize });

            searchRange.forEach(function (result) {

                // log.debug("search reuslt", JSON.stringify(result));

                var internalId = result.getValue({
         name: "internalid",
         summary: "GROUP",
         label: "Internal ID"
      });
                

                // result.columns.forEach(function (column) {
                //     var columnName = toSnakeCase(column.label || column.name);
                //     recordData[columnName] = result.getText(column) || result.getValue(column);
                // });

           var recordData = {
    internal_id: safeValue(result, { name: "internalid", summary: "GROUP" }),
    name: safeValue(result, { name: "itemid", summary: "GROUP" }),
    home_depot_id: safeValue(result, { name: "custitem_home_depot_sp_id", summary: "GROUP" }),
    amazondrop_ship_id: safeValue(result, { name: "custitem129", summary: "GROUP" }),
    target_marketplace_special_id: safeValue(result, { name: "custitem171", summary: "GROUP" }),
    targetcom_id: safeValue(result, { name: "custitem136", summary: "GROUP" }),
    lowes_special_id: safeValue(result, { name: "custitem169", summary: "GROUP" }),
    l41_inventory_on_hand: safeValue(result, { name: "custitem_l41_inventory_on_hand", summary: "GROUP" }),
    l60_inventory_on_hand: safeValue(result, { name: "custitem_l60_inventory_on_hand", summary: "GROUP" }),
    jakes_list: safeValue(result, { name: "custitem_jakes_list", summary: "GROUP" }) === 'T',
    discontinue: safeValue(result, { name: "custitem54", summary: "GROUP" }) === 'T',
    future_discontinue_item: safeValue(result, { name: "custitem191", summary: "GROUP" }) === 'T',
    brand_name: safeText(result, { name: "custitem188", summary: "GROUP" }),
    class_no_hierarchy: safeText(result, { name: "classnohierarchy", summary: "GROUP" }),
    approximate_rug_size: safeText(result, { name: "custitem156", summary: "GROUP" }),
    collection_name: safeText(result, { name: "custitem154", summary: "GROUP" }),
    box_length_in: safeValue(result, { name: "custitem52", summary: "GROUP" }),
    box_height_in: safeValue(result, { name: "custitem53", summary: "GROUP" }),
    box_width_in: safeValue(result, { name: "custitem51", summary: "GROUP" }),
    weight: safeValue(result, { name: "weight", summary: "GROUP" }),
    dimensional_weight: safeValue(result, { name: "custitem_dimensional_weight", summary: "GROUP" }),
    rounded_girth: safeValue(result, { name: "custitem_wms_balloon_field", summary: "GROUP" }),
    mnp: safeValue(result, { name: "formulanumeric", summary: "SUM" })
};

              
                Data[internalId] = recordData;
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
                data: Data
            };

        } catch (e) {
            // log.error("error message", e.message);


            return {
                status: 500,
                message: e.message
            };
        }
    }

 function safeValue(result, options) {
    var val = result.getValue(options);
    return (val === null || val === undefined || val === 'None' || val === '- None -') ? '' : val;
}

function safeText(result, options) {
    var val = result.getText(options);
    return (val === null || val === undefined || val === 'None' || val === '- None -') ? '' : val;
}

    function getFedExEstimatedCost(context, pageSize, startIndex) {
        try {
            var ScriptStartTime = new Date().getTime();
            // log.debug('Script Started', 'Start Time: ' + ScriptStartTime / 1000 + ' seconds');

            var scriptObj = runtime.getCurrentScript();

            var ItemDataSearchId = scriptObj.getParameter({ name: 'custscript_jyswms_fedex_items' });
            // log.debug('Item Parameter', ItemDataSearchId);
            var Data = {};

            var ItemSearch = search.load({ id: ItemDataSearchId });

            var hasInternalId = ItemSearch.columns.some(function (col) {
                return col.name === 'internalid';
            });

            // If not, push it into the columns
            if (!hasInternalId) {
                ItemSearch.columns.push(search.createColumn({ name: 'internalid' }));
            }

            // Get total count using runPaged().count
            var totalCount = ItemSearch.runPaged().count;
            var totalPages = Math.ceil(totalCount / pageSize);

            // Apply pagination
            var searchResult = ItemSearch.run();
            var searchRange = searchResult.getRange({ start: startIndex, end: startIndex + pageSize });

            searchRange.forEach(function (result) {

                // log.debug("search reuslt", JSON.stringify(result));

                var internalId = result.id;
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
            // log.error("error message", e.message);


            return {
                status: 500,
                message: e.message
            };
        }
    }

function getItemSalesPerCustomer(context, pageSize, startIndex) {
    try {

        function formatToday() {
            var d = new Date();
            return (d.getMonth() + 1) + "/" + d.getDate() + "/" + d.getFullYear();
        }
        var todayDate = formatToday();

        pageSize = parseInt(pageSize) || 1000;
        startIndex = parseInt(startIndex) || 0;

        // Load saved search
        var ItemSearch = search.load({ id: 4773 });

        var cols = ItemSearch.columns;   // <== IMPORTANT
        var paged = ItemSearch.runPaged({ pageSize: pageSize });

        var totalCount = paged.count;
        var totalPages = Math.ceil(totalCount / pageSize);
        var pageIndex = Math.floor(startIndex / pageSize);

        if (pageIndex >= totalPages) pageIndex = totalPages - 1;
        if (pageIndex < 0) pageIndex = 0;

        var Data = [];

        if (totalCount > 0) {
            var page = paged.fetch({ index: pageIndex });

            page.data.forEach(function (r) {

                var obj = {
                    item: r.getText(cols[0]) || r.getValue(cols[0]),
                    amazon_1yz: Number(r.getValue(cols[1])) || 0,
                    amazon_dropship: Number(r.getValue(cols[2])) || 0,
                    target_marketplace: Number(r.getValue(cols[3])) || 0,
                    wayfair: Number(r.getValue(cols[4])) || 0,
                    home_depoit: Number(r.getValue(cols[5])) || 0,
                    lowes: Number(r.getValue(cols[6])) || 0,
                    date: todayDate
                };

                Data.push(obj);
            });
        }

        var endIndex = Math.min(startIndex + pageSize - 1, totalCount - 1);

        return {
            status: 200,
            message: "Data retrieved successfully",
            date: todayDate,
            summary: {
                total_records: totalCount,
                total_pages: totalPages,
                records_per_page: pageSize,
                current_page: pageIndex + 1,
                pagination_info: {
                    start_index: startIndex,
                    end_index: endIndex,
                    has_next_page: (startIndex + pageSize) < totalCount,
                    has_previous_page: startIndex > 0
                }
            },
            data: Data
        };

    } catch (e) {
        return {
            status: 500,
            message: e.message,
            date: formatToday()
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
      getItems: getItems,
      getItemSalesPerCustomer: getItemSalesPerCustomer,
      getScapperIds:getScapperIds,
      getAllScapperIds:getAllScapperIds,
      getFedExEstimatedCost: getFedExEstimatedCost
    };
});
