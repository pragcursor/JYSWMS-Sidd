/**
 *@NApiVersion 2.x
 *@NScriptType Suitelet
 */
define([], function() {

    function onRequest(context) {
        // i want to design a suitelet and when user enters internal id then it will check a custom record and if item fulfillment is not created then it should call JYWMS api and create all realted custom records from json and then fulfillment record should be created and linked to the custom record and then it should return success message to user. if item fulfillment is already created then it should return message that fulfillment is already created for this internal id.
        if (context.request.method === 'GET') {
            //design a form to take internal id as input from user
            var form = serverWidget.createForm({
                title: 'Check and Create Item Fulfillment'
            });
            var internalIdField = form.addField({
                id: 'custpage_internal_id',
                type: serverWidget.FieldType.TEXT,
                label: 'Enter Internal ID'
            });
            form.addSubmitButton({
                label: 'Submit'
            });
            context.response.writePage(form);
        }
    }

    return {
        onRequest: onRequest
    }
});
