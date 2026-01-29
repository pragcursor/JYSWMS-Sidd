/**
 * @NApiVersion 2.x
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 *
 * @FileName UE_Deactivate_Custom_Record.js
 * @ScriptName Deactivate Custom Record on Send Order
 */

define(['N/record', 'N/search', 'N/log'], function (record, search, log) {

    function afterSubmit(context) {
        try {

            if (context.type !== context.UserEventType.CREATE &&
                context.type !== context.UserEventType.EDIT) {
                return;
            }

            var newRec = context.newRecord;
            var recId = newRec.id;
            var recType = newRec.type;

            // 1. Get the Sales Order ID
            var salesOrderId = newRec.getValue('custrecord_sales_order_id');
            if (!salesOrderId) return;

            // 2. Lookup send order flag from Sales Order
            var soLookup = search.lookupFields({
                type: search.Type.SALES_ORDER,
                id: salesOrderId,
                columns: ['custbody_jyswms_send_order']
            });

            var sendOrder = soLookup.custbody_jyswms_send_order;

            // If sendOrder is NOT true → exit script
            if (!(sendOrder === true || sendOrder === 'T')) {
                return;
            }

            // 3. Get Bulk Batch Picking record ID
            var bulkBatchId = newRec.getValue('custrecord_wms_bulkbatch_picking');

            // Skip only if bulkBatchId = 22306500 or empty
            if (bulkBatchId == 22306500) {
                log.debug('Skipping', 'Bulk Batch Picking = 22306500 || default picking batch - '+ newRec.id + " - bulkBatch Id = "+ bulkBatchId);
                return;
            }
         if (bulkBatchId) {
            // 4. Load Bulk Batch Picking record → set inactive + status 1
            var bulkRec = record.load({
                type: 'customrecord_bulk_picking',
                id: bulkBatchId,
                isDynamic: true
            });

            bulkRec.setValue({
                fieldId: 'custrecord_batch_picking_status',
                value: 1
            });

            bulkRec.setValue({
                fieldId: 'isinactive',
                value: true
            });

            bulkRec.save();
            log.audit('Bulk Picking Record Updated', bulkBatchId);
}

            // 5. Mark MAIN record inactive
            record.submitFields({
                type: recType,
                id: recId,
                values: {
                    isinactive: true
                }
            });

            log.audit('Main Record Inactivated', recId);

        } catch (e) {
            log.error('Error in afterSubmit', e);
        }
    }

    return {
        afterSubmit: afterSubmit
    };
});
