/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 */
define(['N/https', 'N/log'], (https, log) => {

    /**
     * Generate bearer token by calling login API.
     */
    function generateToken() {
        try {
            const webhookUrl = 'https://api.jyswms.com/user/login'; // prod Url
            let token = '';

            const formData = {
                userid: 'jyswms_integration_user',
                password: 's9u[7zC720%pZr'
            };

           // log.error('formData', formData);

            const headerObj = {
                'Content-Type': 'application/json'
            };

            try {
                const response = https.post({
                    url: webhookUrl,
                    body: JSON.stringify(formData),
                    headers: headerObj
                });

                //log.error('login response', JSON.stringify(response));

                const responseBody = response.body || '';
                const parsedBody = JSON.parse(responseBody); // Convert JSON string to object
                token = parsedBody.access_token || '';

            } catch (e) {
                log.error('Error while sending login request', e.message || e);
            }

            return token;

        } catch (e) {
            log.error('Error in token generation', e);
            return '';
        }
    }

    /**
     * Call the LTL users summary API and return parsed JSON.
     */
    function fetchLtlSummary() {
        try {  

        //  'https://api.jyswms.com/update-inbound-shipment-id';
            const webhookUrl = 'https://api.jyswms.com/ltl-users-summary';  ///ltl-users-summary

            const token = generateToken();
           // log.error('token', token);

            if (!token) {
                return {
                    success: false,
                    error: 'Token generation failed'
                };
            }

            const headers = {
                'Authorization': 'Bearer ' + token,
                'Content-Type': 'application/json'
            };

            const response = https.get({
                url: webhookUrl,
                headers: headers
            });

          //  log.error('LTL Summary response', JSON.stringify(response));

            const responseBody = response.body || '{}';
            const parsedBody = JSON.parse(responseBody);

            return {
                success: true,
                data: parsedBody
            };

        } catch (e) {
            log.error('Error fetchLtlSummary', e);

            return {
                success: false,
                error: e.message || e
            };
        }
    }

    /**
     * Build full HTML page with Bootstrap table.
     */
    function buildHtml(summaryResult) {
        const success = summaryResult && summaryResult.success;
        const payload = summaryResult && summaryResult.data ? summaryResult.data : {};

        const message = payload.message || '';
        const totalRecords = payload.total_records || 0;
        const totalItems = payload.total_items || 0;
        const unassignedUnpicked = payload.unassigned_unpicked || 0;
        const rows = Array.isArray(payload.data) ? payload.data : [];

        let tableRows = '';
        rows.forEach((row, idx) => {
            tableRows +=
                '<tr>' +
                '<td>' + (idx + 1) + '</td>' +
                '<td>' + (row.userName || '') + '</td>' +
                '<td>' + (row.isActive || '') + '</td>' +
                '<td>' + (row.unpicked || 0) + '</td>' +
                '<td>' + (row.picked || 0) + '</td>' +
                '</tr>';
        });

        const errorAlert = !success
            ? '<div class="alert alert-danger mt-3" role="alert">' +
              'Failed to load data: ' + (summaryResult && summaryResult.error ? summaryResult.error : 'Unknown error') +
              '</div>'
            : '';

        const html =
            '<!DOCTYPE html>' +
            '<html>' +
            '<head>' +
            '<meta charset="UTF-8" />' +
            '<title>LTL Users Summary</title>' +
            '<meta name="viewport" content="width=device-width, initial-scale=1" />' +
            '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" ' +
            'integrity="sha384-QWTKZyjpPEjISv5WaRU9OFeRpok6YctnYmDr5pNlyT2bRjXh0JMhjY6hW+ALEwIH" crossorigin="anonymous" />' +
            '</head>' +
            '<body class="bg-light">' +
            '<div class="container py-4">' +
            '<h1 class="mb-3">LTL Users Summary</h1>' +
            (message ? '<p class="text-muted">' + message + '</p>' : '') +
            '<div class="row mb-3">' +
            '<div class="col-md-4"><strong>Total Records:</strong> ' + totalRecords + '</div>' +
            '<div class="col-md-4"><strong>Total Items:</strong> ' + totalItems + '</div>' +
            '<div class="col-md-4"><strong>Unassigned / Unpicked:</strong> ' + unassignedUnpicked + '</div>' +
            '</div>' +
            errorAlert +
            '<div class="card shadow-sm">' +
            '<div class="card-body">' +
            '<div class="table-responsive">' +
            '<table class="table table-striped table-hover mb-0">' +
            '<thead class="table-dark">' +
            '<tr>' +
            '<th scope="col">#</th>' +
            '<th scope="col">User Name</th>' +
            '<th scope="col">Active</th>' +
            '<th scope="col">Unpicked</th>' +
            '<th scope="col">Picked</th>' +
            '</tr>' +
            '</thead>' +
            '<tbody>' +
            tableRows +
            '</tbody>' +
            '</table>' +
            '</div>' +
            '</div>' +
            '</div>' +
            '</div>' +
            '</body>' +
            '</html>';

        return html;
    }

    /**
     * Suitelet entry point
     */
    function onRequest(context) {
        if (context.request.method === 'GET') {
            const summary = fetchLtlSummary();
            const html = buildHtml(summary);
            context.response.write(html);
        } else {
            context.response.write('This Suitelet only supports GET requests.');
        }
    }

    return {
        onRequest: onRequest
    };
});


