/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 */
define([
    'N/ui/serverWidget',
    '../forceFullfillOrders/forceFullFillorder'
], function (ui, forceFullFillorder) {

    function onRequest(context) {

        if (context.request.method === 'GET') {
            var status = context.request.parameters.status || '';
            var message = context.request.parameters.message || '';
            renderUI(context.response, status, message);
        } 
        else {
            var soId = context.request.parameters.so_internalid;

            try {
                //  Backend processing
                var result = forceFullFillorder.fullFillOrder(soId);
               // context.response.write('Processing Result: ' + JSON.stringify(result));
               // Reload with SUCCESS message
                context.response.write(`
                    <html><body>
                        <script>
                            window.location.href =
                                window.location.pathname +
                                '?status=success&message=${encodeURIComponent(
                                    'Sales Order ' + soId + ' processed successfully'
                                )}';
                        </script>
                    </body></html>
                `);
            } catch (e) {

                // Reload with ERROR message
                context.response.write(`
                    <html><body>
                        <script>
                            window.location.href =
                                window.location.pathname +
                                '?status=error&message=${encodeURIComponent(e.message)}';
                        </script>
                    </body></html>
                `);
            }
        }
    }

    function renderUI(response, status, message) {

        var alertHtml = '';
        if (status === 'success') {
            alertHtml = `<div class="alert success">${message}</div>`;
        } else if (status === 'error') {
            alertHtml = `<div class="alert error">${message}</div>`;
        }

        var html = `
<!DOCTYPE html>
<html>
<head>
    <title>Warehouse Fulfillment Utility</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            background: linear-gradient(135deg,#667eea,#764ba2);
            min-height: 100vh;
            margin: 0;
            display: flex;
            justify-content: center;
            align-items: center;
        }

        .container {
            width: 100%;
            max-width: 600px;
            padding: 20px;
            text-align: center;
        }

        .page-header {
            color: #fff;
            margin-bottom: 25px;
        }

        .page-header h1 {
            margin: 0;
            font-size: 28px;
        }

        .page-header p {
            margin-top: 8px;
            font-size: 15px;
            opacity: 0.9;
        }

        .card {
            background: white;
            padding: 30px;
            border-radius: 14px;
            box-shadow: 0 12px 30px rgba(0,0,0,.25);
        }

        input {
            width: 100%;
            padding: 14px;
            margin-bottom: 18px;
            font-size: 16px;
            border-radius: 8px;
            border: 1px solid #ccc;
        }

        button {
            width: 100%;
            padding: 14px;
            font-size: 16px;
            border: none;
            border-radius: 8px;
            background: #667eea;
            color: white;
            cursor: pointer;
        }

        button:disabled {
            background: #a0aec0;
            cursor: not-allowed;
        }

        /* ALERTS */
        .alert {
            padding: 14px;
            border-radius: 8px;
            margin-bottom: 20px;
            font-weight: 600;
        }

        .alert.success {
            background: #e6fffa;
            color: #065f46;
        }

        .alert.error {
            background: #fee2e2;
            color: #991b1b;
        }

        /* LOADER */
        .overlay {
            display: none;
            position: fixed;
            inset: 0;
            background: rgba(255,255,255,.92);
            z-index: 999;
            flex-direction: column;
            justify-content: center;
            align-items: center;
        }

        .warehouse {
            display: flex;
            gap: 12px;
            margin-bottom: 20px;
        }

        .box {
            width: 22px;
            height: 22px;
            background: #667eea;
            animation: lift 1.2s infinite ease-in-out;
        }

        .box:nth-child(2) { animation-delay: .15s; }
        .box:nth-child(3) { animation-delay: .3s; }
        .box:nth-child(4) { animation-delay: .45s; }

        @keyframes lift {
            0%, 80%, 100% { transform: translateY(0); opacity: .4; }
            40% { transform: translateY(-18px); opacity: 1; }
        }

        .loader-text {
            font-size: 16px;
            font-weight: 600;
            color: #333;
        }
    </style>

    <script>
        function submitForm(btn) {
            btn.disabled = true;        // 🔒 prevent double submit
            document.getElementById('loader').style.display = 'flex';
            return true;
        }
    </script>
</head>

<body>

<div class="overlay" id="loader">
    <div class="warehouse">
        <div class="box"></div>
        <div class="box"></div>
        <div class="box"></div>
        <div class="box"></div>
    </div>
    <div class="loader-text">Processing Warehouse Fulfillment...</div>
</div>

<div class="container">

    <div class="page-header">
        <h1>Warehouse Fulfillment Utility</h1>
        <p>Trigger backend processing for Sales Orders with missing JSON</p>
    </div>

    ${alertHtml}

    <div class="card">
        <h2>Paste Sales Order Internal ID</h2>
        <form method="POST" onsubmit="return submitForm(this.querySelector('button'));">
            <input 
                type="number" 
                name="so_internalid" 
                placeholder="Sales Order Internal ID" 
                required
            />
            <button type="submit">Trigger Fulfillment</button>
        </form>
    </div>

</div>

</body>
</html>
        `;

        response.write(html);
    }

    return {
        onRequest: onRequest
    };
});
