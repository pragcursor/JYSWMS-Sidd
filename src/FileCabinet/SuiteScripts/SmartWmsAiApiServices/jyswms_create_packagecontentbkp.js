/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/record', 'N/log', 'N/search'], function (record, log, search) {

    function afterSubmit(context) {
        try {
            if (context.type === context.UserEventType.DELETE) return;

            var newRec = context.newRecord;
            var recordId = newRec.id;
            var isApproved = newRec.getValue('custrecord_jyswms_approved');
            var itemFulfill = newRec.getValue('custrecord_jyswms_rel_item_ful');
            var salesOrderId = newRec.getValue('custrecord_jyswms_sales_order_id');
            var carrierProNumber = newRec.getValue('custrecord_jyswms_carrier_pro_number');
            var isPackageUpdated = newRec.getValue('custrecord_jyswms_package_updated');
            var isAmazonUpdated = newRec.getValue('custrecord_jyswms_amzcc_updated');
            var isUpsPackageUpdated = newRec.getValue('custrecord_jswms_order_ups_packges');
            var shipVia = newRec.getValue('custrecord_jyswms_order_ship_via');
          
      if (!shipVia || shipVia != 57733) {

          if (itemFulfill) {
            log.error(" fedex");

         var trackingObj =  trackingLines(recordId);

if (!isUpsPackageUpdated){
   log.error(" isUpsPackageUpdated");
    var updatedRecord =   createPackages(trackingObj, itemFulfill);

   record.submitFields({
                type: 'customrecord_order_fulfillment_details',
                id: recordId,
                values: {
                    custrecord_jswms_order_ups_packges: true
                }
            });
 // return;
}
            
 if(!isPackageUpdated ) {

          var updatedRecord =   createPackageContent(trackingObj,itemFulfill);
 log.error(" isPackageUpdated",updatedRecord);
  
    record.submitFields({
                    type: 'customrecord_order_fulfillment_details',
                    id: recordId,
                    values: {
                        custrecord_jyswms_package_updated: true
                    }
                });
 // return;
}
            
  if (!isAmazonUpdated){
   log.error(" isAmazonUpdated");
    var updatedRecord =  createAmazonRecords(trackingObj,salesOrderId);
           // return;
}
            
          }
           return;
        
          }
            
        

            log.error('Trigger Info', { recordId, isApproved, itemFulfill,carrierProNumber, salesOrderId });

            
                var locationLookup = search.lookupFields({
                    type: search.Type.SALES_ORDER,
                    id: salesOrderId,
                    columns: ['location', 'entity']
                });
              
                var locationId = (locationLookup.location && locationLookup.location.length)
    ? locationLookup.location[0].value
    : null;

       var canadaCustomerId = (locationLookup.entity && locationLookup.entity.length)
    ? locationLookup.entity[0].value
    : null;


                // Collect line details
                var lines = [];
                var quantityLineCount = newRec.getLineCount({ sublistId: 'recmachcustrecord_sales_order_header' });
              
                for (var i = 0; i < quantityLineCount; i++) {
                    var itemId = newRec.getSublistValue({
                        sublistId: 'recmachcustrecord_sales_order_header',
                        fieldId: 'custrecord_jyswms_item',
                        line: i
                    });
                    var pickedQty = newRec.getSublistValue({
                        sublistId: 'recmachcustrecord_sales_order_header',
                        fieldId: 'custrecord_jyswms_item_picked_qty',
                        line: i
                    });
                    var binName = newRec.getSublistValue({
                        sublistId: 'recmachcustrecord_sales_order_header',
                        fieldId: 'custrecord_jyswms_item_picked_bin',
                        line: i
                    });

                    lines.push({
                        selected: true,
                        itemId: itemId,
                        weight: 0,
                        quantity: pickedQty,
                        locationId: locationId,
                        binId: binName,
                        bins: [{ binId: binName }]
                    });
                }

                // Get tracking data
                var trackingObj = trackingLines(recordId);
             var ssccCodes = trackingObj.map(t => t.ssccCode); // fixed property name

log.error('Tracking Info', 
    'Fulfillment ID: ' + itemFulfill + '\n' +
    'SSCC Codes: ' + JSON.stringify(ssccCodes, null, 2) + '\n' +
    'Tracking Object: ' + JSON.stringify(trackingObj, null, 2)
);

// Build final object
var obj = {};
obj[salesOrderId] = {
    salesOrderId: salesOrderId,   // safer explicit assignment
    lines: lines,
    trackingNumbers: trackingObj,
    ssccCodes: ssccCodes
};

// Separate, clearly labeled logs
log.error('Fulfillment SSCC Codes', JSON.stringify(ssccCodes, null, 2));
log.error('Fulfillment Object', JSON.stringify(obj, null, 2));

                 var packageIds = getInternalIdsBySsccCodes(ssccCodes);
log.error('packageIds Object', JSON.stringify(packageIds, null, 2));

                if (isApproved && salesOrderId && !itemFulfill) {
                    // Process fulfillment
                    //   var response = FullFillOrders(obj, recordId);
                    //log.error('response', JSON.stringify(response));
                }
              
               if ( (itemFulfill && !isPackageUpdated && carrierProNumber) || (salesOrderId == "60469154")  || (canadaCustomerId == "1807")  ) {

     // if ( (itemFulfill && !isPackageUpdated) || (salesOrderId == "60469154") ) {
          // createPackageRecords(trackingObj, itemFulfill);
                  log.error("pa records update ");
                  
        var res = createPackageRecords(ssccCodes,trackingObj,itemFulfill,carrierProNumber);
              log.error("res",res);

                 
        log.error("amazon records update ");
               var res = createAmazonRecords(trackingObj, salesOrderId);
                    log.error("res",res);

             
                }
     if ( (isPackageUpdated && !isAmazonUpdated && carrierProNumber && itemFulfill ) ||  (salesOrderId == "60469154") || (canadaCustomerId == "1807") ) {
                   log.error("amazon records update ");
               var res = createAmazonRecords(trackingObj, salesOrderId);
                    log.error("res",res);
                }
            
        } catch (e) {
            log.error('afterSubmit error', e.message);
        }
    }


   function createPackages(trackingObj, fulfillmentId){
    try {

        
        // 🔹 CASE 1: Create new package records if none found
      //  if (!packageIds || packageIds.length === 0) {
        //  log.error("packageIds.length - in ",packageIds.length );

            var fulfillmentRec = record.load({
                type: record.Type.ITEM_FULFILLMENT,
                id: fulfillmentId,
                isDynamic: true
            });

            var sublistId = 'package';
            var existingCount = fulfillmentRec.getLineCount({ sublistId });

            // Clear existing package lines
            for (var i = existingCount - 1; i >= 0; i--) {
                fulfillmentRec.removeLine({ sublistId, line: i });
            }

            // Add new package lines
            var packageBoxNumber = 0;
            var lastRecordId = null;

            trackingObj.forEach(function (line) {
                lastRecordId = line.recordId;
                packageBoxNumber++;

                fulfillmentRec.selectNewLine({ sublistId });

                var fieldMap = {
                    packageweight: line.weight,
                    packagetrackingnumber: line.tracking
                };

                Object.keys(fieldMap).forEach(function (fieldId) {
                    var value = fieldMap[fieldId];
                    if (value !== null && value !== '' && value !== undefined) {
                        try {
                            fulfillmentRec.setCurrentSublistValue({
                                sublistId: sublistId,
                                fieldId: fieldId,
                                value: value
                            });
                        } catch (err) {
                            log.debug('Skipped field', `${fieldId} - ${err.message}`);
                        }
                    }
                });

                fulfillmentRec.commitLine({ sublistId });
                log.error('Package line added', JSON.stringify(fieldMap));
            });

            fulfillmentRec.save({
                enableSourcing: true,
                ignoreMandatoryFields: true
            });

            log.audit('New Packages Created', `Fulfillment ID: ${fulfillmentId}`);
      //  }
        
    } catch (error) {
        log.error("error while updating create packaes",error.message)
    }
   }

  function createPackageContent(trackingObj,fulfillmentId){
    try {
       // if (!packageIds || packageIds.length === 0) {
       //    log.error("packageIds.length - ",packageIds.length );

            var fulfillmentRec = record.load({
                type: record.Type.ITEM_FULFILLMENT,
                id: fulfillmentId,
                isDynamic: true
            });

            var sublistId = 'recmachcustrecord_hj_packagecontents_sublist';
            var existingCount = fulfillmentRec.getLineCount({ sublistId });

            // Clear existing package lines
            for (var i = existingCount - 1; i >= 0; i--) {
                fulfillmentRec.removeLine({ sublistId, line: i });
            }

            // Add new package lines
            var packageBoxNumber = 0;
            var lastRecordId = null;

            trackingObj.forEach(function (line) {
                lastRecordId = line.recordId;
                packageBoxNumber++;

                fulfillmentRec.selectNewLine({ sublistId });

                var fieldMap = {
                    custrecordhj_pkg_pallet: line.palletNumber,
                    custrecordhj_pkgbox: packageBoxNumber,
                    custrecordhj_tc_packagecontentslbs: line.weight,
                    custrecordhj_ucc: line.ssccCode,
                    custrecordhj_pkg_trackingnumber: line.bolTrackingNumber,
                    custrecordhj_pkg_desc: line.itemName + '/1'
                };

                Object.keys(fieldMap).forEach(function (fieldId) {
                    var value = fieldMap[fieldId];
                    if (value !== null && value !== '' && value !== undefined) {
                        try {
                            fulfillmentRec.setCurrentSublistValue({
                                sublistId: sublistId,
                                fieldId: fieldId,
                                value: value
                            });
                        } catch (err) {
                            log.debug('Skipped field', `${fieldId} - ${err.message}`);
                        }
                    }
                });

                fulfillmentRec.commitLine({ sublistId });
                log.debug('Package line added', JSON.stringify(fieldMap));
            });

            fulfillmentRec.save({
                enableSourcing: true,
                ignoreMandatoryFields: true
            });

      

            log.audit('New Packages Created', `Fulfillment ID: ${fulfillmentId}`);
        //}
    } catch (error) {
      
    }
  }

  
    /** =========================
     *  Fulfillment Main Function
     *  ========================= */
    function FullFillOrders(jsonData, customRecId) {
        var results = {};

        for (var salesOrderKey in jsonData) {
            try {
                var orderData = jsonData[salesOrderKey];
                var salesOrderId = orderData.salesOrderId;

                // Create Item Fulfillment
                var fulfillmentId = createItemFulfillment(orderData);
                log.error("Fulfillment ID", fulfillmentId);



                // Update source custom record
                record.submitFields({
                    type: 'customrecord_order_fulfillment_details',
                    id: customRecId,
                    values: {
                        custrecord_jyswms_rel_item_ful: fulfillmentId,
                        custrecord_jyswms_status: 3,
                        custrecord_jyswms_error: ''
                    }
                });

                results[salesOrderId] = { success: true, fulfillmentId: fulfillmentId };

            } catch (e) {
                log.error("Error in FullFillOrders", e.message);
                record.submitFields({
                    type: 'customrecord_order_fulfillment_details',
                    id: customRecId,
                    values: {
                        custrecord_jyswms_error: e.message,
                        custrecord_jyswms_approved: false
                    }
                });
            }
        }
        return results;
    }

    /** =============================
     *  Function: createItemFulfillment
     *  ============================= */
    function createItemFulfillment(orderData) {
        var salesOrderId = orderData.salesOrderId;
        var itemMap = {};

        orderData.lines.forEach(function (line) {
            if (!itemMap[line.itemId]) itemMap[line.itemId] = { total: 0, bins: [] };
            itemMap[line.itemId].total += parseFloat(line.quantity) || 0;
            itemMap[line.itemId].bins.push({
                binId: line.binId,
                qty: parseFloat(line.quantity) || 0,
                locationId: line.locationId
            });
        });

        var fulfillment = record.transform({
            fromType: record.Type.SALES_ORDER,
            fromId: salesOrderId,
            toType: record.Type.ITEM_FULFILLMENT,
            isDynamic: true
        });

        var count = fulfillment.getLineCount({ sublistId: 'item' });
        for (var i = 0; i < count; i++) {
            fulfillment.selectLine({ sublistId: 'item', line: i });
            var itemId = fulfillment.getCurrentSublistValue({ sublistId: 'item', fieldId: 'item' });
            if (!itemMap[itemId]) continue;

            var itemData = itemMap[itemId];
            var bulkStageBin = (itemData.bins[0].locationId == 9) ? 4859 : 16692;

            fulfillment.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity', value: itemData.total });
            fulfillment.setCurrentSublistValue({ sublistId: 'item', fieldId: 'location', value: itemData.bins[0].locationId });

            var invDetail = fulfillment.getCurrentSublistSubrecord({ sublistId: 'item', fieldId: 'inventorydetail', create: true });
            invDetail.selectNewLine({ sublistId: 'inventoryassignment' });
            invDetail.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'binnumber', value: bulkStageBin });
            invDetail.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'quantity', value: itemData.total });
            invDetail.commitLine({ sublistId: 'inventoryassignment' });

            fulfillment.commitLine({ sublistId: 'item' });
        }

        var fulfillmentId = fulfillment.save();
        log.error('Item Fulfillment Created', fulfillmentId);
        return fulfillmentId;
    }



    /** ===========================
 *  Function: createAmazonRecords
 *  =========================== */
    function createAmazonRecords(trackingObj, salesOrderId) {
        try {
            if (!trackingObj || !trackingObj.length) {
                log.debug('No SSCC codes provided, skipping package creation');
                return;
            }
            const salesOrderRec = record.load({
                type: record.Type.SALES_ORDER,
                id: salesOrderId,
                isDynamic: true
            });

            const sublistId = 'recmachcustrecord_sales_order_id';

            // Remove any old packages
            /*    const existingCount = fulfillmentRec.getLineCount({ sublistId });
                for (let i = existingCount - 1; i >= 0; i--) {
                    fulfillmentRec.removeLine({ sublistId, line: i });
                }*/

          
            var recordId = ''
            // Add new packages
          
            var packageBoxNumber = 0;
            trackingObj.forEach(line => {
                recordId = line.recordId;
                salesOrderRec.selectNewLine({ sublistId });
                packageBoxNumber++;
                 var amzccCode  = line.ssccCode;
                amzccCode=amzccCode.toString()
                 amzccCode = amzccCode.slice(2);
                const fieldMap = {
                    custrecord_sales_order_id: salesOrderId,
                    custrecord_amzcc_code: amzccCode,
                    custrecord_itemid: line.itemName,
                    custrecord_ucc_code: line.upcCode,
                    custrecord_wms_bulkbatch_picking: 22306500,
                    custrecord_ponumber: line.poNumber,
                    custrecord_pallet_sscc_code: line.palletNumber,
                    custrecord_bol_tracking_number: line.bolTrackingNumber,
                    custrecord_trackingnumber: line.tracking
                };

                for (let fieldId in fieldMap) {
                    if (fieldMap[fieldId]) {
                        try {
                            salesOrderRec.setCurrentSublistValue({
                                sublistId,
                                fieldId,
                                value: fieldMap[fieldId]
                            });
                        } catch (err) {
                            log.debug('Skipped field', `${fieldId} - ${err.message}`);
                        }
                    }
                }
                log.error('Amazon Records', JSON.stringify(fieldMap));
                salesOrderRec.commitLine({ sublistId });
            });

            salesOrderRec.save({
                enableSourcing: true,
                ignoreMandatoryFields: true
            });

            log.error('Amazon Records linked successfully');

            record.submitFields({
                type: 'customrecord_order_fulfillment_details',
                id: recordId,
                values: {
                    custrecord_jyswms_amzcc_updated: true
                }
            });

        } catch (e) {
            log.error('Error linking Package Records', e.message);
        }
    }


   // function trackingLines(id) {
   //      var results = [];
   //      try {
   //          var trackingSearch = search.create({
   //              type: "customrecord_jyswms_sales_order_track",
   //              filters: [
   //                  ["custrecord_jyswms_track_so_id.mainline", "is", "T"],
   //                  "AND",
   //                  ["custrecord_jyswms_so_header", "anyof", id],
   //                  "AND", 
   //                  ["isinactive","is","T"]
   //              ],
   //              columns: [
   //                  "custrecord_jyswms_track_item",
   //                  "custrecord_jyswms_track_number",
   //                  "custrecord_jyswms_track_so_id",
   //                  "custrecord_jyswms_so_header",
   //                  "custrecord_jyswms_track_qty",
   //                  "custrecord_jyswms_track_uniqueid",
   //                  "custrecord_jyswms_track_pallet_number",
   //                  search.createColumn({ name: "weight", join: "CUSTRECORD_JYSWMS_TRACK_ITEM" }),
   //                  search.createColumn({ name: "upccode", join: "CUSTRECORD_JYSWMS_TRACK_ITEM" }),
   //                  search.createColumn({ name: "otherrefnum", join: "CUSTRECORD_JYSWMS_TRACK_SO_ID" }),
   //                  search.createColumn({ name: "custbody_bol_tracking_number", join: "CUSTRECORD_JYSWMS_TRACK_SO_ID" })

   //              ]
   //          });

   //          trackingSearch.run().each(function (res) {
   //              results.push({
   //                  item: res.getValue("custrecord_jyswms_track_item"),
   //                  itemName: res.getText("custrecord_jyswms_track_item"),
   //                  ssccCode: res.getValue("custrecord_jyswms_track_number"),
   //                  bolTrackingNumber: res.getValue({ name: 'custbody_bol_tracking_number', join: 'CUSTRECORD_JYSWMS_TRACK_SO_ID' }),
   //                  soHeader: res.getValue("custrecord_jyswms_so_header"),
   //                  qty: res.getValue("custrecord_jyswms_track_qty"),
   //                  uniqueId: res.getValue("custrecord_jyswms_track_uniqueid"),
   //                  palletNumber: res.getValue("custrecord_jyswms_track_pallet_number"),
   //                  weight: res.getValue({ name: 'weight', join: 'CUSTRECORD_JYSWMS_TRACK_ITEM' }),
   //                  upcCode: res.getValue({ name: 'upccode', join: 'CUSTRECORD_JYSWMS_TRACK_ITEM' }),
   //                  poNumber: res.getValue({ name: 'otherrefnum', join: 'CUSTRECORD_JYSWMS_TRACK_SO_ID' }),
   //                  recordId: id
   //              });
   //              return true;
   //          });

   //      } catch (e) {
   //          log.error("Error in trackingLines", e.message);
   //      }
   //      return results;
   //  }


  /**
 * Create or link package records to the Item Fulfillment
 * @param {Array} ssccCodes - list of SSCC codes
 * @param {Array} trackingObj - list of tracking data (each item = {recordId, palletNumber, weight, ssccCode, bolTrackingNumber, itemName})
 * @param {Number} fulfillmentId - internal ID of the Item Fulfillment
 */
function createPackageRecords(ssccCodes, trackingObj, fulfillmentId,carrierProNumber) {
    try {

      log.error("Debug Info", {
    ssccCodes: ssccCodes,
    trackingObj: trackingObj,
    fulfillmentId: fulfillmentId
});
var carrierProNumber = carrierProNumber;

      
        if (!ssccCodes || !ssccCodes.length) {
            log.debug('No SSCC codes provided', 'Skipping package creation');
            return;
        }

        // Get existing package IDs
        var packageIds = getInternalIdsBySsccCodes(ssccCodes);
      log.error("packageIds",packageIds);

        // 🔹 CASE 1: Create new package records if none found
        if (!packageIds || packageIds.length === 0) {
          log.error("packageIds.length - ",packageIds.length );

            var fulfillmentRec = record.load({
                type: record.Type.ITEM_FULFILLMENT,
                id: fulfillmentId,
                isDynamic: true
            });

            var sublistId = 'recmachcustrecord_hj_packagecontents_sublist';
            var existingCount = fulfillmentRec.getLineCount({ sublistId });

            // Clear existing package lines
            for (var i = existingCount - 1; i >= 0; i--) {
                fulfillmentRec.removeLine({ sublistId, line: i });
            }

            // Add new package lines
            var packageBoxNumber = 0;
            var lastRecordId = null;

            trackingObj.forEach(function (line) {
                lastRecordId = line.recordId;
                packageBoxNumber++;

                fulfillmentRec.selectNewLine({ sublistId });

                var fieldMap = {
                    custrecordhj_pkg_pallet: line.palletNumber,
                    custrecordhj_pkgbox: packageBoxNumber,
                    custrecordhj_tc_packagecontentslbs: line.weight,
                    custrecordhj_ucc: line.ssccCode,
                    custrecordhj_pkg_trackingnumber: line.bolTrackingNumber,
                    custrecordhj_pkg_desc: line.itemName + '/1'
                };

                Object.keys(fieldMap).forEach(function (fieldId) {
                    var value = fieldMap[fieldId];
                    if (value !== null && value !== '' && value !== undefined) {
                        try {
                            fulfillmentRec.setCurrentSublistValue({
                                sublistId: sublistId,
                                fieldId: fieldId,
                                value: value
                            });
                        } catch (err) {
                            log.debug('Skipped field', `${fieldId} - ${err.message}`);
                        }
                    }
                });

                fulfillmentRec.commitLine({ sublistId });
                log.debug('Package line added', JSON.stringify(fieldMap));
            });

            fulfillmentRec.save({
                enableSourcing: true,
                ignoreMandatoryFields: true
            });

            log.audit('New Packages Created', `Fulfillment ID: ${fulfillmentId}`);
        }

        // 🔹 CASE 2: Packages already exist → link them to fulfillment
        else {
          
            log.debug('Existing Package IDs', packageIds);

              try {
                 var fulfillmentRec = record.load({
                type: record.Type.ITEM_FULFILLMENT,
                id: fulfillmentId,
                isDynamic: true
            });

            var sublistId = 'recmachcustrecord_hj_packagecontents_sublist';
            var existingCount = fulfillmentRec.getLineCount({ sublistId });
            var linesremovedCount = 0;
            // Clear existing package lines
            for (var i = existingCount - 1; i >= 0; i--) {
                fulfillmentRec.removeLine({ sublistId, line: i });
                linesremovedCount++;
            }
            if (linesremovedCount > 0) {
            log.error("linesremovedCount",linesremovedCount);
            }
            } catch (error) {
                log.error("error while lines ", error.message)
            }

            packageIds.forEach(function (pkgId) {
                try {
                    record.submitFields({
                        type: 'customrecordhj_tc_package_contents',
                        id: pkgId,
                        values: {
                            custrecord_hj_packagecontents_sublist: fulfillmentId,
                            custrecordhj_pkg_trackingnumber : carrierProNumber
                        }
                    });

                    log.debug('Linked Existing Package', {
                        packageId: pkgId,
                        fulfillmentId: fulfillmentId
                    });
                } catch (err) {
                    log.error('Error Linking Package', err.message);
                }
            });
        }

      var fulfillmentRec = record.load({
    type: record.Type.ITEM_FULFILLMENT,
    id: fulfillmentId,
    isDynamic: true
});

var sublistId = 'recmachcustrecord_hj_packagecontents_sublist';
var palletFieldId = 'custrecordhj_pkg_pallet';

var existingCount = fulfillmentRec.getLineCount({ sublistId: sublistId });
      var linesCountwithNoPlattet = 0;

// Remove all lines that do NOT have pallet value
for (var i = existingCount - 1; i >= 0; i--) {

    var palletValue = fulfillmentRec.getSublistValue({
        sublistId: sublistId,
        fieldId: palletFieldId,
        line: i
    });

    // If no pallet value, remove line
    if (!palletValue || palletValue === '' || palletValue === null) {
        fulfillmentRec.removeLine({
            sublistId: sublistId,
            line: i
        });
      linesCountwithNoPlattet++;
    }
}
log.error("linesCountwithNoPlattet",linesCountwithNoPlattet);

        // 🔹 Mark main fulfillment detail record as updated
        if (trackingObj && trackingObj.length) {
            var firstTracking = trackingObj[0];
            if (firstTracking.recordId) {
                record.submitFields({
                    type: 'customrecord_order_fulfillment_details',
                    id: firstTracking.recordId,
                    values: {
                        custrecord_jyswms_package_updated: true
                    }
                });
                log.debug('Fulfillment Detail Updated', `Record ID: ${firstTracking.recordId}`);
            }
        }

        log.audit('Package Processing Complete', `Fulfillment: ${fulfillmentId}`);

    } catch (e) {
        log.error('Error in createPackageRecords', e.message);
    }
}


    /** =======================
     *  Helper: Tracking Search
     *  ======================= */
    function trackingLines(id) {
        var results = [];
        try {
            var trackingSearch = search.create({
                type: "customrecord_jyswms_sales_order_track",
                filters: [
                    ["custrecord_jyswms_track_so_id.mainline", "is", "T"],
                    "AND",
                    ["custrecord_jyswms_so_header", "anyof", id]
                ],
                columns: [
                    "custrecord_jyswms_track_item",
                    "custrecord_jyswms_track_number",
                    "custrecord_jyswms_track_so_id",
                    "custrecord_jyswms_so_header",
                    "custrecord_jyswms_track_qty",
                    "custrecord_jyswms_track_uniqueid",
                    "custrecord_jyswms_track_pallet_number",
                    "custrecord_jyswms_track_tracking_number",
                    "custrecord_jyswms_track_dropship",
                    search.createColumn({ name: "weight", join: "CUSTRECORD_JYSWMS_TRACK_ITEM" }),
                    search.createColumn({ name: "upccode", join: "CUSTRECORD_JYSWMS_TRACK_ITEM" }),
                    search.createColumn({ name: "otherrefnum", join: "CUSTRECORD_JYSWMS_TRACK_SO_ID" }),
                    search.createColumn({ name: "custbody_bol_tracking_number", join: "CUSTRECORD_JYSWMS_TRACK_SO_ID" })

                ]
            });

            trackingSearch.run().each(function (res) {
                results.push({
                    item: res.getValue("custrecord_jyswms_track_item"),
                    itemName: res.getText("custrecord_jyswms_track_item"),
                    ssccCode: res.getValue("custrecord_jyswms_track_number"),
                    bolTrackingNumber: res.getValue({ name: 'custbody_bol_tracking_number', join: 'CUSTRECORD_JYSWMS_TRACK_SO_ID' }),
                    soHeader: res.getValue("custrecord_jyswms_so_header"),
                    qty: res.getValue("custrecord_jyswms_track_qty"),
                    uniqueId: res.getValue("custrecord_jyswms_track_uniqueid"),
                    palletNumber: res.getValue("custrecord_jyswms_track_pallet_number"),
                    weight: res.getValue({ name: 'weight', join: 'CUSTRECORD_JYSWMS_TRACK_ITEM' }),
                    upcCode: res.getValue({ name: 'upccode', join: 'CUSTRECORD_JYSWMS_TRACK_ITEM' }),
                    poNumber: res.getValue({ name: 'otherrefnum', join: 'CUSTRECORD_JYSWMS_TRACK_SO_ID' }),
                    tracking: res.getValue("custrecord_jyswms_track_dropship"),
                    recordId: id
                });
                return true;
            });

        } catch (e) {
            log.error("Error in trackingLines", e.message);
        }
        return results;
    }

    /** =========================
     *  Helper: SSCC Code Search
     *  ========================= */
  function getInternalIdsBySsccCodes(ssccCodes) {
    var ids = [];
    try {
        var filters = [];

        // Build OR filters properly
        ssccCodes.forEach(function (code, index) {
            if (index > 0) filters.push('OR');
            filters.push(['custrecordhj_ucc', 'is', code]);
        });

        var pkgSearch = search.create({
            type: 'customrecordhj_tc_package_contents',
            filters: filters,
            columns: ['internalid']
        });

        // Use runPaged for large result sets
        var pagedData = pkgSearch.runPaged({ pageSize: 1000 });

        pagedData.pageRanges.forEach(function (pageRange) {
            var page = pagedData.fetch({ index: pageRange.index });

            page.data.forEach(function (res) {
                ids.push(res.getValue('internalid'));
            });
        });

    } catch (e) {
        log.error('Error in getInternalIdsBySsccCodes', e.message);
    }
    return ids;
}


    return { afterSubmit: afterSubmit };

});
