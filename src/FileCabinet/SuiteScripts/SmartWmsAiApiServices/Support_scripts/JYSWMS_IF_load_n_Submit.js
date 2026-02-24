/**
 * @NApiVersion 2.x
 * @NScriptType MapReduceScript
 */
define([
    'N/search',
    'N/record',
    'N/log'
], function (search, record, log) {

    function getInputData() {
        return search.create({
            type: search.Type.ITEM_FULFILLMENT,
            filters: [
                ['type', 'anyof', 'ItemShip'],
                'AND',
                ['status', 'anyof', 'ItemShip:C'],
                'AND',
                ['trandate', 'onorafter', '2/4/2026'],
                'AND',
                ['customer.custentity_jyswms_enable', 'is', 'T'],
                'AND',
                ['mainline', 'is', 'T'],
                'AND',
                ['createdfrom.status', 'anyof', 'SalesOrd:F', 'SalesOrd:E']
            ],
            columns: [
                search.createColumn({ name: 'internalid' })
            ]
        });
    }

    function map(context) {
        try {
            var result = JSON.parse(context.value);
            var fulfillmentId = result.id;

            log.debug('Processing Item Fulfillment', fulfillmentId);

            var fulfillmentRec = record.load({
                type: record.Type.ITEM_FULFILLMENT,
                id: fulfillmentId,
                isDynamic: false
            });

            // OPTIONAL: make changes here if needed
            // fulfillmentRec.setValue({
            //     fieldId: 'custbody_example_flag',
            //     value: true
            // });

            var save = fulfillmentRec.save({
                enableSourcing: false,
                ignoreMandatoryFields: true
            });
            log.debug('Saved Item Fulfillment', save)
        } catch (e) {
            log.error({
                title: 'Error processing fulfillment ' + context.key,
                details: e
            });
        }
    }

    function summarize(summary) {

        log.audit('Summary', {
            totalKeys: summary.inputSummary ? summary.inputSummary.totalKeys : 0,
            mapErrors: summary.mapSummary.errors.iterator().hasNext()
        });

        summary.mapSummary.errors.iterator().each(function (key, error) {
            log.error({
                title: 'Map error for key: ' + key,
                details: error
            });
            return true;
        });
    }

    return {
        getInputData: getInputData,
        map: map,
        summarize: summarize
    };
});