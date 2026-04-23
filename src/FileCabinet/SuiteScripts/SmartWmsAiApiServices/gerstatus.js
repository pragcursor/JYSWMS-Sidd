/**
 *@NApiVersion 2.x
 *@NScriptType Suitelet
 */
define(['N/ui/serverWidget', 'N/search'], function (ui, search) {

    function onRequest(context) {

        if (context.request.method === 'GET') {

            var form = ui.createForm({
                title: 'Sales Order Status Lookup'
            });

            var input = form.addField({
                id: 'custpage_soids',
                type: ui.FieldType.TEXT,
                label: 'Sales Order IDs (comma separated)'
            });

            form.addSubmitButton({
                label: 'Check Status'
            });

            context.response.writePage(form);
        }

        else {

            var soIds = context.request.parameters.custpage_soids || '';
            var idArray = soIds.split(',');

            var resultObj = {};

            for (var i = 0; i < idArray.length; i++) {

                var salesOrderId = idArray[i].trim();
                if (!salesOrderId) continue;

                try {

                    var lookup = search.lookupFields({
                        type: search.Type.SALES_ORDER,
                        id: salesOrderId,
                        columns: ['status']
                    });

                    var statusText = lookup.status && lookup.status.length
                        ? lookup.status[0].text
                        : '';

                    resultObj[salesOrderId] = statusText;

                } catch (e) {

                    resultObj[salesOrderId] = 'ERROR: ' + e.message;
                }
            }

            var form = ui.createForm({
                title: 'Sales Order Status Result'
            });

         var resultField = form.addField({
    id: 'custpage_result',
    type: ui.FieldType.INLINEHTML,
    label: 'Result'
});

resultField.defaultValue = '<pre>' + 
    JSON.stringify(resultObj, null, 2) + 
    '</pre>';

           // resultField.defaultValue = JSON.stringify(resultObj, null, 2);

            context.response.write(
    '<pre>' + JSON.stringify(resultObj, null, 2) + '</pre>'
);
        }
    }

    return {
        onRequest: onRequest
    };
});