/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/ui/serverWidget', 'N/record', 'N/search', 'N/runtime', 'N/https', 'N/log', './Inventory/inventoryUtils'],
    function (serverWidget, record, search, runtime, https, log, inventoryUtils) {

        const ITEM_TYPES = [
            'inventoryitem', 'noninventoryitem', 'serviceitem',
            'assemblyitem', 'downloaditem', 'giftcertificateitem', 'kititem'
        ];

        function afterSubmit(context) {
            try {
                let itemIds = [];
                let recId, recType, rec;

                if (context.type === context.UserEventType.DELETE) {

                    recId = context.oldRecord.id;
                    recType = context.oldRecord.type;
                    rec = context.oldRecord;

                    log.debug("Record Info (DELETE)", { recId, recType });

                    if (ITEM_TYPES.includes(recType)) {
                        itemIds.push(recId.toString());
                    }
                    else if (recType == 'itemreceipt') {

                        log.debug("itemreceipt - (Delete)", { recId, recType });
                        itemIds = collectItemIdsFromSublist(recId, recType, 'item', 'item', rec);

                    }
                    else {
                        itemIds = collectItemIdsFromSublist(recId, recType, 'inventory', 'item', rec);
                    }

                } else {
                  
                    recId = context.newRecord.id || "";
                    recType = context.newRecord.type || "";
                    rec = context.newRecord;

                    // //log.debug("Record Info (CREATE/EDIT)", { recId, recType });

                    if (ITEM_TYPES.includes(recType)) {
                        // let oldRec = context.oldRecord;
                        // let newRec = context.newRecord;

                        // let oldL41 = oldRec.getValue({ fieldId: 'custitem_l41_inventory_on_hand' });
                        // let oldL60 = oldRec.getValue({ fieldId: 'custitem_l60_inventory_on_hand' });
                        // let newL41 = newRec.getValue({ fieldId: 'custitem_l41_inventory_on_hand' });
                        // let newL60 = newRec.getValue({ fieldId: 'custitem_l60_inventory_on_hand' });

                        // if (oldL41 !== newL41 || oldL60 !== newL60)
                        {
                            ////log.debug("Inventory Changed", { recId });
                            itemIds.push(recId.toString());
                        }
                       // return;
                    }

                    else if (recType === 'itemreceipt') {
                        log.error("itemreceipt - (CREATE/EDIT)", { recId, recType });
                        itemIds = collectItemIdsFromSublist(recId, recType, 'item', 'item', rec);

                    }
                    else {
                        itemIds = collectItemIdsFromSublist(recId, recType, 'inventory', 'item', rec);
                    }
                }

                // Final processing
                if (itemIds.length) {
                    log.debug("Record Info (CREATE/EDIT)", { recId, recType });
                    processInventory(itemIds);
                } else {
                    //log.debug("No Item IDs Found", { recId, recType });
                }

            } catch (e) {
                log.error("afterSubmit Error", {
                    name: e.name || "SCRIPT_ERROR",
                    message: e.message || e.toString(),
                    stack: e.stack
                });
                // optionally rethrow if you want NetSuite to stop the transaction
                // throw e;
            }
        }

        /** Collects item IDs from a given sublist */
        function collectItemIdsFromSublist(recId, recType, sublistId, fieldId, rec) {
            try {
                //  const rec = record.load({ id: recId, type: recType });
                const lineCount = rec.getLineCount({ sublistId });
                const ids = [];

                for (let i = 0; i < lineCount; i++) {
                    const itemId = rec.getSublistValue({ sublistId, fieldId, line: i });
                    if (itemId) ids.push(itemId.toString());
                }
                return ids;
            } catch (e) {
                log.error(`Error collecting item IDs from ${sublistId}`, e.message);
                return [];
            }
        }

        /** Fetches inventory & sends it to API */
        function processInventory(itemIds) {
            const params = { itemIds };
            //  //log.debug("Inventory Params", params);

            const inventoryData = inventoryUtils.getInventory(params, 1000, 0);
            //  //log.debug("Inventory Data", inventoryData);

            const apiStatus = sendData(inventoryData);
            log.error("API Response", apiStatus);
        }

        /** Authenticates & returns access token */
        function generateToken() {
            const url = 'https://api.jyswms.com/user/login';
            const creds = { "userid": "jyswms_integration_user", "password": "s9u[7zC720%pZr" };

            try {
                const response = https.post({
                    url,
                    body: JSON.stringify(creds),
                    headers: { 'Content-Type': 'application/json' }
                });

                const parsed = JSON.parse(response.body || "{}");
                if (parsed.access_token) {
                    return parsed.access_token;
                } else {
                    log.error("Token Generation Failed", parsed);
                    return null;
                }
            } catch (e) {
                log.error("generateToken Error", e.message);
                return null;
            }
        }

        /** Sends data to external API */
        function sendData(body) {
            const token = generateToken();
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
              
               // log.error(body,raw);
              
                const success = response.code === 200;
                return { success, response: raw };

            } catch (e) {
                log.error("sendData Error", e.message);
                return { success: false, error: e.message };
            }
        }

        function beforeLoad(context) {

            // RMA only
            if (context.newRecord.type !== 'returnauthorization') {
                return;
            }

            // View mode only
            if (context.type !== context.UserEventType.VIEW) {
                return;
            }

            var rec = context.newRecord;
            var form = context.form;

            var Image_array = rec.getValue({ fieldId: 'custbody_jyswms__returns_captured_url' });



            // Add Subtab
            var subtab = form.addSubtab({
                id: 'custpage_rma_images_subtab',
                label: 'RMA Item Images'
            });

            var custom_status = rec.getValue({ fieldId: 'custbody_jyswms_rma_status' });
            if (custom_status) {
                ////log.debug("RMA Custom Status", custom_status);
                var statusField = form.addField({
                    id: 'custpage_rma_status',
                    type: serverWidget.FieldType.INLINEHTML,
                    label: 'JYSWMS - RMA Status'
                });

                var bgColor = '#ccc'; // default fallback
                var textColor = '#ffffff';

                if (custom_status === 'RE-SALE') {
                    bgColor = '#4d8d57'; // green
                } else if (custom_status === 'DAMAGE') {
                    bgColor = '#e24f4f'; // red
                }

                statusField.defaultValue = `
                <div style="
                    margin-top:10px;
                    margin-bottom:20px;
                    display:inline-block;
                    padding:6px 14px;
                    font-size:14px;
                    font-weight:600;
                    color:${textColor};
                    background-color:${bgColor};
                    border-radius:14px;
                    white-space:nowrap;
                 ">
                    RMA JYSWMS Status: ${custom_status}
                    </div>
                 `;

                statusField.updateLayoutType({
                    layoutType: serverWidget.FieldLayoutType.OUTSIDEABOVE
                });
            }
            if (!Image_array || Image_array.indexOf('Item:') === -1) {
                return;
            }
            // Add Inline HTML field
            var htmlField = form.addField({
                id: 'custpage_rma_images_html',
                type: serverWidget.FieldType.INLINEHTML,
                label: 'Images',
                container: 'custpage_rma_images_subtab'
            });

            // Normalize wrapped text
            Image_array = Image_array.replace(/\s+/g, ' ').trim();

            // Split by Item:
            var itemBlocks = Image_array.split(/Item:/).filter(Boolean);

            var html = `
            <style>
                .item-block {
                    margin-bottom: 24px;
                    padding: 12px;
                    border: 1px solid #ddd;
                    border-radius: 6px;
                }
                .item-title {
                    font-weight: bold;
                    margin-bottom: 10px;
                    font-size: 14px;
                }
                .image-grid {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 12px;
                }
                .image-grid img {
                    width: 150px;
                    height: 150px;
                    object-fit: cover;
                    border: 1px solid #ccc;
                    border-radius: 4px;
                }
            </style>
        `;

            // Process each item
            itemBlocks.forEach(function (block) {

                var parts = block.trim().split(' ');

                // First value is item name
                var itemName = parts.shift();

                // Remaining values are URLs
                var imageUrls = parts.filter(function (val) {
                    return val.startsWith('http');
                }).slice(0, 6); // max 6 images

                if (!imageUrls.length) {
                    return;
                }

                html += `
                <div class="item-block">
                    <div class="item-title">
                        Item: ${itemName} — Below are the images
                    </div>
                    <div class="image-grid">
            `;

                imageUrls.forEach(function (url) {
                    // html += `<img src="${url}" />`;
                    html += `
                    <a href="${url}" target="_blank" download>
                        <img src="${url}" alt="RMA Image" />
                    </a>
                `;
                });

                html += `
                    </div>
                </div>
            `;
            });

            htmlField.defaultValue = html;
        }

        return {
            afterSubmit: afterSubmit,
            beforeLoad: beforeLoad
        };
    });