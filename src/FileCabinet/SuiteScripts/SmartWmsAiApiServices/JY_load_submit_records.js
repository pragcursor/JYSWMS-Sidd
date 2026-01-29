/**
 * @NApiVersion 2.x
 * @NScriptType Suitelet
 */
define(['N/record', 'N/log', 'N/error'],
    function(record, log, error) {

        function onRequest(context) {
            var request = context.request;
            var response = context.response;

            try {
                // Check if the request method is GET or POST
                if (request.method === 'GET' || request.method === 'POST') {
                    // Get the recordType and recordId from the request parameters
                    var recordType = request.parameters.recordtype;
                    var recordId = request.parameters.recordid;

                    // Validate the parameters
                    if (!recordType || !recordId) {
                        throw error.create({
                            name: 'MISSING_PARAMETER',
                            message: 'Missing recordType or recordId parameter.',
                            notifyOff: true
                        });
                    }

                    try {
                        // Load the record dynamically
                        var recObj = record.load({
                            type: recordType,
                            id: recordId,
                            isDynamic: true
                        });


                        // Save the record
                        var savedRecordId = recObj.save(true,true);

                        response.write('Record ' + savedRecordId + ' has been successfully loaded and submitted.');

                    } catch (loadError) {
                        log.error({
                            title: 'Error Loading/Submitting Record',
                            details: loadError
                        });
                        throw error.create({
                            name: 'LOAD_SUBMIT_ERROR',
                            message: 'Error occurred while loading or submitting the record: ' + loadError.message,
                            notifyOff: true
                        });
                    }

                } else {
                    throw error.create({
                        name: 'UNSUPPORTED_REQUEST_METHOD',
                        message: 'Unsupported request method: ' + request.method,
                        notifyOff: true
                    });
                }
            } catch (e) {
                response.write('Error: ' + e.name + ' - ' + e.message);
                log.error({
                    title: 'Suitelet Error',
                    details: e
                });
            }
        }

        return {
            onRequest: onRequest
        };
    });
