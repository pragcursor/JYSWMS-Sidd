/**
 *@NApiVersion 2.x
 *@NScriptType UserEventScript
 */
define(['N/https', 'N/log'], function (https, log) {

    const SUSPENDED_FIELD = 'custentity_jyswms_suspended';

    function afterSubmit(context) {
        if (context.type !== context.UserEventType.EDIT) {
            return;
        }

        var newRecord = context.newRecord;
        var oldRecord = context.oldRecord;

        var isSuspended = newRecord.getValue({ fieldId: SUSPENDED_FIELD });
        var wasSuspended = oldRecord.getValue({ fieldId: SUSPENDED_FIELD });

        // Exit if value did not change
        if (isSuspended === wasSuspended) {
            return;
        }

        if (isSuspended === true) {
            sendData(
                newRecord.id,
                newRecord.type,
                true
            );
        } else if (isSuspended === false) {
            sendData(
                newRecord.id,
                newRecord.type,
                false
            );
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

            log.error('Token Generation Failed', parsed);
            return null;

        } catch (e) {
            log.error('generateToken Error', e.message);
            return null;
        }
    }

    /** Sends data to external API using parameters */
    function sendData(entityId, entityType, suspended) {
        const token = generateToken();
        if (!token) {
            return;
        }

        // const payload = {
        //     entityId: entityId,
        //     entityType: entityType,
        //     suspended: suspended
        // };

        try {
            const response = https.post({
                // url: 'https://api.jyswms.com/dropship-suspend?customer_id=' + entityId,
                url: 'https://api.jyswms.com/suspend-customer',
                body: JSON.stringify({
                    suspend: suspended,
                    customer_id: entityId
                }),
                headers: {
                    'Authorization': 'Bearer ' + token,
                    'Content-Type': 'application/json'
                }
            });



            return {
                success: response.code === 200,
                response: response.body || ''
            };

        } catch (e) {
            log.error('sendData Error', e.message);
            return { success: false, error: e.message };
        }
    }

    return {
        afterSubmit: afterSubmit
    };
});