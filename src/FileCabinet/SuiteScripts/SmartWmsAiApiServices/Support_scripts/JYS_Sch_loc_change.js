/**
 * @NApiVersion 2.1
 * @NScriptType ScheduledScript
 */
define(['N/search', 'N/record', 'N/log', 'N/runtime'], 
(search, record, log, runtime) => {

    const CHECKBOX_FIELD_ID = 'custbody_jyswms_loc_updated';

    const execute = (context) => {

        try {

            log.debug('Script Started', 'Creating Search');

            const salesorderSearchObj = search.create({
                type: search.Type.SALES_ORDER,
                filters: [
                    ["type","anyof","SalesOrd"],
                    "AND",
                    ["mainline","is","F"],
                    "AND",
                    ["taxline","is","F"],
                    "AND",
                    ["shipping","is","F"],
                    "AND",
                    ["custcol_jyswms_issue","anyof","5"],
                    "AND",
                    ["custbody_jys_enabled_customer","is","T"],
                    "AND",
                    ["formulanumeric: NVL({quantityuom},0)-NVL({quantityshiprecv},0)","notequalto","0"],
                    "AND",
                    ["trandate","onorafter","1/1/2026"],
                    "AND",
                    ["status","noneof","SalesOrd:G","SalesOrd:C","SalesOrd:H"],
                    "AND",
                    ["closed","is","F"],
                    "AND",
                    ["custbody_jyswms_enable_auto_loc_chng","is","T"]
                ],
                columns: [
                    search.createColumn({ name: "internalid", summary: "GROUP" })
                ]
            });

            const pagedData = salesorderSearchObj.runPaged({ pageSize: 1000 });

            log.debug('Total Results', pagedData.count);

            for (let i = 0; i < pagedData.pageRanges.length; i++) {

                const page = pagedData.fetch({ index: i });

                for (let j = 0; j < page.data.length; j++) {

                    const result = page.data[j];
                    const soId = result.getValue({ 
                        name: 'internalid', 
                        summary: 'GROUP' 
                    });

                    try {

                        // Governance protection
                        if (runtime.getCurrentScript().getRemainingUsage() < 200) {
                            log.audit('Low Governance', 'Stopping execution early');
                            return;
                        }

                        log.debug('Processing SO', soId);

                        const soRecord = record.load({
                            type: record.Type.SALES_ORDER,
                            id: soId,
                            isDynamic: false
                        });

                        soRecord.setValue({
                            fieldId: CHECKBOX_FIELD_ID,
                            value: false
                        });

                        const savedId = soRecord.save({
                            enableSourcing: false,
                            ignoreMandatoryFields: true
                        });

                        log.audit('Updated SO', savedId);

                    } catch (soError) {

                        log.error({
                            title: `Error Processing SO ${soId}`,
                            details: soError
                        });

                    }
                }
            }

            log.debug('Script Completed', 'Finished processing records');

        } catch (error) {

            log.error({
                title: 'Fatal Error',
                details: error
            });

        }
    };

    return { execute };

});