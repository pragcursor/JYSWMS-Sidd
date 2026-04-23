/**
 *@NApiVersion 2.1
 *@NScriptType UserEventScript
 */
define(['N/search', 'N/record'], function (search, record) {

    function afterSubmit(context) {
        try {
            // Only proceed for Create or Edit events
            // if (context.type !== context.UserEventType.CREATE) {
            //     return;
            // }
            var newRecord = context.newRecord;
            var recordId = newRecord.id;
            var recordType = newRecord.type;

            if (recordType == 'customrecord_nets_shipping_details_head') {
                var soId = newRecord.getValue({ fieldId: 'custrecord_sh_salesorder_id' });
                if(!soId) {
                    return;
                }
                var so_lookup = search.lookupFields({
                    type: search.Type.SALES_ORDER,
                    id: soId,
                    columns: ['custbody_jys_enabled_customer']
                });
                var jyswmsEnable = so_lookup.custbody_jys_enabled_customer;
                log.error('jyswmsEnable', jyswmsEnable)
                if (jyswmsEnable == true || jyswmsEnable == "T") {

                    var soload = record.load({
                        type: 'customrecord_nets_shipping_details_head',
                        id: recordId,
                        isDynamic: true
                    });
                    var soLinesCount = soload.getLineCount({ sublistId: 'recmachcustrecord_ship_detail_hdr_link' });
                    var partsitem = false;
                    for (var i = soLinesCount - 1; i >= 0; i--) {
                        var itemId = soload.getSublistValue({
                            sublistId: 'recmachcustrecord_ship_detail_hdr_link',
                            fieldId: 'custrecord_shipping_record_item',
                            line: i
                        });
                        if (itemId !== 57740) {
                            log.audit({ title: 'Removing Line', details: 'Removing line with Item ID: ' + itemId + ' from record ID: ' + recordId });
                            soload.removeLine({
                                sublistId: 'recmachcustrecord_ship_detail_hdr_link',
                                line: i,
                                ignoreRecalc: true
                            });
                        } else if (itemId == 57740) {
                            partsitem = true;
                        }

                    }
                    if (!partsitem) {
                        soload.setValue({
                            fieldId: 'isinactive',
                            value: true
                        });
                        soload.save({
                            enableSourcing: true,
                            ignoreMandatoryFields: true
                        });
                        log.audit({ title: 'WMS Enabled - Cleared Lines', details: 'Cleared lines for record ID: ' + recordId });

                    }

                }

            }
        } catch (error) {
            log.error({ title: 'After Submit Error', details: error });
        }
    }

    return {
        afterSubmit: afterSubmit
    }
});