/**
 * @NApiVersion 2.x
 * @NScriptType MapReduceScript
 */
define(['N/search', 'N/record', 'N/log'], function (search, record, log) {

    function getInputData() {
        var pkgcontent = [];

        var packageSearch = search.create({
            type: "customrecordhj_tc_package_contents",
            filters: [
                ["created", "within", "today"]
            ],
            columns: [
                search.createColumn({ name: "internalid" })
            ]
        });

        packageSearch.run().each(function (result) {
            pkgcontent.push(result.getValue({ name: "internalid" }));
            return true;
        });

        return pkgcontent;
    }

    function map(context) {
        var internalid = context.value;

        try {
            var rec = record.load({
                type: 'customrecordhj_tc_package_contents',
                id: internalid,
                isDynamic: false
            });

            rec.save({
                enableSourcing: false,
                ignoreMandatoryFields: true
            });

            log.debug('Record processed', internalid);

        } catch (e) {
            log.error('Error processing ID ' + internalid, e.message);
        }
    }

    function reduce(context) {
        // intentionally empty
    }

    function summarize(summary) {
        summary.mapSummary.errors.iterator().each(function (key, error) {
            log.error('Map error key: ' + key, error);
            return true;
        });

        log.audit('Summary', 'Script completed');
    }

    return {
        getInputData: getInputData,
        map: map,
        reduce: reduce,
        summarize: summarize
    };
});