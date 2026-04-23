/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 */
define(['N/https', 'N/log'], function (https, log) {

    function onRequest(context) {

        try {
            var request = context.request;

            // Accept params from BOTH GET & POST
            var soId = request.parameters.so_internalid;
            var action = request.parameters.action || 'fulfillOrder';

            if (!soId) {
                throw new Error('Missing so_internalid');
            }

            var payload = {
                soInternalId: soId,
                action: action
            };

            log.debug('Payload', payload);

            var restletResponse = https.requestRestlet({
                scriptId: 'customscript_fulfillorders_support_rl',
                deploymentId: 'customdeploy_fulfillorders_support_rl',
                method: https.Method.POST,
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            var parsed = JSON.parse(restletResponse.body);

            // Always return JSON
            context.response.setHeader({
                name: 'Content-Type',
                value: 'application/json'
            });

            context.response.write(JSON.stringify({
                success: true,
                data: parsed
            }));

        } catch (e) {

            log.error('ERROR', e);

            context.response.setHeader({
                name: 'Content-Type',
                value: 'application/json'
            });

            context.response.write(JSON.stringify({
                success: false,
                error: e.message
            }));
        }
    }

    return {
        onRequest: onRequest
    };
});