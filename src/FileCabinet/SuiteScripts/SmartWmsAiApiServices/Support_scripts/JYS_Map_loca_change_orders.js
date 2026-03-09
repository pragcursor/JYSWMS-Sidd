/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/https', 'N/record', 'N/log'], (https, record, log) => {

    const API_URL = 'https://api.jyswms.com/dropship-no-inventory-orders?action=false';
    const CHECKBOX_FIELD_ID = 'custbody_jyswms_loc_updated';

    const generateToken = () => {

        const url = 'https://api.jyswms.com/user/login';

        const creds = {
            userid: 'jyswms_integration_user',
            password: 's9u[7zC720%pZr'
        };

        try {

            const response = https.post({
                url: url,
                body: JSON.stringify(creds),
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            const parsed = JSON.parse(response.body || '{}');

            if (parsed.access_token) {
                return parsed.access_token;
            }

            log.error('Token Generation Failed', parsed);
            return null;

        } catch (e) {
            log.error('generateToken Error', e);
            return null;
        }
    };

    /**
     * -------------------------------------------------
     * 1️⃣ GET INPUT DATA
     * -------------------------------------------------
     * Calls external API and returns raw data rows
     */
    const getInputData = () => {

        try {

            const token = generateToken();

            if (!token) {
                log.error('Token Error', 'Unable to generate token');
                return [];
            }

            const response = https.get({
                url: API_URL,
                headers: {
                    'Authorization': 'Bearer ' + token,
                    'Content-Type': 'application/json'
                }
            });

            if (response.code !== 200) {
                log.error('API Error', response.body);
                return [];
            }

            const parsed = JSON.parse(response.body || '{}');

            if (parsed.status !== 'success' || !parsed.data) {
                log.error('Invalid API Response', parsed);
                return [];
            }

            return parsed.data;

        } catch (e) {
            log.error('getInputData Error', e);
            return [];
        }
    };

    /**
     * -------------------------------------------------
     * 2️⃣ MAP STAGE
     * -------------------------------------------------
     * Writes internal_id as key
     * NetSuite will group duplicates automatically
     */
    const map = (context) => {

        try {

            const row = JSON.parse(context.value);

            if (!row.internal_id) return;

            context.write({
                key: row.internal_id,
                value: row.unique_id || 'line'
            });

        } catch (e) {
            log.error('Map Error', e);
        }
    };

    /**
     * -------------------------------------------------
     * 3️⃣ REDUCE STAGE
     * -------------------------------------------------
     * Runs ONCE per unique internal_id
     * Safely updates Sales Order
     */
    const reduce = (context) => {

        const salesOrderId = context.key;

        try {

            var salesOrderRecord = record.load({
                type: record.Type.SALES_ORDER,
                id: salesOrderId,
                isDynamic: true
            });
            salesOrderRecord.setValue({
                fieldId: CHECKBOX_FIELD_ID,
                value: false
            });
            salesOrderRecord.save();

            log.audit('Sales Order Updated', {
                salesOrderId: salesOrderId,
                occurrencesFromAPI: context.values.length
            });

        } catch (e) {

            log.error(`Reduce Error Updating SO ${salesOrderId}`, e);

            // Throw error to allow automatic retry if needed
            //  throw e;
        }
    };

    /**
     * -------------------------------------------------
     * 4️⃣ SUMMARY
     * -------------------------------------------------
     */
    const summarize = (summary) => {
        try {


            log.audit('Usage Consumed', summary.usage);
            log.audit('Concurrency', summary.concurrency);
            log.audit('Yields', summary.yields);

            summary.mapSummary.errors.iterator().each((key, error) => {
                log.error(`Map Error for Key: ${key}`, error);
                return true;
            });

            summary.reduceSummary.errors.iterator().each((key, error) => {
                log.error(`Reduce Error for SO: ${key}`, error);
                return true;
            });
        } catch (error) {
            log.error('Summarize Error', error);
        }
    };

    return {
        getInputData,
        map,
        reduce,
        summarize
    };

});