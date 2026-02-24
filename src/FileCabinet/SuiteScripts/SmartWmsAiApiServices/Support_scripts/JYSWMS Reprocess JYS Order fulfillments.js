/**
 *@NApiVersion 2.1
 *@NScriptType MapReduceScript
 */
define(['N/search', 'N/record'], function (search, record) {

    function getInputData() {
        return search.load({
            id: 'customsearch_so_not_fulfilled_jys_errors'
        });
    }

    function map(context) {
        var searchResult = JSON.parse(context.value);
        var salesOrderId = searchResult.id;

        context.write({
            key: salesOrderId,
            value: salesOrderId
        });
    }

    function reduce(context) {
        var salesOrderId = context.key;

        var fulfillmentSearch = search.create({
            type: "customrecord_order_fulfillment_details",
            filters: [
                ["custrecord_jyswms_sales_order_id.internalidnumber", "equalto", salesOrderId],
                "AND",
                ["custrecord_jyswms_sales_order_id.mainline", "is", "T"]
            ],
            columns: ["internalid"]
        });

        fulfillmentSearch.run().each(function (result) {

            var customRecordId = result.getValue("internalid");

            // 🔁 Submit the same record 3 times
            for (var i = 0; i < 3; i++) {

                var rec = record.load({
                    type: "customrecord_order_fulfillment_details",
                    id: customRecordId,
                    isDynamic: false
                });
                var currentApprovalStatus = rec.getValue("custrecord_jyswms_approved");
                if (!currentApprovalStatus) {
                    var approve = rec.setValue({
                        fieldId: "custrecord_jyswms_approved",
                        value: true
                    });
                }

                rec.save({
                    enableSourcing: false,
                    ignoreMandatoryFields: true
                });
            }

            return true;
        });
        log.debug("Processed Sales Order ID: " + salesOrderId);
    }

    function summarize(summary) {
        if (summary.inputSummary.error) {
            log.error("Input Error", summary.inputSummary.error);
        }

        summary.reduceSummary.errors.iterator().each(function (key, error) {
            log.error("Reduce Error for key: " + key, error);
            return true;
        });
    }

    return {
        getInputData: getInputData,
        map: map,
        reduce: reduce,
        summarize: summarize
    };
});