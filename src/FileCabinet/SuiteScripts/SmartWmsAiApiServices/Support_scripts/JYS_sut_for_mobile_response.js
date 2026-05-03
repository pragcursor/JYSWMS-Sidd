/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 */
define(['N/record', 'N/log'],
    (record, log) => {

        const onRequest = (context) => {
            context.response.setHeader({
                name: 'Content-Type',
                value: 'application/json'
            });

            var result = { success: false, message: '', updatedId: null };

            try {
                const params = context.request.parameters;

                const recId = params.record_id;

                if (!recId) {
                    throw new Error('Missing URL param: record_id');
                }



                const jy_api_search = search.create({
                    type: "customrecord_wms_ai_api_custom_rec",
                    filters:
                        [
                            ["custrecordwms_ai_api_custrec_portalid", "is", String(recId)]
                        ],
                    columns:
                        [
                            search.createColumn({ name: "name", label: "ID" }),
                            search.createColumn({ name: "custrecordwms_ai_api_custrec_action", label: "Action" }),
                            search.createColumn({ name: "custrecordwms_ai_api_custrec_rel_trans", label: "Related Transactions#" }),
                        ]
                });
                var obj = {};
                jy_api_search.run().each(function (result) {
                    obj.id = result.getValue({ name: "name", label: "ID" });
                    obj.action = result.getValue({ name: "custrecordwms_ai_api_custrec_action", label: "Action" });
                    obj.rel_trans = result.getValue({ name: "custrecordwms_ai_api_custrec_rel_trans", label: "Related Transactions#" });
                    return true;
                });


                if (Object.keys(obj).length === 0) {
                    throw new Error('No record found for the given record_id');
                } else {
                    result = {
                        success: true,
                        message: 'Data retrieved successfully',
                        updatedId: obj.id,
                        action: obj.action,
                        rel_trans: obj.rel_trans
                    };
                }
            } catch (e) {
                log.error('Error', e.message);
                result.message = e.message;
            }

            context.response.write(JSON.stringify(result));
        };

        return { onRequest };
    });