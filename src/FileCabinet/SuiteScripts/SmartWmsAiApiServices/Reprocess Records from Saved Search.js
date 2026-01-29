/**
 * @NApiVersion 2.x
 * @NScriptType ScheduledScript
 */
define(['N/search', 'N/record', 'N/log'], function (search, record, log) {

    function execute(context) {
        try {

            var SEARCH_ID = 4841;

            // Load saved search
            var searchObj = search.load({
                id: SEARCH_ID
            });

            var pagedData = searchObj.runPaged({
                pageSize: 1000
            });

            pagedData.pageRanges.forEach(function (pageRange) {

                var page = pagedData.fetch({
                    index: pageRange.index
                });

                page.data.forEach(function (result) {
                    try {

                        var recId = result.id;
                        var recType = result.recordType;

                        /* -------------------------
                           FIRST LOAD & SUBMIT
                        --------------------------*/
                        var rec1 = record.load({
                            type: recType,
                            id: recId,
                            isDynamic: true
                        });
rec1.setValue({
    fieldId: 'custrecord_jyswmws_perform_update',
    value: false
});

                      custrecord_jyswmws_perform_update

                        rec1.save({
                            enableSourcing: true,
                            ignoreMandatoryFields: true
                        });

                        log.debug('First Submit Done', recType + ' : ' + recId);

                        // /* -------------------------
                        //    SECOND LOAD & SUBMIT
                        // --------------------------*/
                        // var rec2 = record.load({
                        //     type: recType,
                        //     id: recId,
                        //     isDynamic: true

                      
                        // });

                        // rec2.save({
                        //     enableSourcing: true,
                        //     ignoreMandatoryFields: true
                        // });

                        // log.debug('Second Submit Done', recType + ' : ' + recId);

                    } catch (recErr) {
                        log.error('Record Processing Failed - ID ' + result.id, recErr);
                    }
                });
            });

        } catch (e) {
            log.error('Scheduled Script Failed', e);
        }
    }

    return {
        execute: execute
    };
});
