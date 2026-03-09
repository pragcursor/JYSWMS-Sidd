/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */

define(['N/search', 'N/log', 'N/file','N/https'], function (search, log, file,https) {

    function getInputData() {
        try {

            return search.load({
                id: 'customsearch_jyswms_priority_saved_searc',
                type: search.Type.SAVED_SEARCH
            });

        } catch (e) {

            log.error({
                title: 'getInputData Error',
                details: e
            });

        }
    }


    function map(context) {
        try {

            var result = JSON.parse(context.value);

            var savedSearchId = result.id;

            log.debug({
                title: 'Saved Search Found',
                details: savedSearchId
            });

            context.write({
                key: savedSearchId,
                value: savedSearchId
            });

        } catch (e) {

            log.error({
                title: 'Map Error',
                details: e
            });

        }
    }


    function reduce(context) {
        try {

            var savedSearchId = context.key;

            log.debug({
                title: 'Processing Saved Search',
                details: savedSearchId
            });

            var loadedSearch = search.load({
                type: 'salesorder',
                id: savedSearchId
            });

            var resultData = [];

            loadedSearch.run().each(function (result) {

                try {

                    var internalId = result.getValue({
                        name: 'internalid'
                    });

                    var priority = result.getValue({
                        name: 'formulanumeric'
                    });

                    var obj = {};
                    obj[internalId] = Number(priority);

                    resultData.push(obj);

                    return true;

                } catch (innerError) {

                    log.error({
                        title: 'Result Processing Error',
                        details: innerError
                    });

                    return true;
                }

            });

            var finalJson = {
                data: resultData
            };

            try {

                var jsonString = JSON.stringify(finalJson);

       /*         var jsonFile = file.create({
                    name: 'ship_priority_data_' + savedSearchId + '_' + new Date().getTime() + '.json',
                    fileType: file.Type.JSON,
                    contents: jsonString,
                    folder: 1745478
                });

                var fileId = jsonFile.save();
*/
              if(jsonString){
                var response = https.post({
                    url: 'https://jy-moment-scheduler-production.up.railway.app/dropship-update-priority',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: jsonString
                });

                log.error({
                    title: 'ship_priority_data_' + savedSearchId + '_' + new Date().getTime() + '.json',
                    details: 'total_rows_updated='+response.body.total_rows_updated+',internal Id :'+ response.body
                });
              }

            } catch (e) {

                log.error({
                    title: 'File Creation Error',
                    details: e
                });

            }

        } catch (e) {

            log.error({
                title: 'Reduce Error',
                details: e
            });

        }
    }


    function summarize(summary) {
        try {

            summary.mapSummary.errors.iterator().each(function (key, error) {

                log.error({
                    title: 'Map Error for key ' + key,
                    details: error
                });

                return true;
            });


            summary.reduceSummary.errors.iterator().each(function (key, error) {

                log.error({
                    title: 'Reduce Error for key ' + key,
                    details: error
                });

                return true;
            });

        } catch (e) {

            log.error({
                title: 'Summarize Error',
                details: e
            });

        }
    }


    return {
        getInputData: getInputData,
        map: map,
        reduce: reduce,
        summarize: summarize
    };

});