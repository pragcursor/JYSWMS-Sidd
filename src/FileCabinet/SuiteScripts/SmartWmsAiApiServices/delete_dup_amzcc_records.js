/**
 * @NApiVersion 2.x
 * @NScriptType ScheduledScript
 */
define(['N/search', 'N/record', 'N/log'], function (search, record, log) {

    function execute(context) {

        var seenAmzccCodes = {};        // Map to track unique AMZCC codes
        var duplicateRecordIds = [];   // Array to store duplicate record IDs

        var amzccSearch = search.create({
            type: 'customrecord_amzcc_custom_rec',
            filters: [
                ["custrecord_sales_order_id.internalidnumber", "equalto", "61532452"],
                "AND",
                ["custrecord_sales_order_id.mainline", "is", "T"]
            ],
            columns: [
                search.createColumn({ name: "internalid" }),
                search.createColumn({ name: "custrecord_amzcc_code" })
            ]
        });

        amzccSearch.run().each(function (result) {

            var recordId = result.getValue({ name: 'internalid' });
            var amzccCode = result.getValue({ name: 'custrecord_amzcc_code' });

            // Skip empty AMZCC codes (optional safety)
            if (!amzccCode) {
                return true;
            }

            if (seenAmzccCodes[amzccCode]) {
                // Duplicate found
                duplicateRecordIds.push(recordId);
            } else {
                // First occurrence
                seenAmzccCodes[amzccCode] = recordId;
            }

            return true;
        });

      //  log.audit('Duplicate AMZCC Records Found', duplicateRecordIds);
     // log.error("duplicateRecordIds",duplicateRecordIds.length);
      // log.debug('Duplicate AMZCC Records Found', duplicateRecordIds);
     // log.debug("duplicateRecordIds",duplicateRecordIds.length);

        // Delete duplicate records
        for (var i = 0; i < duplicateRecordIds.length; i++) {
            try {
                record.delete({
                    type: 'customrecord_amzcc_custom_rec',
                    id: duplicateRecordIds[i]
                });

                log.audit('Deleted Duplicate Record', duplicateRecordIds[i]);

            } catch (e) {
                log.error('Failed to delete record ' + duplicateRecordIds[i], e);
            }
        }
    }

    return {
        execute: execute
    };
});
