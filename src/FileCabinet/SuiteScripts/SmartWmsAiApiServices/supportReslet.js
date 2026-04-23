/** 
 * @NApiVersion 2.1
 * @NScriptType Restlet
 */

define(['N/task', 'N/record', 'N/search', 'N/runtime', './forceFullfillOrders/forceFullFillorder'], function (task, record, search, runtime, fulfillorder) {


    function post(context) {
        var request = context;
        if (request) {

            var payload = request;
            
            var action = payload.action;
            var response = "";
            log.error("action", action);

            try {
                switch (action) {
                    case 'fulfillOrder':
                        var soId = payload.soInternalId;
                        response = fulfillorder.fullFillOrder(soId);
                        log.error("soId",soId);
                        var soRec = record.load({
                            type: record.Type.SALES_ORDER,
                            id: soId,
                            isDynamic: false
                        });
                        log.error("responsefrom util", response);

                        soRec.setValue({
                            fieldId: 'custbody_error_processing_json',
                            value: JSON.stringify(response)
                        });

                        soRec.setValue({
                            fieldId: 'custbody_trigger_schdule_script',
                            value: true
                        });
                        soRec.setValue({
                            fieldId: 'custbody_force_process_order',
                            value: false
                        });
                        soRec.save({
                            enableSourcing: true,
                            ignoreMandatoryFields: true
                        });
                        break;
                    case 'getStatus':
                        var soId = payload.soInternalId;
                        var status = search.lookupFields({
                            type: 'salesorder',
                            id: soId,
                            columns: ['custbody_error_processing_json']
                        });
                        log.error("JSON from LookUp", status.custbody_error_processing_json);
                        response = JSON.parse(status.custbody_error_processing_json) || "No data found";
                        break;
                    default:
                        response = "Invalid action";
                }

                if (response) {

                    log.error("Resposne from fullFillOrder util file", JSON.stringify(response));

                }
            } catch (error) {
                response = {
                    "salesOrder": soId,
                    "Message": "Check the given sales order internal id" + error.message
                };
            }
            return response;

        }
    }
    return {
        post: post
    }
})

/*-----------------------SAMPLE RESPONSE-----------------------  */
// return response = {"salesOrder":"62401850","fulfillmentId":"63541226",   
                        //             "AmzccRecord":{"success":true,
                        //             "amzccIds":["00103308421240185017","00103308461240185013","00103308431240185016","00103308431240185023","00103308431240185030","00103308431240185047","00103308501240185016","00103308501240185023","00103308501240185030","00103308501240185047","00103308491240185010","00103308511240185015","00103308441240185015","00103308441240185022","00103308441240185039","00103308441240185046","00103308481240185011","00103308521240185014","00103308541240185012","00103308541240185029","00103308551240185011","00103308451240185014","00103308471240185012","00103308401240185019","00103308411240185018","00103308411240185025","00103308531240185013","00103308531240185020","00103308561240185010","00103308561240185027","00103308561240185034"]},
                        //             "packageContents":{"success":true,
                        //             "packageContentIds":["00103308421240185017","00103308461240185013","00103308431240185016","00103308431240185023","00103308431240185030","00103308431240185047","00103308501240185016","00103308501240185023","00103308501240185030","00103308501240185047","00103308491240185010","00103308511240185015","00103308441240185015","00103308441240185022","00103308441240185039","00103308441240185046","00103308481240185011","00103308521240185014","00103308541240185012","00103308541240185029","00103308551240185011","00103308451240185014","00103308471240185012","00103308401240185019","00103308411240185018","00103308411240185025","00103308531240185013","00103308531240185020","00103308561240185010","00103308561240185027","00103308561240185034"]
                        //                             },
                        //             "Packages": {
                        //               "success":"error",
                        //               "trackingNumbers": ["235","5678765"]
                        //             }
                        //            }//