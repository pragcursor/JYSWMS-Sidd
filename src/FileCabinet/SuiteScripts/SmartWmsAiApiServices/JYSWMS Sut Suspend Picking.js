/**
 * @NApiVersion 2.x
 * @NScriptType Suitelet
 */
define(['N/record', 'N/https', 'N/log'],
    function (record, https, log) {

        function onRequest(context) {

            if (context.request.method !== 'POST') {
                context.response.write('Invalid request');
                return;
            }

            try {
                var body = JSON.parse(context.request.body);

                var sales_id = body.salesOrderId;     // Sales Order ID
                var suspended = body.suspendPicking; // true / false
                var shipVia = body.shipVia;           // Shipping Method (optional, can be used for additional logic if needed)
                var entityType = 'salesorder';

                if (!sales_id) {
                    throw 'Missing Sales Order ID';
                }
                log.audit('Received Request', 'Sales Order ID: ' + sales_id + ', Suspend: ' + suspended + ', Ship Via: ' + shipVia);

                if (shipVia != 57733) {
                    // 1. Call external API FIRST
                    var apiResult = sendData(sales_id, entityType, suspended);

                    if (!apiResult.success) {
                        throw apiResult.error || apiResult.response || 'API call failed';
                    }
                }
                // 2. Update Sales Order ONLY after API success
                // var soRec = record.load({
                //     type: record.Type.SALES_ORDER,
                //     id: sales_id
                // });

                // soRec.setValue({
                //     fieldId: 'custbody_jyswms_suspend_picking',
                //     value: suspended
                // });

                // soRec.save({
                //     ignoreMandatoryFields: true
                // });
                var so_sub = record.submitFields({
                    type: record.Type.SALES_ORDER,
                    id: sales_id,
                    values: {
                        custbody_jyswms_suspend_picking: suspended
                    },
                    options: {
                        enableSourcing: false,
                        ignoreMandatoryFields: true
                    }
                });
                log.audit('Suspend/Resume Picking Success', 'Sales Order ID: ' + sales_id + ', Suspended: ' + suspended);
                context.response.write(JSON.stringify({
                    success: true
                }));

            } catch (e) {
                log.error('Suspend/Resume Picking Failed', e);

                context.response.write(JSON.stringify({
                    success: false,
                    message: e.toString()
                }));
            }
        }

        /* ===================== API HELPERS ===================== */

        function sendData(entityId, entityType, suspended) {
            var token = generateToken();
            if (!token) {
                return { success: false, error: 'Token generation failed' };
            }

            try {
                var response = https.post({
                    url: 'https://api.jyswms.com/dropship-suspend?so_id=' + entityId,
                    headers: {
                        'Authorization': 'Bearer ' + token,
                        'Content-Type': 'application/json'
                    }
                    // Body intentionally omitted as per your implementation
                });

                return {
                    success: response.code === 200,
                    response: response.body || ''
                };

            } catch (e) {
                log.error('sendData Error', e);
                return {
                    success: false,
                    error: e.message || e.toString()
                };
            }
        }

        /** Authenticates & returns access token */
        function generateToken() {
            const url = 'https://api.jyswms.com/user/login';
            const creds = {
                userid: 'jyswms_integration_user',
                password: 's9u[7zC720%pZr'
            };

            try {
                const response = https.post({
                    url: url,
                    body: JSON.stringify(creds),
                    headers: { 'Content-Type': 'application/json' }
                });

                const parsed = JSON.parse(response.body || '{}');

                if (parsed.access_token) {
                    return parsed.access_token;
                }

               // log.error('Token Generation Failed', parsed);
                return null;

            } catch (e) {
                log.error('generateToken Error', e.message);
                return null;
            }
        }

        return {
            onRequest: onRequest
        };
    });
