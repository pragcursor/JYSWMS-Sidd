
/**
 * @NApiVersion 2.x
 * @NModuleScope Public
 */
define(['N/https', 'N/log'], function (https, log) {
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
    return {
        generateToken: generateToken
    };
});