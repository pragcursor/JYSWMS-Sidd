/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 */
define(['N/currentRecord', 'N/https', 'N/url', 'N/ui/message', 'N/search'],
    function (currentRecord, https, url, message, search) {

        function pageInit(context) {
            // No-op

            // This function can be used for any initialization if needed in the future
        }

        function suspendPicking() {
            var confirmSuspend = confirm(
                'Are you sure you want to suspend picking for this Sales Order?'
            );

            if (!confirmSuspend) {
                return;
            }

            callSuitelet(true);
        }

        function resumePicking() {
            var confirmResume = confirm(
                'Are you sure you want to resume picking for this Sales Order?'
            );
            if (!confirmResume) {
                return;
            }
            callSuitelet(false);
        }

        function callSuitelet(suspend) {
            disableButtons();
            // showSpinner();

            try {
                var rec = currentRecord.get();
                var soId = rec.id;
                var lookupField = search.lookupFields({
                    type: search.Type.SALES_ORDER,
                    id: soId,
                    columns: ['shipmethod']
                });

                var so_shipvia = lookupField.shipmethod[0] ? lookupField.shipmethod[0].value : null;
                // alert('shipvia: ' + so_shipvia);
                // return;
                var suiteletUrl = url.resolveScript({
                    scriptId: 'customscript_jyswms_suspend_picking',
                    deploymentId: 'customdeploy_jyswms_suspend_picking'
                });

                var response = https.post({
                    url: suiteletUrl,
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        salesOrderId: soId,
                        suspendPicking: suspend,
                        shipVia: so_shipvia
                    })
                });

                var result = JSON.parse(response.body);

                if (!result.success) {
                    throw result.message;
                }

                // Success → reload page to refresh button
                window.location.reload();

            } catch (e) {
                // hideSpinner();
                enableButtons();
                alert('Operation failed: ' + e);
                console.error(e);
            }
        }


        function disableButtons() {
            var btnSuspend = document.getElementById('custpage_suspend_picking');
            var btnResume = document.getElementById('custpage_resume_picking');

            if (btnSuspend) btnSuspend.disabled = true;
            if (btnResume) btnResume.disabled = true;
        }

        function enableButtons() {
            var btnSuspend = document.getElementById('custpage_suspend_picking');
            var btnResume = document.getElementById('custpage_resume_picking');

            if (btnSuspend) btnSuspend.disabled = false;
            if (btnResume) btnResume.disabled = false;
        }

        function showSpinner() {
            if (document.getElementById('jyswms_spinner')) {
                return;
            }

            var spinner = document.createElement('div');
            spinner.id = 'jyswms_spinner';
            spinner.style.position = 'fixed';
            spinner.style.top = '0';
            spinner.style.left = '0';
            spinner.style.width = '100%';
            spinner.style.height = '100%';
            spinner.style.backgroundColor = 'rgba(255,255,255,0.6)';
            spinner.style.zIndex = '10000';
            spinner.style.display = 'flex';
            spinner.style.alignItems = 'center';
            spinner.style.justifyContent = 'center';
            spinner.innerHTML =
                '<div style="font-size:16px;font-weight:bold;">Processing...</div>';

            document.body.appendChild(spinner);
        }

        function hideSpinner() {
            var spinner = document.getElementById('jyswms_spinner');
            if (spinner) {
                spinner.remove();
            }
        }

        return {
            suspendPicking: suspendPicking,
            resumePicking: resumePicking,
            pageInit: pageInit
        };
    });
