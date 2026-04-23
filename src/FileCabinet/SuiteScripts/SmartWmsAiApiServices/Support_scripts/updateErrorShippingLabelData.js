    /**
     * @NApiVersion 2.1
     * @NScriptType Suitelet
     */
    define(['N/ui/serverWidget', 'N/search', 'N/log', 'N/record'], (ui, search, log, record) => {

        const onRequest = (context) => {

            try {

                if (context.request.method === 'GET') {

                    const form = ui.createForm({ title: 'Update Shipping JSON' });

                    form.addField({
                        id: 'custpage_slip_id',
                        type: ui.FieldType.TEXT,
                        label: 'Slip ID'
                    });

                    form.addSubmitButton({
                        label: 'Update JSON'
                    });

                    context.response.writePage(form);

                } else {

                    const slipId = context.request.parameters.custpage_slip_id;

                    if (!slipId) {
                        throw new Error('Slip ID is required.');
                    }

                    let updatedJsonArray = [];

                    try {

                        // 🔍 FIRST SEARCH
                        const firstSearch = search.create({
                            type: "customrecord_picker_session_lines_record",
                            filters: [
                                ["custrecord_slip_id_search", "contains", slipId]
                            ],
                            columns: [
                                "custrecord_picking_label_json", 'internalid','custrecord_bulk_pick_lines_info_link'
                            ],
                        });

                        firstSearch.run().each(result => {

                            let internalId = result.id;

                            try {

                                let jsonString = result.getValue("custrecord_picking_label_json");
                                var bulkPickingLine = result.getValue("custrecord_bulk_pick_lines_info_link");
                                log.error('bulkPickingLine', bulkPickingLine);
                                if (!jsonString) {
                                    var fieldsData = search.lookupFields({
                                        type: "customrecord_wms_bulkpick_lines",
                                        id: bulkPickingLine,
                                        columns: ["custrecord_wms_bulk_pick_json_data"]
                                    });

                                    var jsonData = fieldsData.custrecord_wms_bulk_pick_json_data;
                                    jsonString = jsonData;
                                }

                                let parsedJson;

                                try {
                                    parsedJson = JSON.parse(jsonString);
                                } catch (e) {
                                    log.error('Invalid JSON', jsonString);
                                    return true;
                                }

                                if (!Array.isArray(parsedJson)) {
                                    parsedJson = [parsedJson];
                                }

                                parsedJson.forEach(obj => {

                                    try {

                                        const trackingNumber = obj.trackingNumber;
                                        if (!trackingNumber) return;

                                        let imageData = null;

                                        try {
                                            const secondSearch = search.create({
                                                type: "customrecord_shipping_details_record",
                                                filters: [
                                                    ["custrecord_tracking_number", "is", trackingNumber]
                                                ],
                                                columns: [
                                                    "custrecord_image_html_base64"
                                                ]
                                            });

                                            secondSearch.run().each(res => {
                                                imageData = res.getValue("custrecord_image_html_base64");
                                                return false;
                                            });

                                        } catch (searchError) {
                                            log.error(`Search failed for ${trackingNumber}`, searchError);
                                        }

                                        if (imageData) {
                                            obj.shippingLabelData = imageData;
                                        }

                                    } catch (objError) {
                                        log.error('Error processing object', objError);
                                    }

                                });

                                // ✅ SUBMIT PER RECORD (correct place)
                                try {
                                    record.submitFields({
                                        type: "customrecord_picker_session_lines_record",
                                        id: internalId,
                                        values: {
                                            custrecord_picking_label_json: JSON.stringify(parsedJson)
                                        },
                                        options: {
                                            enableSourcing: false,
                                            ignoreMandatoryFields: true
                                        }
                                    });

                                } catch (submitError) {
                                    log.error(`Submit failed for record ${internalId}`, submitError);
                                }

                            } catch (recordError) {
                                log.error('Error processing record', recordError);
                            }

                            return true;
                        });

                    } catch (firstSearchError) {
                        log.error({
                            title: 'First Search Failed',
                            details: firstSearchError
                        });
                        throw firstSearchError;
                    }

                    const form = ui.createForm({ title: 'Update Shipping JSON' });

                    // ✅ Success message (green)
                    form.addField({
                        id: 'custpage_success_msg',
                        type: ui.FieldType.INLINEHTML,
                        label: 'Success'
                    }).defaultValue = `
        <div style="color:green; font-size:16px; font-weight:bold;">
            ✅ Success! JSON updated successfully.
        </div>
        <br/>
    `;

                    // ✅ Add new Slip ID field again
                    form.addField({
                        id: 'custpage_slip_id',
                        type: ui.FieldType.TEXT,
                        label: 'Enter New Slip ID'
                    });

                    // ✅ Button
                    form.addSubmitButton({
                        label: 'Update JSON'
                    });

                    context.response.writePage(form);
                }

            } catch (mainError) {

                log.error({
                    title: 'Suitelet Fatal Error',
                    details: mainError
                });

                const form = ui.createForm({ title: 'Error' });

                form.addField({
                    id: 'custpage_error',
                    type: ui.FieldType.INLINEHTML,
                    label: 'Error'
                }).defaultValue = `<div style="color:red;">${mainError.message}</div>`;

                context.response.writePage(form);
            }
        };

        return { onRequest };
    });