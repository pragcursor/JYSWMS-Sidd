/**
 * @NApiVersion 2.x
 * @NScriptType MapReduceScript
 */
define(['N/runtime', 'N/record', 'N/log'], function (runtime, record, log) {

    function getInputData() {
        var script = runtime.getCurrentScript();
        var soIdsParam = script.getParameter({
            name: 'custscript_so_ids'
        });

        if (!soIdsParam) {
            return [];
        }

        return JSON.parse(soIdsParam);
    }

    function map(context) {
        var soId = JSON.parse(context.value);

        try {

            var soRec = record.load({
                type: record.Type.SALES_ORDER,
                id: Number(soId),
                isDynamic: false
            });

            soRec.save({
                enableSourcing: false,
                ignoreMandatoryFields: true
            });

            log.debug('Processed SO', soId);

        } catch (e) {
            log.error('Error Processing SO ' + soId, e);
        }
    }

    function summarize(summary) {

        log.audit('Map/Reduce Completed',
            'Total Usage: ' + summary.usage +
            ' | Concurrency: ' + summary.concurrency +
            ' | Yields: ' + summary.yields
        );

        summary.mapSummary.errors.iterator().each(function (key, error) {
            log.error('Map Error for key: ' + key, error);
            return true;
        });
    }

    return {
        getInputData: getInputData,
        map: map,
        summarize: summarize
    };

});