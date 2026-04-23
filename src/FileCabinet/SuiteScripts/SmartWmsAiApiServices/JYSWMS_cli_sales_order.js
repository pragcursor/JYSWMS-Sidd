/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 */
define(['N/currentRecord', 'N/https', 'N/url', 'N/ui/message', 'N/search', 'N/record'],
    function (currentRecord, https, url, message, search, record) {

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

        function onCloseLineButtonClick() {
            var rec = currentRecord.get();
            var soId = rec.id;

            var confirmClose = confirm(
                'Are you sure you want to close this Sales Order and all its lines?'
            );
            if (!confirmClose) return;

            try {
                // 🔥 STEP 1: Lock UI immediately
                disableButtons();
                showSpinner();

                // 🔥 STEP 2: Create record (blocking, but user sees loader)
                createCloseOrderRecord(soId);

                // 🔥 STEP 3: Call Suitelet (continues same loader flow)
                callSuitelet(true);

            } catch (e) {
                enableButtons();
                hideSpinner();
                alert('Close operation failed: ' + e);
                console.error(e);
            }
        }


        function callSuitelet(suspend) {
            disableButtons();
            showSpinner();

            try {
                var rec = currentRecord.get();
                var soId = rec.id;

                var lookupField = search.lookupFields({
                    type: search.Type.SALES_ORDER,
                    id: soId,
                    columns: ['shipmethod']
                });

                var so_shipvia = lookupField.shipmethod[0]
                    ? lookupField.shipmethod[0].value
                    : null;

                var suiteletUrl = url.resolveScript({
                    scriptId: 'customscript_jyswms_suspend_picking',
                    deploymentId: 'customdeploy_jyswms_suspend_picking',
                    returnExternalUrl: false
                });

                console.log('Suitelet URL:', suiteletUrl);

                fetch(suiteletUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        salesOrderId: soId,
                        suspendPicking: suspend,
                        shipVia: so_shipvia
                    })
                })
                    .then(function (response) {
                        if (!response.ok) {
                            throw 'HTTP Error: ' + response.status;
                        }
                        return response.json();
                    })
                    .then(function (result) {

                        if (!result.success) {
                            throw result.message || 'Unknown error from Suitelet';
                        }

                        // Success → reload page
                        window.location.reload();

                    })
                    .catch(function (e) {
                        enableButtons();
                        hideSpinner();
                        alert('Operation failed: ' + e);
                        console.error('Suitelet Call Error:', e);
                    });

            } catch (e) {
                enableButtons();
                hideSpinner();
                alert('Operation failed: ' + e);
                console.error('Client Error:', e);
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
            if (document.getElementById('jyswms_overlay')) return;

            var overlay = document.createElement('div');
            overlay.id = 'jyswms_overlay';

            overlay.style.position = 'fixed';
            overlay.style.top = '0';
            overlay.style.left = '0';
            overlay.style.width = '100%';
            overlay.style.height = '100%';
            overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.4)';
            overlay.style.zIndex = '99999';
            overlay.style.display = 'flex';
            overlay.style.alignItems = 'center';
            overlay.style.justifyContent = 'center';
            overlay.style.cursor = 'not-allowed';

            overlay.innerHTML = `
                <div style="
                    background: white;
                    padding: 20px 30px;
                    border-radius: 8px;
                    font-size: 16px;
                    font-weight: bold;
                    box-shadow: 0 0 10px rgba(0,0,0,0.2);
                ">
                    Processing... Please wait
                </div>
            `;

            // 🔒 Block ALL interactions
            overlay.addEventListener('click', function (e) {
                e.stopPropagation();
                e.preventDefault();
            }, true);

            document.body.appendChild(overlay);
        }

        function hideSpinner() {
            var overlay = document.getElementById('jyswms_overlay');
            if (overlay) {
                overlay.remove();
            }
        }

        function createCloseOrderRecord(soId) {
            try {
                
                var CRRecord = record.create({ type: 'customrecord_ns_close_order' });
                CRRecord.setValue({
                    fieldId: 'custrecord_closed_order_so',
                    value: soId
                });
                CRRecord.save();
            } catch (e) {
                console.error('Custom Record creation failed:', e);
            }
        }

        return {
            suspendPicking: suspendPicking,
            resumePicking: resumePicking,
            onCloseLineButtonClick: onCloseLineButtonClick,
            pageInit: pageInit
        };
    });