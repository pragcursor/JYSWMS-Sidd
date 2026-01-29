/**
 * @NApiVersion 2.x
 * @NModuleScope Public
 */
define(['N/record', 'N/search', 'N/log', 'N/runtime'], function (record, search, log, runtime) {

      function getLocations(context, pageSize, startIndex) {
        try {
            var scriptObj = runtime.getCurrentScript();
            var LocationSearchId = scriptObj.getParameter({ name: 'custscript_wms_ai_location_search' });
            //log.debug('Location Parameter', LocationSearchId);
            var Data = {};

            var LocationSearch = search.load({ id: LocationSearchId });

            // var hasInternalId = LocationSearch.columns.some(function(col) {
            //        return col.name === 'internalid';
            //        });

            //   // If not, push it into the columns
            //    if (!hasInternalId) {
            //      LocationSearch.columns.push(search.createColumn({ name: 'internalid' }));
            //       }

            // Get total count using runPaged().count
            var totalCount = LocationSearch.runPaged().count;
            var totalPages = Math.ceil(totalCount / pageSize);

            // Apply pagination
            var searchResult = LocationSearch.run();
            var searchRange = searchResult.getRange({ start: startIndex, end: startIndex + pageSize });

            searchRange.forEach(function (result) {

                log.debug("location search", JSON.stringify(result));

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

    function toSnakeCase(str) {
        return str
            .trim()
            .replace(/[^a-zA-Z0-9 ]/g, '')
            .replace(/\s+/g, '_')
            .toLowerCase();
    }
    return {
        getLocations: getLocations
    };
});
