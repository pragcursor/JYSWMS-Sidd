/**
 * @NApiVersion 2.1
 * @NScriptType ScheduledScript
 */

define(['N/runtime', 'N/search',  'N/record', 'N/https', 'N/task', 'N/email', './forceFullfillOrders/forceFullFillorder'], function (runtime, search,record, https, task, email, fulfillorder) {

    function execute(context) {

         var soId = runtime.getCurrentScript().getParameter({
            name: 'custscript_so_internalid'
        });

        log.audit('Processing SO', soId);

      
if(!soId) {
      soId ="62399497";
}

      var response = fulfillorder.fullFillOrder(soId);

    record.submitFields({
    type: record.Type.SALES_ORDER,
    id: soId,
    values: {
        custbody_trigger_schdule_script: true
    },
    options: {
        enableSourcing: false,
        ignoreMandatoryFields: true
    }
});
  
        // email.send({
        //     author: runtime.getCurrentUser().id,
        //     recipients: 'sram@pragadastech.com',
        //     subject: 'Script Triggered',
        //     body: 'Processed Orders'+ soId
        // });

    }

    return{
        execute: execute
    }

})