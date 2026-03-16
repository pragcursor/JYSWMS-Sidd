/**
 * @NApiVersion 2.x
 * @NScriptType Suitelet
 */
define(['N/record', 'N/log'], function (record, log) {

    function onRequest(context) {
        try {

            var request = context.request;
            var response = context.response;

            // Accept itemId parameter
            var itemId = request.parameters.itemId;

            if (!itemId) {
                response.write(JSON.stringify({
                    status: 400,
                    message: "itemId parameter is required"
                }));
                return;
            }

            // Load Item Record
            var itemRec = record.load({
                type: record.Type.INVENTORY_ITEM, // change if needed
                id: itemId
            });

            // Submit Record
            var savedId = itemRec.save({
                enableSourcing: true,
                ignoreMandatoryFields: true
            });

            response.write(JSON.stringify({
                status: 200,
                message: "Item loaded and submitted successfully",
                itemId: savedId
            }));

        } catch (e) {

            log.error("Error", e);

            context.response.write(JSON.stringify({
                status: 500,
                message: e.message
            }));
        }
    }

    return {
        onRequest: onRequest
    };
});