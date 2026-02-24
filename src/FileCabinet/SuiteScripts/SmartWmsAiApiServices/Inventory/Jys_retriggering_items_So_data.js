/**
 * @NApiVersion 2.x
 * @NModuleScope Public
 */

define(['./inventoryUtils.js', '../JYSWMS_generateToken_API.js','N/log','N/https'], function (inventoryUtils, tokenModule, log, https) {

    function getItemInventorydata(context) {
        try {

           
            var itemIds = [];

            var data = context;
            log.error("Request Data - getinv", data);
            if (data.length > 0) {
                var length = data.length;
                for (var i = 0; i < length; i++) {
                    var itemId = data[i].item_internalid;
                    if (itemIds.indexOf(itemId) === -1) {
                        itemIds.push(itemId);
                    }
                }
            }

            if (itemIds.length > 0) {
                processInventory(itemIds)
            }
        } catch (e) {
            log.error("Error in Suitelet", e.message);
        }
    }

    function processInventory(itemIds) {
        const params = { itemIds };
        //  //log.debug("Inventory Params", params);

        const inventoryData = inventoryUtils.getInventory(params, 1000, 0);
        log.error("Inventory Data - checking", inventoryData);

        const apiStatus = sendData(inventoryData);
        //log.debug("API Response", apiStatus);
    }




    function sendData(body) {
        const token = tokenModule.generateToken();
        // //log.debug("token generared",token);
        if (!token) {
            return { success: false, error: "Token generation failed" };
        }

        try {
            //  //log.debug("Body",JSON.stringify(body));

            const response = https.post({
                url: 'https://api.jyswms.com/netsuite/update-inventory',
                body: JSON.stringify(body),
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }

            });

            const raw = response.body || "";
            const success = response.code === 200;
            return { success, response: raw };

        } catch (e) {
            log.error("sendData Error", e.message);
            return { success: false, error: e.message };
        }
    }



    return {
        getItemInventorydata: getItemInventorydata
    }
});
