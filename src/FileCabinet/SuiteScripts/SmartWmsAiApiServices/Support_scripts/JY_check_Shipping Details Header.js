/**
 *@NApiVersion 2.x
 *@NScriptType UserEventScript
 */
define(['N/search', 'N/record'], function (search, record) {

    function afterSubmit(context) {
        try {
            // Only proceed for Create or Edit events
            if(context.type !== context.UserEventType.CREATE) {
                return;
            }
            var newRecord = context.newRecord;
            var recordId = newRecord.id;
            var recordType = newRecord.type;
            if (recordType === 'customrecord_nets_shipping_details_head') {
                var cusId = newRecord.getValue({ fieldId: 'custrecord_jy_so_customer' });
                if (cusId) {
                    var custLookup = search.lookupFields({
                        type: search.Type.CUSTOMER,
                        id: cusId,
                        columns: ['custentity_jyswms_enable']
                    });
                    var enableWMS = custLookup.custentity_jyswms_enable;
                    if (enableWMS === true) {
                        log.audit({ title: 'WMS Enable Status', details: 'Customer ID: ' + cusId + ', Enable WMS: ' + enableWMS });

                        var soload = record.load({
                            type: 'customrecord_nets_shipping_details_head',
                            id: recordId,
                            isDynamic: true
                        });
                        var soLinesCount = soload.getLineCount({ sublistId: 'recmachcustrecord_ship_detail_hdr_link' });
                        for (var i = soLinesCount - 1; i >= 0; i--) {
                            soload.removeLine({
                                sublistId: 'recmachcustrecord_ship_detail_hdr_link',
                                line: i,
                                ignoreRecalc: true
                            });
                        }
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
