/**
 * @NApiVersion 2.x
 * @NModuleScope Public
 */
define([
    './inventoryUtils',
    '../JYSWMS_generateToken_API',
    'N/log',
    'N/https'
], function (inventoryUtils, tokenModule, log, https) {

    function getItemInventorydata(context) {
        try {

            var itemIds = [];
            var data = context || [];

            log.error({
                title: "Request Data - getinv",
                details: JSON.stringify(data)
            });

            if (data && data.length && data.length > 0) {

                for (var i = 0; i < data.length; i++) {

                    if (data[i] && data[i].item_internalid) {

                        var itemId = data[i].item_internalid;

                        if (itemIds.indexOf(itemId) === -1) {
                            itemIds.push(itemId);
                        }
                    }
                }
            }

            if (itemIds.length > 0) {
                processInventory(itemIds);
            }

        } catch (e) {
            log.error({
                title: "Error in getItemInventorydata",
                details: e
            });
        }
    }


    function processInventory(itemIds) {

        var params = {
            itemIds: itemIds
        };

        var inventoryData = inventoryUtils.getInventory(params, 1000, 0);

        log.error({
            title: "Inventory Data - checking",
            details: JSON.stringify(inventoryData)
        });

        var apiStatus = sendData(inventoryData);

        log.debug({
            title: "API Response",
            details: JSON.stringify(apiStatus)
        });
    }


    function sendData(body) {

        var token = tokenModule.generateToken();

        if (!token) {
            return {
                success: false,
                error: "Token generation failed"
            };
        }

        try {

            var response = https.post({
                url: 'https://api.jyswms.com/netsuite/updates-inventory',
                body: JSON.stringify(body),
                headers: {
                    'Authorization': 'Bearer ' + token,
                    'Content-Type': 'application/json'
                }
            });

            var raw = response.body ? response.body : "";
            var success = (response.code === 200);

            return {
                success: success,
                response: raw
            };

        } catch (e) {

            log.error({
                title: "sendData Error",
                details: e
            });

            return {
                success: false,
                error: e.message ? e.message : e
            };
        }
    }


    return {
        getItemInventorydata: getItemInventorydata
    };

});