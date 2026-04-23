/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * 
 * This script is used to sync the AMXL records to the database.
 * */
define(['N/record', 'N/search', 'N/log', '/SuiteScripts/SmartWmsAiApiServices/Orders/orderUtils'], function (record, search, log, orderUtils) {
    function afterSubmit(context) {
      //  log.error('After Submit', context);
        var newRecord = context.newRecord;
        var recordId = newRecord.id;
        var customerId = newRecord.getValue({ fieldId: 'entity' });
        var jysendbled = newRecord.getValue({ fieldId: 'custbody_jys_enabled_customer' });
        if(!jysendbled){
            log.error('Customer is not enabled for JYS', customerId);
            return;
        }
        var status = newRecord.getValue({ fieldId: 'status' });
        var status_excluded = ['Closed', 'Cancelled', 'Billed'];
        if(status_excluded.includes(status.toLowerCase())){
            return;
        }
        if(customerId == 505){
            var payload = {
                salesOrderHeaderId: recordId,
            }
            var response = orderUtils.getAmzlOrders(payload, 1000, 0);
            log.error('Response', response);
        }
    }
    return {
        afterSubmit: afterSubmit
    }
})