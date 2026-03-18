/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/record', 'N/search', 'N/runtime', 'N/log'], 
function (record, search, runtime, log) {

    // =====================================================
    // 🔹 GET INPUT DATA
    // =====================================================
    function getInputData() {
        try {
            var script = runtime.getCurrentScript();
            var payload = script.getParameter({
                name: 'custscript_item_payload'
            });

            if (!payload) {
                log.error("No payload received", "");
                return [];
            }

            var data = JSON.parse(payload);

            log.audit("MR Input Count", data.length);

            return data;

        } catch (e) {
            log.error("Error in getInputData", e);
            return [];
        }
    }

    // =====================================================
    // 🔹 MAP STAGE (1 ITEM PER EXECUTION)
    // =====================================================
    function map(context) {
        try {
            var itemId = JSON.parse(context.value);

            if (!itemId) return;

            var itemRec;

            try {
                // 🔹 FAST PATH (assume inventory item)
                itemRec = record.load({
                    type: record.Type.INVENTORY_ITEM,
                    id: itemId,
                    isDynamic: false
                });

            } catch (loadErr) {
                // 🔁 FALLBACK → detect type
                var lookup = search.lookupFields({
                    type: search.Type.ITEM,
                    id: itemId,
                    columns: ['recordtype']
                });

                var itemType = lookup.recordtype;

                if (!itemType) {
                    log.error("Item type not found", itemId);
                    return;
                }

                itemRec = record.load({
                    type: itemType,
                    id: itemId,
                    isDynamic: false
                });
            }

            // 🔹 SAVE
            itemRec.save({
                enableSourcing: false,
                ignoreMandatoryFields: true
            });

            context.write({
                key: "success",
                value: itemId
            });

        } catch (e) {
            log.error("Map error for item", {
                item: context.value,
                error: e
            });

            context.write({
                key: "failed",
                value: context.value
            });
        }
    }

    // =====================================================
    // 🔹 REDUCE (OPTIONAL - AGGREGATION)
    // =====================================================
    function reduce(context) {
        // Not required for this use case
    }

    // =====================================================
    // 🔹 SUMMARIZE (FINAL LOGGING)
    // =====================================================
    function summarize(summary) {
        try {
            var successCount = 0;
            var failedCount = 0;

            summary.output.iterator().each(function (key, value) {
                if (key === "success") successCount++;
                if (key === "failed") failedCount++;
                return true;
            });

            log.audit("MR Summary", {
                success: successCount,
                failed: failedCount
            });

            // 🔹 Log map errors (important)
            summary.mapSummary.errors.iterator().each(function (key, error) {
                log.error("Map Error for key: " + key, error);
                return true;
            });

        } catch (e) {
            log.error("Error in summarize", e);
        }
    }

    return {
        getInputData: getInputData,
        map: map,
        reduce: reduce,
        summarize: summarize
    };
});