/**
* @NApiVersion 2.x
* @NScriptType ScheduledScript
*/
define(['N/search', 'N/record', 'N/log', 'N/runtime'], function (search, record, log, runtime) {
 
    function execute(context) {
        try {
            log.audit("Process Started", "Deleting records from customrecord_amzcc_custom_rec...");
 
            // Search for all matching records
            var customSearch =  search.create({
   type: "bintransfer",
                 filters:
   [
      ["type","anyof","BinTrnfr"], 
      "AND", 
      ["memo","startswith","NetscoreAmXYZ"], 
      "AND", 
      ["custbody_realted_sales_order.custbody_jyswms_send_order","is","T"], 
      "AND", 
      ["mainline","is","T"], 
      "AND", 
      ["custbody_realted_sales_order.mainline","is","T"]
   ],
   columns:
   [
      search.createColumn({name: "internalid", label: "Internal ID"}),
      search.createColumn({name: "memo", label: "Memo"}),
      search.createColumn({name: "custbody_wms_related_batch_record", label: "Related Batch Record"}),
      search.createColumn({
         name: "internalid",
         join: "CUSTBODY_WMS_RELATED_BATCH_RECORD",
         label: "Internal ID"
      })
   ]
});
 
            var pagedData = customSearch.runPaged({ pageSize: 1000 });
            log.audit("Search Initialized", "Total pages: " + pagedData.pageRanges.length);
 
            pagedData.pageRanges.forEach(function (pageRange) {
                var page = pagedData.fetch({ index: pageRange.index });
 
                page.data.forEach(function (result) {
                    var recId = result.getValue({ name: 'internalid' });
                    var bId = result.getValue({
                        name: 'custbody_wms_related_batch_record'
                    });
                    try {
                        log.debug("Processing Record", "Record ID: " + recId + " | Bulk ID: " + bId);
 
                        if (bId) {
                            // 🔹 Step 1: Update Bulk Picking record
                            record.submitFields({
                                type: 'customrecord_bulk_picking',
                                id: bId,
                                values: {
                                   isinactive: true,
                                   custrecord_batch_picking_status: 1 // Pending
                                }
                            });
 
                            log.debug("Bulk Picking Updated", "Record " + bId + " set to Pending & inactive.");
 
                            // 🔹 Step 2: Reload the record to confirm inactive
                            var bulkRec = record.load({
                                type: 'customrecord_bulk_picking',
                                id: bId
                            });
 
                            var isInactive = bulkRec.getValue({ fieldId: 'isinactive' });
 
                            // 🔹 Step 3: Delete only if inactive = true
                            if (isInactive === true) {
                               record.delete({
    type: record.Type.BIN_TRANSFER, // Use the built-in constant for safety
    id: recId
});
log.audit("Record Deleted", "Bin Transfer Internal ID: " + recId);

                            } else {
                                log.audit("Skipped Deletion", "Record " + recId + " not deleted because bId " + bId + " is still active.");
                            }
                        } else {
                            log.debug("No Related Bulk Picking", "Skipping record ID: " + recId);
                        }
 
                    } catch (e) {
                        log.error("Error Processing Record", "Record ID: " + recId + " | " + e);
                    }
                });
 
                // 🔹 Governance Check
                if (runtime.getCurrentScript().getRemainingUsage() < 200) {
                    var status = runtime.scheduleScript({
                        scriptId: runtime.getCurrentScript().id,
                        deploymentId: runtime.getCurrentScript().deploymentId
                    });
                    log.audit("Rescheduled Script", "Status: " + status);
                    return false;
                }
            });
 
            log.audit("Process Completed", "All matching records processed.");
 
        } catch (err) {
            log.error("Fatal Script Error", err);
        }
    }
 
    return {
        execute: execute
    };
});