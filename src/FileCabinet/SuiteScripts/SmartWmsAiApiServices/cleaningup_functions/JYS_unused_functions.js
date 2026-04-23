/**
 * @NApiVersion 2.1
 * @NModuleScope Public
 */

define(['N/record', 'N/search', 'N/log', 'N/runtime'], function (record, search, log, runtime) {
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
});