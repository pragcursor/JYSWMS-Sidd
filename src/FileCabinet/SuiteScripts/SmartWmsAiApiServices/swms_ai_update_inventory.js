/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/ui/serverWidget', 'N/record', 'N/search', 'N/runtime', 'N/https', 'N/log', './Inventory/inventoryUtils'],
    function (serverWidget, record, search, runtime, https, log, inventoryUtils) {

        const ITEM_TYPES = new Set([
            'inventoryitem', 'noninventoryitem', 'serviceitem',
            'assemblyitem', 'downloaditem', 'giftcertificateitem', 'kititem'
        ]);

        function afterSubmit(context) {
            try {
                let itemIds = [];
                let rec, recType;

                const isDelete = context.type === context.UserEventType.DELETE;

                if (isDelete) {
                    rec = context.oldRecord;
                    recType = rec.type;
                } else {
                    rec = context.newRecord;
                    recType = rec.type;
                }

                if (ITEM_TYPES.has(recType)) {
                    // Single item record saved — just push its own ID
                    itemIds.push(rec.id.toString());

                } else if (recType === 'itemreceipt') {
                    // Item Receipt uses 'item' sublist with field 'item'
                    itemIds = collectItemIdsFromSublist(rec, 'item', 'item');

                } else {
                    // Bin Transfer, Inventory Adjustment, Inventory Part etc.
                    // all use 'inventory' sublist with field 'item'
                    itemIds = collectItemIdsFromSublist(rec, 'inventory', 'item');
                }

                if (itemIds.length) {
                    log.debug("afterSubmit - Processing", { recType, recId: rec.id, itemCount: itemIds.length });
                    processInventory(itemIds);
                }

            } catch (e) {
                log.error("afterSubmit Error", {
                    name: e.name || "SCRIPT_ERROR",
                    message: e.message || e.toString(),
                    stack: e.stack
                });
            }
        }

        /**
         * Reads a sublist and returns deduplicated item IDs
         */
        function collectItemIdsFromSublist(rec, sublistId, fieldId) {
            try {
                const lineCount = rec.getLineCount({ sublistId });
                const seen = new Set();
                const ids = [];

                for (let i = 0; i < lineCount; i++) {
                    const itemId = rec.getSublistValue({ sublistId, fieldId, line: i });
                    if (itemId && !seen.has(itemId.toString())) {
                        seen.add(itemId.toString());
                        ids.push(itemId.toString());
                    }
                }

                log.debug("collectItemIdsFromSublist", { sublistId, lineCount, uniqueItems: ids.length });
                return ids;

            } catch (e) {
                log.error("collectItemIdsFromSublist Error", { sublistId, message: e.message });
                return [];
            }
        }

        /**
         * Fetches inventory for given item IDs and sends to external API
         */
        function processInventory(itemIds) {
            try {
                const inventoryData = inventoryUtils.getInventory({ itemIds }, 1000, 0);

                if (!inventoryData || inventoryData.status !== 200) {
                    log.error("processInventory - Bad inventory response", inventoryData);
                    return;
                }

                // Use sendData from inventoryUtils to avoid duplicating token logic
                const apiStatus = sendData(inventoryData); 


              //  log.error("processInventory - API Response", apiStatus);

            } catch (e) {
                log.error("processInventory Error", e.message);
            }
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
                    url: 'https://api.jyswms.com/netsuite/updates-inventory',
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