/**
 * @NApiVersion 2.x
 * @NModuleScope Public
 */
define(['N/record', 'N/search', 'N/log','N/runtime'], function (record, search, log, runtime) {


  //  return {
  //       binCount: binCount,
  //       binAdjustment: binAdjustment,
  //       binTransfer: binTransfer,
  //       getBinInventoryDetail: getBinInventoryDetail,
		// getBins : getBins
  //   };

      function binCount(data,customRecId) {
        var results = [];
        log.error("Data -- bin count", JSON.stringify(data, customRecId));

        try {
            var customRecId = customRecId;
            var binId = data.binId;
            var locationId = data.location;

            try{
        
          if (binId) {
    var lookup = search.lookupFields({
        type: 'bin',
        id: binId,
        columns: ['isinactive']
    });

    var isInactive = lookup.isinactive; // boolean true/false

    // If bin is inactive, make it active
    if (isInactive === true) {
        record.submitFields({
            type: 'bin',
            id: binId,
            values: {
                isinactive: false
            }
        });
    }
}
  }catch(e){

            log.error("error message in bincount", e.message)
  }

          
            // locationId = data.location;
          
            var locationName = data.locationName;
            var bulkStageBin = "";

            if (locationId == 0 || locationId == null || locationId == '' || locationId == 'undefined'||  locationId == 9 ||   locationId == 15  ) {
                if (locationName == 'Flemington L41' ||  locationId == 9 ) {
                    locationId = 9;
                    bulkStageBin = 4859;
                }
                else {
                    locationId = 15;
                    bulkStageBin = 16692;
                }
            }

            var itemData = data.itemData || [];
            var pickerName = data.userName || data.username || "";

             var existingQuantitiesMap = binSearch(binId);

            log.debug("existingQuantitiesMap", JSON.stringify(existingQuantitiesMap));
                
             var existingBulkBinQuantitiesMap = binSearch(bulkStageBin);
          
            log.debug("existingBulkBinQuantitiesMap", JSON.stringify(existingBulkBinQuantitiesMap))

            
            // Step 2: Build adjustments

            var bulkBinItemQtymap = fetchBulkStageBinTracking(binId);

           log.debug("bulkBinItemQtymap", JSON.stringify(bulkBinItemQtymap));

            var adjustmentsToMake = [];

            var inputItemIds = itemData.map(function (entry) {

                return entry.itemId.toString();

            });

            itemData.forEach(function (entry) {
                var itemId = entry.itemId.toString();

                var countedQty = Number(entry.quantity) || 0;  //50

                var currentBinQty = Number(existingQuantitiesMap[itemId]) || 0; //20
             
                var bulkBinQTy = Number(bulkBinItemQtymap[itemId]?.on_hand || 0);

                var totalQty = Number(currentBinQty) + bulkBinQTy; //35
                var adjustmentQty = totalQty - countedQty; //35-50=-15

log.debug("quanitylog", "countedQty=" + countedQty + ",currentBinQty=" + currentBinQty + ",bulkBinQTy=" + bulkBinQTy + ",totalQty=" + totalQty + ",diff=" + adjustmentQty);

                // differnce is less than 0 then 0 and greater than currentQty then adjsut the bulkStageQty
                if (adjustmentQty <= currentBinQty) {
                  
                    log.debug("Adjust from regular bin Qty : ", adjustmentQty);
                  
                    if (Number(adjustmentQty) != 0) {
                      
                        // Adjust from regular bin
                        adjustmentsToMake.push({
                            itemId: itemId,
                            quantity: -1 * adjustmentQty,
                            locationId: locationId,
                            binId: binId,
                        });
                      
                    }
                }
                else {

                    var bulkBinAdjustQty = adjustmentQty - currentBinQty;//25-20=5

                    if (Number(currentBinQty) != 0) {
                        adjustmentsToMake.push({
                            itemId: itemId,
                            quantity: -1 * currentBinQty,
                            locationId: locationId,
                            binId: binId,
                        });
                    }

         // existing bullk 10 bulkBinAdjustQty 5

                    if (Number(bulkBinAdjustQty) != 0) {
                        if (Number(existingBulkBinQuantitiesMap[itemId]) >= Number(bulkBinAdjustQty)) {
                            adjustmentsToMake.push({
                                itemId: itemId,
                                quantity: -1 * bulkBinAdjustQty,
                                locationId: locationId,
                                binId: bulkStageBin,
                            });
                        } else {
                            adjustmentsToMake.push({
                                itemId: itemId,
                                quantity: -1 * Number(existingBulkBinQuantitiesMap[itemId]),
                                locationId: locationId,
                                binId: bulkStageBin,
                            });
                        }
                    }
                }

            });

           // log.error("item data", JSON.stringify(adjustmentsToMake));

            // Step 3: Add adjustments for items not in input but existing in bin

            Object.keys(existingQuantitiesMap).forEach(function (itemId) {
                if (!inputItemIds.includes(itemId)) {

                    var currentBinQty = parseFloat(existingQuantitiesMap[itemId]) || 0;

                    if (Number(currentBinQty) !== 0) {

                        adjustmentsToMake.push({
                            itemId: itemId,
                            quantity: -1 * currentBinQty, // remove the quantity
                            locationId: locationId,
                            binId: binId,
                        });
                    }
                    var bulkStageAdjQtyNoBin = Number(bulkBinItemQtymap[itemId]?.on_hand || 0);
                    //	var dif = currentQty -  parseFloat(entry.quantity)
                    if (Number(bulkStageAdjQtyNoBin) !== 0) {
                        adjustmentsToMake.push({
                            itemId: itemId,
                            quantity: -1 * bulkStageAdjQtyNoBin,
                            locationId: locationId,
                            binId: bulkStageBin,
                        });
                    }
                }
            });


         //   log.error("existing Quantity", JSON.stringify(adjustmentsToMake));

            // Step 3: Create inventory adjustment if needed
            if (adjustmentsToMake.length === 0) {

                record.submitFields({
                    type: 'customrecord_wms_ai_api_custom_rec',
                    id: customRecId, // Make sure this is the internal ID of the existing custom record
                    values: {
                        custrecordwms_ai_api_custrec_error: 'No adjustment needed. Quantities match.',
                        custrecord_wms_ai_api_custrec_status: 2
                    }
                });


                return {
                    success: true,
                    message: 'No adjustment needed. Quantities match.'
                };
            }

            var adjustmentRecord = record.create({
                type: record.Type.INVENTORY_ADJUSTMENT,
                isDynamic: true
            });

            var account = parseInt(464, 10); // Use your working account
            var subsidiaryId = 1;            // Use your hardcoded subsidiary


            adjustmentRecord.setValue({ fieldId: 'subsidiary', value: subsidiaryId });
            adjustmentRecord.setValue({ fieldId: 'account', value: account });
            adjustmentRecord.setValue({ fieldId: 'memo', value: data.binName });


            adjustmentRecord.setValue({ fieldId: 'custbody_wms_ai_created_by', value: true });
            adjustmentRecord.setValue({ fieldId: 'custbody_wms_ai_pickername', value: pickerName || '' });

            adjustmentsToMake.forEach(function (adjustment) {
                try {

                adjustmentRecord.setValue({ fieldId: 'adjlocation', value: adjustment.locationId });



                adjustmentRecord.selectNewLine({ sublistId: 'inventory' });

                adjustmentRecord.setCurrentSublistValue({
                    sublistId: 'inventory',
                    fieldId: 'item',
                    value: adjustment.itemId
                });

                adjustmentRecord.setCurrentSublistValue({
                    sublistId: 'inventory',
                    fieldId: 'location',
                    value: adjustment.locationId
                });

                adjustmentRecord.setCurrentSublistValue({
                    sublistId: 'inventory',
                    fieldId: 'adjustqtyby',
                    value: adjustment.quantity
                });

                var inventoryDetail = adjustmentRecord.getCurrentSublistSubrecord({
                    sublistId: 'inventory',
                    fieldId: 'inventorydetail'
                });

                inventoryDetail.selectNewLine({ sublistId: 'inventoryassignment' });

                inventoryDetail.setCurrentSublistValue({
                    sublistId: 'inventoryassignment',
                    fieldId: 'binnumber',
                    value: parseInt(adjustment.binId, 10)
                });

                inventoryDetail.setCurrentSublistValue({
                    sublistId: 'inventoryassignment',
                    fieldId: 'quantity',
                    value: adjustment.quantity
                });

                inventoryDetail.commitLine({ sublistId: 'inventoryassignment' });
                adjustmentRecord.commitLine({ sublistId: 'inventory' });

                //  adjustmentRecord.setValue({fieldId: 'account', value: account });
            
            } catch (itemErr) {
      log.error('Error processing item', itemErr.message);

          results.push({
            itemId: adjustment,
            success: false,
            message: itemErr.message
          });
                  }
            
               
                });
            //adjustmentRecord.setValue({fieldId: 'account', value: account });

        const hasErrors = results.length > 0;
      let invAdjId = null;

      if (!hasErrors) {
        invAdjId = adjustmentRecord.save({ enableSourcing: true, ignoreMandatoryFields: true });
        log.error("invAdjId:", invAdjId);
            
        if (customRecId) {
          record.submitFields({
            type: 'customrecord_wms_ai_api_custom_rec',
            id: customRecId,
            values: {
              custrecordwms_ai_api_custrec_rel_trans: invAdjId,
              custrecordwms_ai_api_custrec_error: "Inventory Adjustment Id created successfully\nID:"+invAdjId,
              custrecord_wms_ai_api_custrec_status: 2,
              custrecord_wms_ai_api_custrec_processing : false
              
            }
          });
        }

        return {
          success: true,
          message: 'inventory AdjustmentId created successfully',
          inventoryAdjustmentId: invAdjId
        };
      } else {  
        if (customRecId) {
          record.submitFields({
            type: 'customrecord_wms_ai_api_custom_rec',
            id: customRecId,
            values: {
              custrecordwms_ai_api_custrec_error: JSON.stringify(results),
              custrecord_wms_ai_api_custrec_status: 3,
              custrecord_wms_ai_api_custrec_processing : false
            }
          });
        }

        return {
          success: false,
          message: results
        };

      }

        } catch (e) {

            record.submitFields({
                type: 'customrecord_wms_ai_api_custom_rec',
                id: customRecId, // Make sure this is the internal ID of the existing custom record
                values: {
                    custrecordwms_ai_api_custrec_error: e.message,
                    custrecord_wms_ai_api_custrec_status: 3 //errror
                }
            });

            log.error('Inventory Adjustment Failed', e.message);
            return {
                success: false,
                message: e.message
            };
        }

    }


  
      function binAdjustment(data,customRecId) {
        var results = [];
        var itemDetails = [];

    log.debug("Input Data", JSON.stringify(data));

        try {
            var binId = data.binId;
            var locationId = data.location || '';
            var locationName = data.locationName;
            var bulkStageBin = "";


          try{
        
          if (binId) {
    var lookup = search.lookupFields({
        type: 'bin',
        id: binId,
        columns: ['isinactive']
    });

    var isInactive = lookup.isinactive; // boolean true/false

    // If bin is inactive, make it active
    if (isInactive === true) {
        record.submitFields({
            type: 'bin',
            id: binId,
            values: {
                isinactive: false
            }
        });
    }
}
  }catch(e){

            log.error("error message", e.message)
  }


           if (locationId == 0 || locationId == null || locationId == '' || locationId == 9 || locationId == 15 || locationId == 'undefined') {
                if (locationName == 'Flemington L41' || locationId == 9  ) {
                    locationId = 9;
                    bulkStageBin = 4859;
                }
                else {
                    locationId = 15;
                    bulkStageBin = 16692;
                }
            }

            var itemData = data.itemData || [];
            var pickerName = data.userName || data.username || "";
         

            // Step 1: Get current quantities from bin
            var existingQuantitiesMap = binSearch(binId);

            log.debug("existingQuantitiesMap", JSON.stringify(existingQuantitiesMap));
            
            var existingBulkBinQuantitiesMap = binSearch(bulkStageBin);
          
            log.debug("existingBulkBinQuantitiesMap", JSON.stringify(existingBulkBinQuantitiesMap));

            // Step 2: Build adjustments

            var bulkBinItemQtymap = fetchBulkStageBinTracking(binId);

            var adjustmentsToMake = [];

            var inputItemIds = itemData.map(function (entry) {

                return entry.itemId.toString();

            });

            itemData.forEach(function (entry) {
                var itemId = entry.itemId.toString();

                var countedQty = Number(entry.quantity) || 0;  //100
                //  log.debug("newQty", countedQty);

                var currentBinQty = Number(existingQuantitiesMap[itemId]) || 0; //0
                // log.debug("currentQty", currentBinQty);

               var bulkBinQTy = Number(bulkBinItemQtymap[itemId]?.on_hand || 0); //15

               var totalQty = Number(currentBinQty) + bulkBinQTy; //35
         
               var exstBulkBinQty =  Number(existingBulkBinQuantitiesMap[itemId]) || 0;
              
           // var totalQty
           //    if (bulkBinQTy > exstBulkBinQty ) {
           //      totalQty = Number(currentBinQty) + exstBulkBinQty;
           //    }else {
           //      totalQty = Number(currentBinQty) + bulkBinQTy; //35
           //    }
              
        // var totalQty = Number(currentBinQty) + bulkBinQTy; //35
                // log.debug("totalQty", totalQty);

                var adjustmentQty = totalQty - countedQty; //35-50=-15

          log.debug("quanitylog", "countedQty=" + countedQty + ",currentBinQty=" + currentBinQty + ",bulkBinQTy=" + bulkBinQTy + ",totalQty=" + totalQty + ",diff=" + adjustmentQty);

                // differnce is less than 0 then 0 and greater than currentQty then adjsut the bulkStageQty
                if (adjustmentQty <= currentBinQty) {
                    log.debug("Adjust from regular bin Qty : ", adjustmentQty);
                    if (Number(adjustmentQty) != 0) {
                        // Adjust from regular bin
                        adjustmentsToMake.push({
                            itemId: itemId,
                            quantity: -1 * adjustmentQty,
                            locationId: locationId,
                            binId: binId,
                        });
                    }
                }
                else {

                    // Split adjustment across regular + bulkStageBin
                   // log.debug("Split adjustment across regular + bulkStageBin : ", adjustmentQty);

                    var bulkBinAdjustQty = adjustmentQty - currentBinQty;//25-20=5

                    if (Number(currentBinQty) != 0) {
                        adjustmentsToMake.push({
                            itemId: itemId,
                            quantity: -1 * currentBinQty,
                            locationId: locationId,
                            binId: binId,
                        });
                    }

                    // existing bullk 10 bulkBinAdjustQty 5

                    if (Number(bulkBinAdjustQty) != 0) {
                        if (Number(existingBulkBinQuantitiesMap[itemId]) >= Number(bulkBinAdjustQty)) {
                      
                          adjustmentsToMake.push({
                                itemId: itemId,
                                quantity: -1 * Number(bulkBinAdjustQty),
                                locationId: locationId,
                                binId: bulkStageBin,
                            });
                          
                        } else {
                            adjustmentsToMake.push({
                                itemId: itemId,
                                quantity: -1 * Number(existingBulkBinQuantitiesMap[itemId]),
                                locationId: locationId,
                                binId: bulkStageBin,
                            });
                        }
                    }
                }

            });

            log.error("item data", JSON.stringify(adjustmentsToMake));

            // Step 3: Add adjustments for items not in input but existing in bin

            //bulkBinItemQtymap = fetchBulkStageBinTracking(estItemdIs,bulkStageBin);

            Object.keys(existingQuantitiesMap).forEach(function (itemId) {
                if (!inputItemIds.includes(itemId)) {

                    var currentBinQty = parseFloat(existingQuantitiesMap[itemId]) || 0;

                    if (Number(currentBinQty) !== 0) {

                        adjustmentsToMake.push({
                            itemId: itemId,
                            quantity: -1 * currentBinQty, // remove the quantity
                            locationId: locationId,
                            binId: binId,
                        });
                    }
                   var bulkStageAdjQtyNoBin = Number(bulkBinItemQtymap[itemId]?.on_hand || 0);
                    //	var dif = currentQty -  parseFloat(entry.quantity)
                    if (Number(bulkStageAdjQtyNoBin) !== 0) {
                        adjustmentsToMake.push({
                            itemId: itemId,
                            quantity: -1 * bulkStageAdjQtyNoBin,
                            locationId: locationId,
                            binId: bulkStageBin,
                        });
                    }
                }
            });

            // Step 3: Create inventory adjustment if needed
            if (adjustmentsToMake.length === 0) {
      try{

        var response = getBinInventoryDetail(binId);

 
            itemDetails = response.data[binId].itemDetails || " ";


        } catch(e){

          log.error("Response Error",e.message);

        }
                record.submitFields({
                    type: 'customrecord_wms_ai_api_custom_rec',
                    id: customRecId, // Make sure this is the internal ID of the existing custom record
                    values: {
                        custrecordwms_ai_api_custrec_error: 'No adjustment needed. Quantities match.',
                        custrecord_wms_ai_api_custrec_status: 2,
                      custrecord_wms_ai_api_custrec_processing : false
                    }
                });

                return {
                    success: true,
                    message: 'No adjustment needed. Quantities match.',
                    itemDetails: itemDetails
                };

            }

            var adjustmentRecord = record.create({
                type: record.Type.INVENTORY_ADJUSTMENT,
                isDynamic: true
            });

            var account = parseInt(464, 10); // Use your working account
            var subsidiaryId = 1;            // Use your hardcoded subsidiary

            adjustmentRecord.setValue({ fieldId: 'subsidiary', value: subsidiaryId });
            adjustmentRecord.setValue({ fieldId: 'account', value: account });
            adjustmentRecord.setValue({ fieldId: 'memo', value: data.binName });


            adjustmentRecord.setValue({ fieldId: 'custbody_wms_ai_created_by', value: true });
            adjustmentRecord.setValue({ fieldId: 'custbody_wms_ai_pickername', value: pickerName || '' });
           
          adjustmentsToMake.forEach(function (adjustment) {
              try {

                adjustmentRecord.setValue({ fieldId: 'adjlocation', value: adjustment.locationId });


                adjustmentRecord.selectNewLine({ sublistId: 'inventory' });

                adjustmentRecord.setCurrentSublistValue({
                    sublistId: 'inventory',
                    fieldId: 'item',
                    value: adjustment.itemId
                });

                adjustmentRecord.setCurrentSublistValue({
                    sublistId: 'inventory',
                    fieldId: 'location',
                    value: adjustment.locationId
                });

                adjustmentRecord.setCurrentSublistValue({
                    sublistId: 'inventory',
                    fieldId: 'adjustqtyby',
                    value: adjustment.quantity
                });

                var inventoryDetail = adjustmentRecord.getCurrentSublistSubrecord({
                    sublistId: 'inventory',
                    fieldId: 'inventorydetail'
                });

                inventoryDetail.selectNewLine({ sublistId: 'inventoryassignment' });

                inventoryDetail.setCurrentSublistValue({
                    sublistId: 'inventoryassignment',
                    fieldId: 'binnumber',
                    value: parseInt(adjustment.binId, 10)
                });

                inventoryDetail.setCurrentSublistValue({
                    sublistId: 'inventoryassignment',
                    fieldId: 'quantity',
                    value: adjustment.quantity
                });

                inventoryDetail.commitLine({ sublistId: 'inventoryassignment' });

                adjustmentRecord.commitLine({ sublistId: 'inventory' });

                //  adjustmentRecord.setValue({fieldId: 'account', value: account });

                 } catch (itemErr) {
      log.error('Error processing item', itemErr.message);

          results.push({
            itemId: adjustment,
            success: false,
            message: itemErr.message
          });
                  }
            });
          
            //adjustmentRecord.setValue({fieldId: 'account', value: account });
  const hasErrors = results.length > 0;
      let invAdjId = null;

      if (!hasErrors) {
        invAdjId = adjustmentRecord.save({ enableSourcing: true, ignoreMandatoryFields: true });
        log.error("invAdjId:", invAdjId);
        try{
        var response = getBinInventoryDetail(binId);
         
            itemDetails = response.data[binId].itemDetails || " ";

        } catch(e){

          log.error("Response Error",e.message);

        }

        if (customRecId) {
          record.submitFields({
            type: 'customrecord_wms_ai_api_custom_rec',
            id: customRecId,
            values: {
              custrecordwms_ai_api_custrec_rel_trans: invAdjId,
      custrecordwms_ai_api_custrec_error: "Inventory Adjustment Id created successfully\nID:"+invAdjId,
    custrecord_wms_ai_api_custrec_status: 2,
              custrecord_wms_ai_api_custrec_processing : false
              
            }
          });
        }

        return {
          success: true,
          message: 'inventory AdjustmentId created successfully',
          inventoryAdjustmentId: invAdjId,
          itemDetails: itemDetails
        };
      } else {  
        if (customRecId) {
          record.submitFields({
            type: 'customrecord_wms_ai_api_custom_rec',
            id: customRecId,
            values: {
              custrecordwms_ai_api_custrec_error: JSON.stringify(results),
              custrecord_wms_ai_api_custrec_status: 3,
              custrecord_wms_ai_api_custrec_processing : false
            }
          });
        }

        return {
          success: false,
          message: results
        };

      }

        } catch (e) {

            record.submitFields({
                type: 'customrecord_wms_ai_api_custom_rec',
                id: customRecId, // Make sure this is the internal ID of the existing custom record
                values: {
                    custrecordwms_ai_api_custrec_error: e.message,
                    custrecord_wms_ai_api_custrec_status: 3,
                  custrecord_wms_ai_api_custrec_processing : false
                }
            });


            log.error('Inventory Adjustment Failed', e.message);
            return {
                success: false,
                message: e.message
            };
        }
    }



  
  function binTransfer(data, customRecId) {
        var customRecId = customRecId;

        log.error("binTransfer - Started", JSON.stringify(data));
        var results = [];

        try {
            var binId = data.binId;
            var locationId = data.location || '';
            log.error("binId", binId);
            var locationName = data.locationName;
            var bulkStageBin = '';
            var toBin = data.toBin;
            var itemData = data.itemData || [];
            var pickerName = data.userName ||data.username || "";
            var adjId = '';

          
try{
          if (toBin) {
    var lookup = search.lookupFields({
        type:'bin',
        id: toBin,
        columns: ['isinactive']
    });

    var isInactive = lookup.isinactive; // boolean true/false

    // If bin is inactive, make it active
    if (isInactive ===true) {
        record.submitFields({
            type: 'bin',
            id: toBin,
            values: {
                isinactive: false
            }
        });
    }
}

          if (binId) {
    var lookup = search.lookupFields({
        type: 'bin',
        id: binId,
        columns: ['isinactive']
    });

    var isInactive = lookup.isinactive; // boolean true/false

    // If bin is inactive, make it active
    if (isInactive === true) {
        record.submitFields({
            type: 'bin',
            id: binId,
            values: {
                isinactive: false
            }
        });
    }
}
  }catch(e){
  log.error("error message", e.message)
  }


          

            if (!locationId || locationId == 0 || locationId == 'undefined' || locationId == 9 || locationId == 15) {
                if (locationName === 'Flemington L41' || locationName === 9) {
                    locationId = 9;
                    bulkStageBin = 4859;
                } else {
                    locationId = 15;
                    bulkStageBin = 16692;
                }
            }
            ////////////////////////
            var existingQuantitiesMap = binSearch(binId);


          //  log.error("existingQuantitiesMap", JSON.stringify(existingQuantitiesMap));
            /////////////
            var existingBulkBinQuantitiesMap = binSearch(bulkStageBin);
          
          //  log.error("existingBulkBinQuantitiesMap", JSON.stringify(existingBulkBinQuantitiesMap));

   
            var bulkBinItemQtymap = fetchBulkStageBinTracking(binId);

          //  log.error("bulkBinItemQtymap", JSON.stringify(bulkBinItemQtymap));


          	var adjustmentsToMake  = [];
			
			 itemData.forEach((item) => {
               
			    var itemId = item.itemId.toString()
                var transferQty = Number(item.quantity) || 0; //1
                log.error("transferQty", transferQty); //1
				
               // log.error("existingQuantitiesMap[itemId]", existingQuantitiesMap[itemId]);

                var currentBinQty = Number(existingQuantitiesMap[itemId]) || 0; //
              //  log.error("currentQty", currentBinQty); //0

                var bulkBinQTy = Number(bulkBinItemQtymap[itemId] || 0); //15
				//log.error("bulkBinQty", bulkBinQTy); //0
				
                var estbulkBinQty = Number(existingBulkBinQuantitiesMap[itemId] || 0);
              //  log.error("estbulkBinQty", estbulkBinQty); //0
				
                var totalQty = Number(currentBinQty) + bulkBinQTy; //35
              //  log.error("totalQty", totalQty); 
				
				if (item.quantity == 0 || transferQty <= currentBinQty || totalQty >= transferQty) {
                       // log.error("item.quantity", item.quantity);
                        return true;
                    }
			     else {
                       
                            totalQty = estbulkBinQty + currentBinQty;
                         //   log.error("totalQty2", totalQty);
                        
						
                        if (transferQty <= totalQty) {
                         return true;
                        }
						else {
							
							var adjustmentQty =  transferQty - totalQty; 
							
							adjustmentsToMake.push({
                            itemId: itemId,
                            quantity: adjustmentQty,
                            locationId: locationId,
                            binId: bulkStageBin,
                        });
						
						}
					
			 }
			
             });

         //    log.error("adjustment to make",JSON.stringify(adjustmentsToMake));
          
          
			if (adjustmentsToMake.length > 0) {
			 
			  var adjustmentRecord = record.create({
                type: record.Type.INVENTORY_ADJUSTMENT,
                isDynamic: true
            });

            var account = parseInt(464, 10); // Use your working account
            var subsidiaryId = 1;            // Use your hardcoded subsidiary

            adjustmentRecord.setValue({ fieldId: 'subsidiary', value: subsidiaryId });
            adjustmentRecord.setValue({ fieldId: 'account', value: account });
            adjustmentRecord.setValue({ fieldId: 'memo', value: data.binName });
			adjustmentRecord.setValue({ fieldId: 'adjlocation', value: locationId });


            adjustmentRecord.setValue({ fieldId: 'custbody_wms_ai_created_by', value: true });
            adjustmentRecord.setValue({ fieldId: 'custbody_wms_ai_pickername', value: pickerName || '' });
           
			 
			 
			
           adjustmentsToMake.forEach(function (adjustment) {
              try {

                adjustmentRecord.selectNewLine({ sublistId: 'inventory' });

                adjustmentRecord.setCurrentSublistValue({
                    sublistId: 'inventory',
                    fieldId: 'item',
                    value: adjustment.itemId
                });

                adjustmentRecord.setCurrentSublistValue({
                    sublistId: 'inventory',
                    fieldId: 'location',
                    value: adjustment.locationId
                });

                adjustmentRecord.setCurrentSublistValue({
                    sublistId: 'inventory',
                    fieldId: 'adjustqtyby',
                    value: adjustment.quantity
                });

                var inventoryDetail = adjustmentRecord.getCurrentSublistSubrecord({
                    sublistId: 'inventory',
                    fieldId: 'inventorydetail'
                });

                inventoryDetail.selectNewLine({ sublistId: 'inventoryassignment' });

                inventoryDetail.setCurrentSublistValue({
                    sublistId: 'inventoryassignment',
                    fieldId: 'binnumber',
                    value: parseInt(adjustment.binId, 10)
                });

                inventoryDetail.setCurrentSublistValue({
                    sublistId: 'inventoryassignment',
                    fieldId: 'quantity',
                    value: adjustment.quantity
                });

                inventoryDetail.commitLine({ sublistId: 'inventoryassignment' });

                adjustmentRecord.commitLine({ sublistId: 'inventory' });

                 } 
              catch (itemErr) {
          log.error('Error processing item', itemErr.message);

          results.push({
            itemId: adjustment,
            success: false,
            message: itemErr.message
          });
                  }
            });
            //adjustmentRecord.setValue({fieldId: 'account', value: account });
          
  const hasErrors = results.length > 0;
    adjId = null;

      if (!hasErrors) {
        try{
     adjId = adjustmentRecord.save({ enableSourcing: true, ignoreMandatoryFields: true });
      //  log.error("invAdjId:", adjId);
        }catch(e) {
           log.error("error message", e.message);
          }
	  }
				
			
		}		

     		  existingQuantitiesMap = binSearch(binId);


          //  log.error("existingQuantitiesMap", JSON.stringify(existingQuantitiesMap));
            /////////////
             existingBulkBinQuantitiesMap = binSearch(bulkStageBin);
          
          //  log.error("existingBulkBinQuantitiesMap", JSON.stringify(existingBulkBinQuantitiesMap))

   
             bulkBinItemQtymap = fetchBulkStageBinTracking(binId);

           // log.error("bulkBinItemQtymap", JSON.stringify(bulkBinItemQtymap));

          
            // Create the Bin Transfer record
            const binTransfer = record.create({
                type: record.Type.BIN_TRANSFER,
                isDynamic: true
            });

            binTransfer.setValue({
                fieldId: 'subsidiary',
                value: 1
            });
            binTransfer.setValue({
                fieldId: 'location',
                value: locationId
            });
            binTransfer.setValue({
                fieldId: 'memo',
                value: data.binName
            });
            binTransfer.setValue({
                fieldId: 'custbody_wms_ai_created_by',
                value: true
            });
            binTransfer.setValue({
                fieldId: 'custbody_wms_ai_pickername',
                value: pickerName || ''
            });


            var locationID = binTransfer.getValue('location');
            log.error("locationID", locationID);

            var lineCount = 0;
			

            itemData.forEach((item) => {
  ////////////////////////////////////////////////////////////////////////
                
                var itemId = item.itemId.toString()
              var transferQty = Number(item.quantity) || 0; //1
            // log.error("transferQty", transferQty); //1
				
             //   log.error("existingQuantitiesMap[itemId]", existingQuantitiesMap[itemId]);

                var currentBinQty = Number(existingQuantitiesMap[itemId]) || 0; //
              //  log.error("currentQty", currentBinQty); //0

                var bulkBinQTy = Number(bulkBinItemQtymap[itemId] || 0); //15
			//	log.error("bulkBinQty", bulkBinQTy); //0
				
                var estbulkBinQty = Number(existingBulkBinQuantitiesMap[itemId] || 0);
              //  log.error("estbulkBinQty", estbulkBinQty); //0
				
                
                var totalQty = Number(currentBinQty) + bulkBinQTy; //35
               // log.error("totalQty", totalQty);

              log.error("Quantities Debug", {
    transferQty: transferQty,
    currentBinQty: Number(existingQuantitiesMap[itemId]) || 0,
    bulkBinQty: Number(bulkBinItemQtymap[itemId] || 0),
    estBulkBinQty: Number(existingBulkBinQuantitiesMap[itemId] || 0),
    totalQty: (Number(existingQuantitiesMap[itemId]) || 0) + (Number(bulkBinItemQtymap[itemId] || 0))
});


                var adjBin;
                var adjQty;
				
                try {				

                    if (item.quantity == 0) {
                        log.error("item.quantity", item.quantity);
                        return;
                    }

                    binTransfer.selectNewLine({
                        sublistId: 'inventory'
                    });

                   
                    binTransfer.setCurrentSublistValue({
                        sublistId: 'inventory',
                        fieldId: 'item',
                        value: item.itemId
                    });


                    var itemId = binTransfer.getCurrentSublistValue({
                        sublistId: 'inventory',
                        fieldId: 'item'
                    });
                    log.error("itemId", itemId);

                    binTransfer.setCurrentSublistValue({
                        sublistId: 'inventory',
                        fieldId: 'quantity',
                        value: item.quantity
                    });
					
                    var quantity = binTransfer.getCurrentSublistValue({
                        sublistId: 'inventory',
                        fieldId: 'quantity'
                    });
					
                    log.error("quantity", quantity);
                    const inventoryDetail = binTransfer.getCurrentSublistSubrecord({
                        sublistId: 'inventory',
                        fieldId: 'inventorydetail'
                    });
					
                    let invAsg = false;
					
                    if (transferQty <= currentBinQty) {

                        adjBin = [binId];
                        adjQty = [item.quantity];
                        invAsg = inventoryAssignment(inventoryDetail, adjBin, adjQty, toBin, item);
                        log.error("invAsg1", invAsg);	
                    } 
					else {
						
                        if (totalQty >= transferQty) {
                            totalQty = totalQty;
                           // log.error("totalQty1", totalQty);
                        } 
						else {
                            totalQty = estbulkBinQty + currentBinQty;
                           // log.error("totalQty2", totalQty);
                        }
						
                      //  log.error("totalQty3", totalQty);
						
                        if (transferQty <= totalQty) {

                            adjBin = [binId, bulkStageBin];

                            let secondQty = transferQty - currentBinQty;
                            if (secondQty < 0) {
                                log.error("Negative quantity adjustment prevented", {
                                    itemId: itemId,
                                    currentBinQty,
                                    transferQty
                                });
                                secondQty = 0;
                            }
                            adjQty = [currentBinQty, secondQty];
                            //	adjQty = [currentBinQty, (transferQty - currentBinQty) ];
                            invAsg = inventoryAssignment(inventoryDetail, adjBin, adjQty, toBin, item);
                            log.error("invAsg2", invAsg);
							
                        }
						
                    }

                    if (invAsg) {
                        binTransfer.commitLine({
                            sublistId: 'inventory'
                        });
                        log.error("Line committed", itemId);
                    } else {
                        throw new Error("Inventory assignment failed or missing.");
                    }
                    // Don't push success result
                } catch (itemErr) {
                    log.error('Error processing item', itemErr.message);
                    results.push({
                        itemId: item,
                        success: false,
                        message: itemErr.message
                    });
                }
            });

            const hasErrors = results.length > 0;
            let binTransferId = null;

            lineCount = binTransfer.getLineCount({
                sublistId: 'inventory'
            });
       //     log.error("lineCount", lineCount);

            if (!hasErrors && lineCount > 0) {
                binTransferId = binTransfer.save({
                    enableSourcing: true,
                    ignoreMandatoryFields: true
                });
                // log.error("binTransferId:", binTransferId);

                // log.error("customRecId: 120", customRecId);
                if (customRecId) {
                    record.submitFields({
                        type: 'customrecord_wms_ai_api_custom_rec',
                        id: customRecId,
                        values: {
                            custrecordwms_ai_api_custrec_rel_trans: binTransferId,
                            custrecord_wms_ai_api_related_invadj: adjId,
                            custrecordwms_ai_api_custrec_error: "Bin transfer created successfully\nID:" + binTransferId + (adjId ? "\nAdj ID: " + adjId : ''),
                            custrecord_wms_ai_api_custrec_status: 2,
                            custrecord_wms_ai_api_custrec_processing: false

                        }
                    });
                }

                return {
                    success: true,
                    message: 'Bin transfer created successfully',
                    binTransferId: binTransferId
                };
            } else {
                if (customRecId) {
                   // log.error("results165", results);
                    if (results.length > 0) {

                        record.submitFields({
                            type: 'customrecord_wms_ai_api_custom_rec',
                            id: customRecId,

                            values: {
                                custrecordwms_ai_api_custrec_error: JSON.stringify(results),
                                custrecord_wms_ai_api_custrec_status: 3,
                                custrecord_wms_ai_api_custrec_processing: false
                            }
                        });

                    } else {
                        log.error("results180", results);
                        record.submitFields({
                            type: 'customrecord_wms_ai_api_custom_rec',
                            id: customRecId,

                            values: {
                                custrecordwms_ai_api_custrec_error: "The transaction was skipped because the item quantity is zero.",
                                custrecord_wms_ai_api_custrec_status: 3,
                                custrecord_wms_ai_api_custrec_processing: false
                            }
                        })
                    }
                }
            }

            return {
                success: false,
                message: (results.length > 0) ? results : "The transaction was skipped because the item quantity is zero."
            };


        } catch (e) {
            log.error('Bin Transfer Failed (outer)', e.message);

            if (customRecId) {
                record.submitFields({
                    type: 'customrecord_wms_ai_api_custom_rec',
                    id: customRecId,
                    values: {
                        custrecordwms_ai_api_custrec_error: e.message,
                        custrecord_wms_ai_api_custrec_status: 3,
                        custrecord_wms_ai_api_custrec_processing: false
                    }
                });
            }

            return {
                success: false,
                message: e.message
            };
        }
    }

  

    function binSearch(binId) {
        try {
            var bulkStageBin = "";
            var existingBulkBinQuantitiesMap = {};


            var locationLookup = search.lookupFields({
                type: search.Type.BIN,
                id: binId,
                columns: ['location']
            });

            var locationId = locationLookup.location && locationLookup.location[0] && locationLookup.location[0].value;

            if (locationId == 9) {
                bulkStageBin = 4859;
            } else {
                locationId = 15;
                bulkStageBin = 16692;
            }

            var binSearch = search.create({
                type: 'item',
                filters: [
                    ['binonhand.location', 'anyof', locationId],
                    'AND',
                    ['binonhand.binnumber', 'anyof', binId]
                ],
                columns: [
                    search.createColumn({
                        name: "quantityavailable",
                        join: "binOnHand",
                        label: "on hand"
                    }),
                    search.createColumn({
                        name: "internalid",
                    })
                ]
            });

            var pagedResults = binSearch.runPaged({
                pageSize: 1000
            });

            pagedResults.pageRanges.forEach(function(pageRange) {
                var page = pagedResults.fetch({
                    index: pageRange.index
                });
                page.data.forEach(function(result) {
                    var itemId = result.getValue({
                        name: 'internalid'
                    });
                    var bulkbinQty = parseFloat(result.getValue({
                        name: "quantityavailable",
                        join: "binOnHand"
                    })) || 0;

                    existingBulkBinQuantitiesMap[itemId] = bulkbinQty;
                });
            });


            return existingBulkBinQuantitiesMap;

        } catch (e) {
            log.error("Error in binSearch", e.toString());
            return {};
        }
    }

    function fetchBulkStageBinTracking(binNumberId) {

        try { 
          var bulkStageBin;
          var locationLookup = search.lookupFields({
                type: search.Type.BIN,
                id: binNumberId,
                columns: ['location']
            });

            var locationId = locationLookup.location && locationLookup.location[0] && locationLookup.location[0].value;

            if (locationId == 9) {
                bulkStageBin = 4859;
            } else {
                locationId = 15;
                bulkStageBin = 16692;
            }

          //log.error("locationid",locationId);
            var bulkBinItemQtymap = {};
            //searching BUlk Stage Bin Tracking Records
            var customrecord_bulk_stage_bin_trackingSearchObj = search.create({
                type: "customrecord_bulk_stage_bin_tracking",
                filters: [
                    ["custrecord_related_bin_transfer_track", "noneof", "@NONE@"],
                    "AND",
                    ["custrecord_quantity_remaining", "greaterthan", 0],
                    "AND",
                    ["custrecord_sales_order_rec.status", "noneof", "SalesOrd:C", "SalesOrd:F", "SalesOrd:G", "SalesOrd:H"],
                    "AND",
                    ["custrecord_sales_order_rec.mainline", "is", "T"],
                    "AND",
                    ["custrecord_from_bin", "anyof", binNumberId]
                ],
                columns: [
                    search.createColumn({
                        name: "custrecord_item_name",
                        summary: "GROUP",
                        label: "Item"
                    }),
                    search.createColumn({
                        name: "custrecord_from_bin",
                        summary: "GROUP"
                    }),
                    search.createColumn({
                        name: "custrecord_quantity_remaining",
                        summary: "SUM",
                        label: "Quantity Fulfill"
                    }),
                   search.createColumn({ name: "upccode", join: "CUSTRECORD_ITEM_NAME", summary: "GROUP", label: "UPC Code" })

                ]
            });

            var searchResultCount = customrecord_bulk_stage_bin_trackingSearchObj.runPaged().count;
           // log.error("customrecord_bulk_stage_bin_trackingSearchObj result count", searchResultCount);

            var existingBulkBinQuantitiesMap = binSearch(bulkStageBin);

            customrecord_bulk_stage_bin_trackingSearchObj.run().each(function(result) {

                var itemId = result.getValue({
                    name: "custrecord_item_name",
                    summary: "GROUP"
                });
                var itemName = result.getText({
                    name: "custrecord_item_name",
                    summary: "GROUP"
                });
                var quantity = Number(result.getValue({
                    name: "custrecord_quantity_remaining",
                    summary: "SUM"
                })) || 0;

                // Skip if item is not present in existingBulkBinQuantitiesMap or value is 0
                if ( existingBulkBinQuantitiesMap[itemId] < quantity ) {
                    log.error("existingBulkBinQuantitiesMap[itemId]", existingBulkBinQuantitiesMap[itemId]);
                  quantity = existingBulkBinQuantitiesMap[itemId];                   // return true;
                }
                //   var quantity = result.getValue({ name: "custrecord_quantity_remaining", summary: "SUM", label: "Quantity Fulfill" });
                bulkBinItemQtymap[itemId] = {
                    "item": itemName,
                    "bin_number": result.getText({
                        name: "custrecord_from_bin",
                        summary: "GROUP"
                    }),
                    "location": "",
                    "item_upc" : result.getValue({ name: "upccode", join: "CUSTRECORD_ITEM_NAME", summary: "GROUP" }),
                    "inventory_number": "",
                    "status": "",
                    "on_hand": Number(quantity).toString(),
                    "available": Number(quantity).toString(),
                    "item_internal_id": itemId,
                    "bin_internal_id": result.getValue({
                        name: "custrecord_from_bin",
                        summary: "GROUP"
                    })
                }
                return true;

            });

            /*	bulkBinItemQtymap =		{
            	            "60104":{
                                "item": "MCR100C-28",
                                "bin_number": "L4102037802",
                                "location": "Flemington L41",
                                "inventory_number": "",
                                "status": "Good",
                                "on_hand": "1",
                                "available": "1",
                                "item_internal_id": "60104",
                                "bin_internal_id": "4084"
                            },
            				
            				"60104":{
                                "item": "RES101A-28",
                                "bin_number": "L4102037802",
                                "location": "Flemington L41",
                                "inventory_number": "",
                                "status": "Good",
                                "on_hand": "2",
                                "available": "2",
                                "item_internal_id": "60324",
                                "bin_internal_id": "4084"
                            }
            }*/
        //    log.error("bulkBinItemQtymap", JSON.stringify(bulkBinItemQtymap));

            return bulkBinItemQtymap;
        } catch (e) {
            log.error("Error in fetchBulkStageBinTracking", e);
            return {};
        }
    }

    function inventoryAssignment(inventoryDetail, adjBin, adjQty, toBin, item, locationId) {
        try {
            for (var i = 0; i < adjBin.length; i++) {
                if (!Array.isArray(adjBin)) adjBin = [adjBin];
                if (!Array.isArray(adjQty)) adjQty = [adjQty];
                var binId = adjBin[i];
                log.error(" inv binId", binId); // get bin number from array
                var quantity = adjQty[i];
                log.error("quantity", quantity);
                if (quantity == 0) {
                    log.error("quantity is zero");
                    continue;
                }


                inventoryDetail.selectNewLine({
                    sublistId: 'inventoryassignment'
                });

                inventoryDetail.setCurrentSublistValue({
                    sublistId: 'inventoryassignment',
                    fieldId: 'binnumber',
                    value: parseInt(binId, 10)
                });

                if (toBin) {
                    inventoryDetail.setCurrentSublistValue({
                        sublistId: 'inventoryassignment',
                        fieldId: 'tobinnumber',
                        value: parseInt(toBin, 10)
                    });
                }

                inventoryDetail.setCurrentSublistValue({
                    sublistId: 'inventoryassignment',
                    fieldId: 'quantity',
                    value: quantity
                });

                inventoryDetail.commitLine({
                    sublistId: 'inventoryassignment'
                });
            }

            return true;

        } catch (e) {
            log.error('inventoryAssignment error', e);
            return false;
        }
    }

     function getBinInventoryDetail(params) {
        try {
            //  var scriptStartTime = new Date().getTime();

            var scriptObj = runtime.getCurrentScript();
            
             log.error("request params ", JSON.stringify(params));

            var binSearchId = scriptObj.getParameter({ name: 'custscript_wms_ai_bin_based_inv_detail' });
           // log.error('binSearchId', binSearchId);
            var binId = params.binId || params;

            var bulkBinItemQtymap = fetchBulkStageBinTracking(binId);

           // log.error("bulkBinItemQtymap ", JSON.stringify(bulkBinItemQtymap));
            

            var binSearch = search.load({
                id: binSearchId,
                type: 'item'
            });        

            var filters = binSearch.filters || [];

            if (binId) {
                try {
                    filters.push(search.createFilter({
                        name: 'binnumber',
                        join: 'binonhand',
                        operator: search.Operator.ANYOF,
                        values: binId
                    }));

                    // log.audit("binid", binId);
                }
                catch (e) {
                    response = e.message + " - " + binId;
                }
            }

            binSearch.filters = filters;

            // Ensure we have internalid in columns
            var columns = binSearch.columns ? binSearch.columns.slice() : [];

            var totalCount = binSearch.runPaged().count;

            var totalPages = Math.ceil(totalCount / params.pageSize);
            var searchResult = binSearch.run();

            var inputItemIds = [];
            var recordData = {};
            var binsAvailable = new Array();
            binSearch.run().each(function (result) {

              var binInternalId = result.getValue({
                    name: 'binnumber',
                    join: 'binOnHand'
                });
                
                binsAvailable.push(binInternalId);
                //  log.audit(" binNumber ", binInternalId);
                var data = {}
                //   var columnName = (column.label || column.name);
              
                var itemId = result.getValue('internalid');
                
			    if (itemId && !inputItemIds.includes(itemId)) {
                 inputItemIds.push(itemId.toString());
                 }

                // Initialize item group
                if (!recordData[binInternalId]) {
                    recordData[binInternalId] = {
                        binId: binInternalId,
                        itemDetails: []
                    };
                }

    result.columns.forEach(function (column) {
    var columnName = toSnakeCase(column.label || column.name);

    var binInternalId = result.getValue({ name: 'binnumber', join: 'binOnHand' });
    if (binInternalId) {
        data['bin_internal_id'] = binInternalId.toString();
    }
       if (columnName == 'location') {
        data['loc_internalid'] = result.getValue(column) || " ";
        data['location'] = result.getText(column) || " ";
     } 
      
    else if (columnName === 'on_hand') {
        var itemId = result.getValue({ name: 'internalid' });
        var binOnHandQty = result.getValue(column); // from binOnHand join
        var extraQty = bulkBinItemQtymap[itemId]?.on_hand || 0;
        var finalQty = Number(binOnHandQty) + Number(extraQty);
        data[columnName] = finalQty.toString();
    } else if (columnName === 'available') {
        var itemId = result.getValue({ name: 'internalid' });
        var onHandQty = result.getValue({ name: 'quantityonhand', join: 'binOnHand' });
        var extraQty = bulkBinItemQtymap[itemId]?.on_hand || 0;
        var finalQty = Number(onHandQty) + Number(extraQty);
        data[columnName] = finalQty.toString();
    } else {
        var value = result.getText(column) || result.getValue(column);
       data['status'] = " ";
        data[columnName] = value != null ? value.toString() : '';
    }
});
                recordData[binInternalId].itemDetails.push(data);

                return true
            });

                try {
                    if (Object.keys(bulkBinItemQtymap).length != 0) {
                        Object.keys(bulkBinItemQtymap).forEach(function (itemId) {
                            if (!inputItemIds.includes(itemId)) {
                                recordData[binId].itemDetails.push(bulkBinItemQtymap[itemId])
                            }
                        });
                    }
                } catch (e) {
                    log.error("Error in getBinInventoryDetail", e);
                }

                // If recordData is empty, return the specified structure
                if (Object.keys(recordData).length == 0) {
                    recordData[binId] = {
                        binId: binId.toString(),
                        itemDetails: []
                    };
                }
            log.emergency("recordData", JSON.stringify(recordData));

            return {
                status: 200,
                message: 'Data retrieved successfully',
                data: recordData
            };

        } catch (e) {
            log.error("Error in Bin ", e);
            // response  =  e.message
            return {
                status: 500,
                message: e.message
            };
        }
    }


     function getBins(context, pageSize, startIndex) {
        try {
            var ScriptStartTime = new Date().getTime();
           // log.error('Script Started', 'Start Time: ' + ScriptStartTime / 1000 + ' seconds');

            var scriptObj = runtime.getCurrentScript();
            var BinSearchId = scriptObj.getParameter({ name: 'custscript_wms_ai_bins' });
    
            var Data = {};

            var BinSearch = search.load({ id: BinSearchId });

            // Get total count using runPaged().count
            var totalCount = BinSearch.runPaged().count;
            var totalPages = Math.ceil(totalCount / pageSize);

            // Apply pagination
            var searchResult = BinSearch.run();
            var searchRange = searchResult.getRange({ start: startIndex, end: startIndex + pageSize });

            searchRange.forEach(function (result) {
                var internalId = result.getValue({ name: 'internalid' });
                var recordData = {};

                result.columns.forEach(function (column) {
                    var columnName = toSnakeCase(column.label || column.name);
                    recordData[columnName] = result.getText(column) || result.getValue(column);
                });
                Data[internalId] = recordData;
            });

            var ScriptEndTime = new Date().getTime();
           // log.debug('Total Execution Time', ((ScriptEndTime - ScriptStartTime) / 1000) + ' seconds');



            return {
                status: 200,
                message: 'Data retrieved successfully',
                summary: {
                    total_records: totalCount,
                    total_pages: totalPages,
                    records_per_page: pageSize,
                    current_page: Math.floor(startIndex / pageSize) + 1,
                    pagination_info: {
                        start_index: startIndex,
                        end_index: startIndex + pageSize - 1,
                        has_next_page: (startIndex + pageSize) < totalCount,
                        has_previous_page: startIndex > 0
                    }
                },
                data: Data
            };

        } catch (e) {
            log.error("error message", e.message);

            return {
                status: 500,
                message: e.message
            };
        }
    }
	

     function toSnakeCase(str) {
        return str
            .trim()
            .replace(/[^a-zA-Z0-9 ]/g, '')
            .replace(/\s+/g, '_')
            .toLowerCase();
    }

    return {
        binCount: binCount,
        binAdjustment: binAdjustment,
        binTransfer: binTransfer,
        getBinInventoryDetail: getBinInventoryDetail,
		getBins : getBins
    };
});
