/**
  *  @NApiVersion 2.1
  * @NScriptType Suitelet
  */

define(['N/record', 'N/search', 'N/log', 'N/https', '/SuiteScripts/SmartWmsAiApiServices/Orders/orderUtils'], function (record, search, log, https, orderUtils) {
    function onRequest(context) {
        log.debug('Suitelet called', context.request.parameters);
        var salesOrderId = context.request.parameters.salesOrderId;
        var payLoad = {
            salesOrderHeaderId: salesOrderId,
        };
      var pageSize = 1000;
      var startIndex = 0;
      log.audit("salesOrderHeaderId",payLoad);
        if (salesOrderId) {
            var OrderData = orderUtils.getDropShipOrders(payLoad, pageSize, startIndex);
            log.debug('OrderData', JSON.stringify(OrderData));

        }

    }
    return {
        onRequest: onRequest
    }
})