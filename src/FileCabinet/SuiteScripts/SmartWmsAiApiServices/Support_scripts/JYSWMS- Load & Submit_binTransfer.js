/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 */
define(['N/record', 'N/log', 'N/search'],
  (record, log, search) => {

    var onRequest = (context) => {
      context.response.setHeader({
        name: 'Content-Type',
        value: 'application/json'
      });

      let result = { success: false, message: '', updatedId: null, processedRecords: [] };

      try {
        // Reads directly from URL params (no JSON body required)
        var params = context.request.parameters;
        var recId = params.record_id;
        var recType = 'bintransfer';

        if (!recId || !recType) {
          throw new Error('Missing URL params: record_id and record_type');
        }

        var binTransferObj = record.load({
          type: recType,
          id: parseInt(recId, 10)
        });
        var salesOrderId = binTransferObj.getValue({ fieldId: "custbody_realted_sales_order" });
        binTransferObj.save({
          enableSourcing: true,
          ignoreMandatoryFields: true
        });
        var salesOrderObj = record.load({
          type: "salesorder",
          id: parseInt(salesOrderId, 10)
        });
        var shdValue = salesOrderObj.getValue({ fieldId: "custbody_shipping_details_header" });
        if (!shdValue) {
          salesOrderObj.save({
            enableSourcing: true,
            ignoreMandatoryFields: true
          });
        }
        //  result.processedRecords.push({ type: recType, id: recId });

        var customrecord_shipping_details_recordSearchObj = search.create({
          type: "customrecord_shipping_details_record",
          filters:
            [
              ["custrecord_related_bin_transfer", "anyof", recId]
            ],
          columns:
            [
              search.createColumn({ name: "custrecord_ship_detail_hdr_link", label: "Ship Details Header Link" })
            ]
        });
        var searchResultCount = customrecord_shipping_details_recordSearchObj.runPaged().count;
        log.debug("customrecord_shipping_details_recordSearchObj result count", searchResultCount);
        customrecord_shipping_details_recordSearchObj.run().each(function (searchResult) {
          var shipDetailHdrId = searchResult.getValue({ name: "custrecord_ship_detail_hdr_link" });
          var recordId = searchResult.id;

          log.debug("shipDetailHdrId", shipDetailHdrId);
          log.debug("recordId", recordId);

          var shdLineObj = record.load({
            type: "customrecord_shipping_details_record",
            id: recordId
          });

          shdLineObj.save({
            enableSourcing: true,
            ignoreMandatoryFields: true
          });
          //  result.processedRecords.push({ type: "customrecord_shipping_details_record", id: recordId });

          var shdHdrObj = record.load({
            type: "customrecord_nets_shipping_details_head",
            id: shipDetailHdrId
          });

          shdHdrObj.save({
            enableSourcing: true,
            ignoreMandatoryFields: true
          });
          //    result.processedRecords.push({ type: "customrecord_nets_shipping_details_head", id: shipDetailHdrId });

          log.audit('Success', `Type: ${recType}, ID: ${recId} -> shipping_detail: ${recordId}, ship_header: ${shipDetailHdrId}`);
        });
        if (searchResultCount == 0) {

          var customrecord_nets_shipping_details_headSearchObj = search.create({
            type: "customrecord_nets_shipping_details_head",
            filters:
              [
                ["custrecord_sh_salesorder_id", "anyof", salesOrderId]
              ],
            columns:
              [
                search.createColumn({ name: "custrecord_lines_created", label: "Lines Created" })
              ]
          });
          var searchResultCount = customrecord_nets_shipping_details_headSearchObj.runPaged().count;
          log.debug("customrecord_nets_shipping_details_headSearchObj result count", searchResultCount);
          customrecord_nets_shipping_details_headSearchObj.run().each(function (result) {
            var linesCreated = result.getValue({ name: "custrecord_lines_created" });
            shipDetailHdrId = result.id;
            if (!linesCreated) {
              var shdHdrObj = record.load({
                type: "customrecord_nets_shipping_details_head",
                id: shipDetailHdrId
              });
              shdHdrObj.setValue({ fieldId: "custrecord_trigger_lines_creation", value: true });
              var updatedHdrId = shdHdrObj.save({
                enableSourcing: true,
                ignoreMandatoryFields: true
              });

              customrecord_shipping_details_recordSearchObj = search.create({
                type: "customrecord_shipping_details_record",
                filters:
                  [
                    ["custrecord_related_bin_transfer", "anyof", updatedHdrId]
                  ],
                columns:
                  [
                    search.createColumn({ name: "custrecord_ship_detail_hdr_link", label: "Ship Details Header Link" })
                  ]
              });
              var searchResultCount = customrecord_shipping_details_recordSearchObj.runPaged().count;
              log.debug("customrecord_shipping_details_recordSearchObj result count", searchResultCount);
              customrecord_shipping_details_recordSearchObj.run().each(function (searchResult) {
                var shipDetailHdrId = searchResult.getValue({ name: "custrecord_ship_detail_hdr_link" });
                var recordId = searchResult.id;

                log.debug("shipDetailHdrId", shipDetailHdrId);
                log.debug("recordId", recordId);

                var shdLineObj = record.load({
                  type: "customrecord_shipping_details_record",
                  id: recordId
                });

                shdLineObj.save({
                  enableSourcing: true,
                  ignoreMandatoryFields: true
                });
                //  result.processedRecords.push({ type: "customrecord_shipping_details_record", id: recordId });

                var shdHdrObj = record.load({
                  type: "customrecord_nets_shipping_details_head",
                  id: shipDetailHdrId
                });

                shdHdrObj.save({
                  enableSourcing: true,
                  ignoreMandatoryFields: true
                });
                //  result.processedRecords.push({ type: "customrecord_nets_shipping_details_head", id: shipDetailHdrId });

                log.audit('Success', `Type: ${recType}, ID: ${recId} -> shipping_detail: ${recordId}, ship_header: ${shipDetailHdrId}`);
              });

              //  result.processedRecords.push({ type: "customrecord_nets_shipping_details_head", id: shipDetailHdrId });
            }
            // .run().each has a limit of 4,000 results
            return true;
          });
        }

        var binTransferObj = record.load({
          type: recType,
          id: parseInt(recId, 10)
        });

        binTransferObj.save({
          enableSourcing: true,
          ignoreMandatoryFields: true
        });
        log.error('final BT', recId)
        result = {
          success: true,
          message: `Updated ${recType} ${recId}`,
          updatedId: recId,
          processedRecords: result.processedRecords
        };

      } catch (e) {
        log.error('Error', e.message);
        result.message = e.message;
      }
      context.response.write(JSON.stringify(result));
    };

    return { onRequest };
  });
