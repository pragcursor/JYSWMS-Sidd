/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 */
define([
    'N/ui/serverWidget', 'N/runtime', 'N/https',
    '../forceFullfillOrders/forceFullFillorder'
], function (ui, runtime, https, forceFullFillorder) {

    function onRequest(context) {

        if (context.request.method === 'GET') {
            log.error("status -- GET")
            var status = context.request.parameters.status || '';
            var message = context.request.parameters.message || '';
            var soId = context.request.parameters.so_internalid;

            if (soId) {
                //  log.error("action",action);
                log.error("soid", soId);
                var payLoad = {
                    soInternalId: soId,
                    action: 'fulfillOrder'
                };

                log.error("payLoad", payLoad);

                try {
                    var response = https.requestRestlet({
                        scriptId: 'customscript_fulfillorders_support_rl',   // script id (NOT internal id)
                        deploymentId: 'customdeploy_fulfillorders_support_rl', // deployment id (NOT internal id)
                        method: https.Method.POST,
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify(payLoad)
                    });
                    log.error("response from reslet get ", response);
                    var parsed = JSON.parse(response.body);
                } catch (e) {
                    log.error("Restlet call failed.", e.message);
                }
            } else {
                renderUI(context.response, status, message);
            }
        }
        else {
            log.error("post");
            var soId = context.request.parameters.so_internalid;
            var action = context.request.parameters.action;

            log.error("action", action);
            log.error("soid", soId);

            try {

                var payLoad = {
                    soInternalId: soId,
                    action: action
                };

                log.error("payLoad", payLoad);

                try {
                    var response = https.requestRestlet({
                        scriptId: 'customscript_fulfillorders_support_rl',   // script id (NOT internal id)
                        deploymentId: 'customdeploy_fulfillorders_support_rl', // deployment id (NOT internal id)
                        method: https.Method.POST,
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify(payLoad)
                    });
                    log.error("Restlet called successfully. ", response);
                    var parsed = JSON.parse(response.body);


                    var parsed = JSON.parse(response.body);

                    context.response.write(`
<html>
<head>
    <style>
        body { font-family: Arial; padding:20px; }
        .box { border:1px solid #ccc; padding:15px; margin-bottom:15px; border-radius:6px;}
        .success { color:green; font-weight:bold; }
        .btn {
    background:#0070d2;
    color:white;
    border:none;
    padding:10px 16px;
    border-radius:6px;
    cursor:pointer;
    font-weight:bold;
    margin-bottom:15px;
}
        .fail { color:red; font-weight:bold; }
        ul { max-height:200px; overflow:auto; }
    </style>
</head>
<body>

 <button class="btn" onclick="reprocess()">🔄 Reprocess Another Order</button>

    <div class="box">
        <h3>Fulfillment Details</h3>
        <div>Sales Order: <b>${parsed.salesOrder}</b></div>
        <div>Fulfillment Id: <b>${parsed.fulfillmentId}</b></div>
    </div>

    <div class="box">
        <h3>AMZCC Record</h3>
       
           <div>Status: 
        <span class="success">
            ${parsed.AmzccRecord.success}
        </span>
    </div>

        
        <div>Generated IDs:</div>
        <ul>
            ${parsed.AmzccRecord.amzccIds.map(id => `<li>${id}</li>`).join("")}
        </ul>
    </div>

    <div class="box">
        <h3>Package Contents</h3>
        
           <div>Status: 
        <span class="success">
            ${parsed.packageContents.success}
        </span>
    </div>
        <div>Generated IDs:</div>
        <ul>
            ${parsed.packageContents.packageContentIds.map(id => `<li>${id}</li>`).join("")}
        </ul>
    </div>

    ${parsed.Packages ? `
<div class="box">
    <h3>Package Contents</h3>
    
    <div>Status: 
        <span class="success">
            ${parsed.Packages.success}
        </span>
    </div>

    <div>Generated IDs:</div>
    <ul>
        ${(parsed.Packages.trackingNumbers || []).map(id => `<li>${id}</li>`).join("")}
    </ul>
</div>
` : ''}


<script> 
function reprocess(){
   var url = new URL(window.location.href);
    url.searchParams.set('reset', Date.now());
    window.location.href = url.href;
}
</script>
</body>
</html>
`);
                } catch (error) {
                    log.error("reslet error", error.message);
                }


                log.error("payLoad 12345", payLoad);


            } catch (e) {

                // Reload with ERROR message
                context.response.write(`
                    <html><body>
                      <h2 style= "color:red;"> Error triggering fullfillment: ${e.message} </h2>
                      <button onclick = "window.location.reload()"> Try Again </button>
                      </body> </html>
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
            btn.disabled = true;        //  prevent double submit
            document.getElementById('loader').style.display = 'flex';
            return true;
        }
        function setAction(action){
            document.getElementById('actionField').value = action;
         }

       function getStatus(){
        document.getElementById('actionField').value = 'getStatus';
        document.querySelector('form').submit();
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

        <input type="hidden" name="action" id="actionField" />
            <input type="number" 
                name="so_internalid" 
                placeholder="Sales Order Internal ID" 
                required />
                
            <button type="submit" onclick="setAction('fulfillOrder')">Trigger Fulfillment</button>
            
            <button type="button" onclick="getStatus()" style = "margin-top:10px;">Get SO Status</button>
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
