/**
 * @NApiVersion 2.x
 * @NScriptType MapReduceScript
 */
define(['N/search', 'N/record', 'N/log'], function(search, record, log) {

    function getInputData() {
        // Load your saved search
        return search.load({
            id: '5073' // change this search id
        });
    }

    function map(context) {
        try {
            var result = JSON.parse(context.value);

            var recId = result.id;
            var recType = "customrecord_wms_bulkpick_lines";

            var cusRec = record.load({
                type: recType,
                id: recId
            });

            cusRec.save();

            log.debug('record got edited', recType + ' : ' + recId);

        } catch (e) {
            log.error('Error editing record', e);
        }
    }

    function summarize(summary) {
        log.audit('Summary', 'Editing Completed');

        summary.mapSummary.errors.iterator().each(function(key, error) {
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