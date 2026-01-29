/**
 * @NApiVersion 2.x
 * @NScriptType UserEventScript
 */
define(['N/record', 'N/search'], function(record, search) {

    function afterSubmit(context) {
        try {

            var newRec = context.newRecord;
            var currentId = newRec.id;
            var currentType = newRec.type;

            // 1. Get the related Sales Order ID
            //var soId = newRec.getValue("custrecord_wms_sales_orders");

          var soId = parseInt(newRec.getValue("custrecord_wms_sales_orders"), 10);


            if (!soId) {
                log.debug("No Sales Order found");
                return;
            }

            // 2. Lookup field from the Sales Order
            var soField = search.lookupFields({
                type: search.Type.SALES_ORDER,
                id: soId,
                columns: ["custbody_jyswms_send_order"]
            });

            var isSendOrder = soField.custbody_jyswms_send_order;

           // log.debug("Send Order Flag", isSendOrder);

            // 3. Check if TRUE
            if (isSendOrder === true || isSendOrder === "T") {

                log.debug("Condition matched. Updating fields...");

                // 4. Update both fields in one submitFields call
                record.submitFields({
                    type: currentType,
                    id: currentId,
                    values: {
                        custrecord_batch_picking_status: "1", // Pending
                        isinactive: true                     // Make Inactive
                    },
                    options: {
                        enableSourcing: false,
                        ignoreMandatoryFields: true
                    }
                });

                log.debug("Record Updated", "Status set to 2 and marked inactive");
            }

        } catch (e) {
            log.error("Error in After Submit", e);
        }
    }

    return {
        afterSubmit: afterSubmit
    };
});
