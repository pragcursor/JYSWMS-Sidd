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


            // if (newRec.getValue('custrecord_jyswmws_perform_update')) {
            //   return;
            // }
            var isApproved = newRec.getValue('custrecord_jyswms_approved');
            var itemFulfill = newRec.getValue('custrecord_jyswms_rel_item_ful');
            var salesOrderId = newRec.getValue('custrecord_jyswms_sales_order_id');
            var carrierProNumber = newRec.getValue('custrecord_jyswms_carrier_pro_number');
            var isPackageUpdated = newRec.getValue('custrecord_jyswms_package_updated');
            var isAmazonUpdated = newRec.getValue('custrecord_jyswms_amzcc_updated');
            var isUpsPackageUpdated = newRec.getValue('custrecord_jswms_order_ups_packges');
            var shipVia = newRec.getValue('custrecord_jyswms_order_ship_via');
            var canadaCustomerId = newRec.getValue({ fieldId: 'custrecord_jyswms_customer_frm_so' });

            var status = newRec.getValue('custrecord_jyswms_order_status');

            // if (status == '18' || status == '17') {

            //   if(!itemFulfill) {
            //   itemFulfill =  true;
            // // isPackageUpdated = true;
            //   isUpsPackageUpdated = true;
            //   }
            // }
            //   if (salesOrderId != "62919500") {


            // log.debug("salesOrderId ",{
            //     salesOrderId: salesOrderId,
            //     recordId: recordId
            //   });

            //   return;
            // }



            var donttrigger = newRec.getValue('custrecord_jys_dont_trigger');
            if (donttrigger && carrierProNumber) {
                log.debug("salesOrderId --donttrigger", {
                    salesOrderId: salesOrderId,
                    recordId: recordId
                });

                //salesOrderId = "62919500";
            }
            if (!isApproved) {
                return;
            }

            if (!carrierProNumber && shipVia == '57733') {

                log.debug("salesOrderId -- no carrier", {
                    salesOrderId: salesOrderId,
                    recordId: recordId
                });

            }
            var locationId = "";

            if (salesOrderId) {
                var locationLookup = search.lookupFields({
                    type: search.Type.SALES_ORDER,
                    id: salesOrderId,
                    columns: ['location', 'entity']
                });

                locationId = (locationLookup.location && locationLookup.location.length)
                    ? locationLookup.location[0].value
                    : null;

                canadaCustomerId = (locationLookup.entity && locationLookup.entity.length)
                    ? locationLookup.entity[0].value
                    : null;
            }

            // Determine execution conditions

            var allowedCustomers = ['476', '1807'];

            var ltlCustomer = false;

            // Only lookup checkbox if P/U
            if (shipVia == '57733') {

                var customerLookup = search.lookupFields({
                    type: search.Type.CUSTOMER,
                    id: canadaCustomerId,
                    columns: ['custentity_wms_ltl_customer']
                });

                ltlCustomer = customerLookup.custentity_wms_ltl_customer || false;

                // if (!ltlCustomer) {
                //     log.debug("Skipping script - P/U order but LTL checkbox not checked", {
                //         shipVia: shipVia,
                //         customerId: canadaCustomerId
                //     });
                //     return;
                // }
            }

            // Non P/U orders
            if (shipVia != '57733' && !allowedCustomers.includes(String(canadaCustomerId))) {

                log.debug("Skipping script - Non P/U order and customer not allowed", {
                    shipVia: shipVia,
                    customerId: canadaCustomerId
                });

                return;
            }

            log.debug("Script execution allowed", {
                shipVia: shipVia,
                customerId: canadaCustomerId
            });


            //  if (!shipVia || shipVia != 57733) {

            if (shipVia != '57733') {
                // if ((canadaCustomerId != 476) && (canadaCustomerId != 473) && (canadaCustomerId != 1807)) {
                //     return;
                // }

                if (itemFulfill) {

                    var trackingObj = trackingLines(recordId);

                    if (!isUpsPackageUpdated) {
                      //  log.error(" isUpsPackageUpdated", trackingObj);
                        var updatedRecord = createPackages(trackingObj, itemFulfill);

                        record.submitFields({
                            type: 'customrecord_order_fulfillment_details',
                            id: recordId,
                            values: {
                                custrecord_jswms_order_ups_packges: true
                            }
                        });



                        // return;
                    }

                    if (!isPackageUpdated) {


                        // log.error(" isUpsPackageContentUpdated", trackingObj);
                        var updatedRecord = createPackageContent(trackingObj, itemFulfill, shipVia, canadaCustomerId, recordId);

                        record.submitFields({
                            type: 'customrecord_order_fulfillment_details',
                            id: recordId,
                            values: {
                                custrecord_jyswms_package_updated: true
                            }
                        });
                        // return;
                    }

                    if (!isAmazonUpdated) {
                       // log.error(" isAmazonUpdated");
                        var updatedRecord = createAmazonRecords(trackingObj, salesOrderId, shipVia);
                        // return;
                    }

                    record.submitFields({
                        type: 'customrecord_order_fulfillment_details',
                        id: recordId,
                        values: {
                            custrecord_jyswms_processing_lock: true
                        }
                    });


                }

                // record.submitFields({
                //   type: 'customrecord_order_fulfillment_details',
                //   id: recordId,
                //   values: {
                //     custrecord_jyswms_processing_lock: true
                //   }
                // });

                return;

            }


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



            // Build final object
            var obj = {};
            obj[salesOrderId] = {
                salesOrderId: salesOrderId,   // safer explicit assignment
                lines: lines,
                trackingNumbers: trackingObj,
                ssccCodes: ssccCodes
            };

           // log.error('Fulfillment Object', JSON.stringify(obj, null, 2));

            //  var packageIds = getInternalIdsBySsccCodes(ssccCodes);
            //log.error('packageIds Object', JSON.stringify(packageIds, null, 2));

           // log.error('canadaCustomerId', canadaCustomerId);


            if ((itemFulfill && carrierProNumber)
                || canadaCustomerId == "1807"
                || canadaCustomerId == "473") {

              //  log.error('canadaCustomerId -', canadaCustomerId);

                if (!isPackageUpdated) {
                    var res = createPackageRecords(ssccCodes, trackingObj, itemFulfill, carrierProNumber, recordId);
                    // log.error("isPackageUpdated", res);
                }

                if (!isAmazonUpdated) {
                    var res = regularCreateAmazonRecords(trackingObj, salesOrderId);
                    // log.error("amazon records update", res);
                }


            }


            // if ((isPackageUpdated && !isAmazonUpdated && carrierProNumber && itemFulfill) || (canadaCustomerId == "473") || (canadaCustomerId == "1807")) {
            //     log.error('canadaCustomerId --', canadaCustomerId);
            //     var res = regularCreateAmazonRecords(trackingObj, salesOrderId);
            //     log.error("res", res);
            // }

        } catch (e) {
            log.error('afterSubmit error', e.message);
        }
    }



    // Ups Package update
    function createPackages(trackingObj, fulfillmentId) {
        try {


            // CASE 1: Create new package records if none found
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

            var removecount = 0;
            for (var i = existingCount - 1; i >= 0; i--) {
                fulfillmentRec.removeLine({ sublistId, line: i });
                removecount++;
            }

           // log.error("removedcount", removecount)

            // Add new package lines
            var packageBoxNumber = 0;
            var lastRecordId = null;
            var seenTrackingNumbers = {};

            trackingObj.forEach(function (line) {


                var tracking = line.tracking;

                // // Skip if tracking number is empty
                // if (!tracking) {
                //     return;
                // }

                //Skip duplicate tracking numbers
                if (seenTrackingNumbers[tracking]) {
                    log.debug('Duplicate tracking skipped', tracking);
                    return;
                }

                //Mark as processed
                seenTrackingNumbers[tracking] = true;


                lastRecordId = line.recordId;
                packageBoxNumber++;

                fulfillmentRec.selectNewLine({ sublistId });



                var fieldMap = {
                    packageweight: line.weight || 1,
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
                            //log.debug('Skipped field', `${fieldId} - ${err.message}`);
                        }
                    }
                });

                fulfillmentRec.commitLine({ sublistId });
               // log.error('Package line added', JSON.stringify(fieldMap));
            });

            fulfillmentRec.save({
                enableSourcing: true,
                ignoreMandatoryFields: true
            });

            // log.error('New Packages Created', `Fulfillment ID: ${fulfillmentId}`);
            //  }

        } catch (error) {
            log.error("error while updating create packaes", error.message)
        }
    }

    // ups packages
    function createPackageContent(trackingObj, fulfillmentId, shipVia, canadaCustomerId, recordId) {
        try {
            // if (!packageIds || packageIds.length === 0) {
            //    log.error("packageIds.length - ",packageIds.length );

            var fulfillmentRec = record.load({
                type: record.Type.ITEM_FULFILLMENT,
                id: fulfillmentId,
                isDynamic: true
            });
            var packageBoxNumber = 0;

            var sublistId = 'recmachcustrecord_hj_packagecontents_sublist';
            var existingCount = fulfillmentRec.getLineCount({ sublistId });
           // log.error("existingCount - recmachcustrecord_hj_packagecontents_sublist ", existingCount)

            var removecount = 0;

            // Clear existing package lines
            for (var i = existingCount - 1; i >= 0; i--) {
                fulfillmentRec.removeLine({ sublistId, line: i, ignoreRecalc: true });
                removecount++;
            }
            // log.error("removedcount", removecount);

            // Add new package lines
            // var packageBoxNumber = 0;
            var lastRecordId = null;
            var seenTrackingNumbers = {};

            // log.error('trackingObj', trackingObj);
            trackingObj.forEach(function (line) {

                var tracking = line.tracking;



                // Skip if tracking number is empty
                if (!tracking) {
                    return;
                }



                if (canadaCustomerId == "1807" || canadaCustomerId == "476") {
                    //Skip duplicate tracking numbers
                    if (seenTrackingNumbers[tracking]) {
                        // log.error('Duplicate tracking skipped', tracking);
                        return;
                    }


                }





                //Mark as processed
                seenTrackingNumbers[tracking] = true;

                lastRecordId = line.recordId;

                packageBoxNumber++;

                fulfillmentRec.selectNewLine({ sublistId });

                var fieldMap = {
                    custrecordhj_pkg_pallet: line.palletNumber,
                    custrecordhj_pkgbox: packageBoxNumber,
                    custrecordhj_tc_packagecontentslbs: line.weight || 1,
                    custrecordhj_ucc: line.ssccCode,
                    custrecord_jyswms_related_cif: recordId,
                    custrecord_jyswms_createdfrom: true,
                    custrecordhj_pkg_trackingnumber: line.bolTrackingNumber || line.tracking,
                    custrecordhj_pkg_desc: line.itemName + '/1',
                    custrecord_jyswms_item_not_populated: true
                };

                Object.keys(fieldMap).forEach(function (fieldId) {

                    // log.error("fieldMap", JSON.stringify(fieldMap));

                    var value = fieldMap[fieldId];
                    if (value !== null && value !== '' && value !== undefined) {
                        try {
                            fulfillmentRec.setCurrentSublistValue({
                                sublistId: sublistId,
                                fieldId: fieldId,
                                value: value
                            });
                        } catch (err) {
                            log.error('Skipped field', `${fieldId} - ${err.message}`);
                        }
                    }
                });

                fulfillmentRec.commitLine({ sublistId });
                // log.debug('Package line added', JSON.stringify(fieldMap));
            });

            fulfillmentRec.save({
                enableSourcing: true,
                ignoreMandatoryFields: true
            });



            log.audit('New Packages Created', `Fulfillment ID: ${fulfillmentId}`);
            //}
        } catch (error) {
            log.error('Package Error FULL', JSON.stringify(error));
        }
    }


    // ups AMZCC Records

    function createAmazonRecords(trackingObj, salesOrderId, shipMethod) {
        try {
            if (!trackingObj || !trackingObj.length) {
                log.debug('No SSCC codes provided, skipping Amazon record creation');
                return;
            }
            // log.error("trackingObj", trackingObj);
            // log.error("salesOrderId", salesOrderId);
            var salesOrderRec = record.load({
                type: record.Type.SALES_ORDER,
                id: salesOrderId,
                isDynamic: true
            });

            var sublistId = 'recmachcustrecord_sales_order_id';
            var recordId = '';
            var packageBoxNumber = 0;

            // Track duplicates
            var seenTrackingNumbers = {};

            trackingObj.forEach(function (line) {

                var tracking = line.tracking;

                //  Skip empty tracking
                // if (!tracking) {
                //     return;
                // }

                //  Normalize tracking

                if (shipMethod != 88124) {
                    tracking = String(tracking).trim().toUpperCase();

                    //  Skip duplicate tracking
                    if (seenTrackingNumbers[tracking]) {
                        log.debug('Duplicate Amazon tracking skipped', tracking);
                        return;
                    }

                    // Mark as processed
                    seenTrackingNumbers[tracking] = true;

                }

                recordId = line.recordId;
                packageBoxNumber++;

                salesOrderRec.selectNewLine({ sublistId: sublistId });

                // SSCC handling
                var amzccCode = line.ssccCode;
                if (amzccCode) {
                    amzccCode = String(amzccCode);
                    amzccCode = amzccCode.slice(2);
                }

                var fieldMap = {
                    custrecord_sales_order_id: salesOrderId,
                    custrecord_amzcc_code: amzccCode,
                    custrecord_itemid: line.itemName,
                    custrecord_ucc_code: line.upcCode,
                    custrecord_wms_bulkbatch_picking: 22306500,
                    custrecord_ponumber: line.poNumber,
                    custrecord_pallet_sscc_code: line.palletNumber,
                    custrecord_bol_tracking_number: line.bolTrackingNumber,
                    custrecord_trackingnumber: tracking
                };

                for (var fieldId in fieldMap) {
                    if (fieldMap[fieldId] !== null && fieldMap[fieldId] !== '' && fieldMap[fieldId] !== undefined) {
                        try {
                            salesOrderRec.setCurrentSublistValue({
                                sublistId: sublistId,
                                fieldId: fieldId,
                                value: fieldMap[fieldId]
                            });
                        } catch (err) {
                            log.debug(
                                'Skipped field',
                                fieldId + ' - ' + err.message
                            );
                        }
                    }
                }

                //log.audit('Amazon Record line added', JSON.stringify(fieldMap));
                salesOrderRec.commitLine({ sublistId: sublistId });
            });

            salesOrderRec.save({
                enableSourcing: true,
                ignoreMandatoryFields: true
            });

            log.audit('Amazon Records linked successfully', 'Sales Order ID: ' + salesOrderId);

            if (recordId) {
                record.submitFields({
                    type: 'customrecord_order_fulfillment_details',
                    id: recordId,
                    values: {
                        custrecord_jyswms_amzcc_updated: true
                    }
                });
            }

        } catch (e) {
            log.error('Error linking Amazon Records', e.message);
        }
    }

    function regularCreateAmazonRecords(trackingObj, salesOrderId) {
        try {
            if (!trackingObj || !trackingObj.length) {
                log.debug('No SSCC codes provided, skipping Amazon record creation');
                return;
            }
           // log.error("trackingObj", trackingObj);
            // log.error("salesOrderId", salesOrderId);
            var salesOrderRec = record.load({
                type: record.Type.SALES_ORDER,
                id: salesOrderId,
                isDynamic: true
            });

            var sublistId = 'recmachcustrecord_sales_order_id';
            var recordId = '';
            var packageBoxNumber = 0;

            // Track duplicates
            // var seenTrackingNumbers = {};

            trackingObj.forEach(function (line) {

                var tracking = line.tracking;

                //  Skip empty tracking
                // if (!tracking) {
                //     return;
                // }

                //  Normalize tracking
                // tracking = String(tracking).trim().toUpperCase();

                // //  Skip duplicate tracking
                // if (seenTrackingNumbers[tracking]) {
                //     log.debug('Duplicate Amazon tracking skipped', tracking);
                //     return;
                // }

                // // Mark as processed
                // seenTrackingNumbers[tracking] = true;

                recordId = line.recordId;
                packageBoxNumber++;

                salesOrderRec.selectNewLine({ sublistId: sublistId });

                // SSCC handling
                var amzccCode = line.ssccCode;
                if (amzccCode) {
                    amzccCode = String(amzccCode);
                    amzccCode = amzccCode.slice(2);
                }

                var fieldMap = {
                    custrecord_sales_order_id: salesOrderId,
                    custrecord_amzcc_code: amzccCode,
                    custrecord_itemid: line.itemName,
                    custrecord_ucc_code: line.upcCode,
                    custrecord_wms_bulkbatch_picking: 22306500,
                    custrecord_ponumber: line.poNumber,
                    custrecord_pallet_sscc_code: line.palletNumber,
                    custrecord_bol_tracking_number: line.bolTrackingNumber,
                    custrecord_trackingnumber: tracking
                };

                for (var fieldId in fieldMap) {
                    if (fieldMap[fieldId] !== null && fieldMap[fieldId] !== '' && fieldMap[fieldId] !== undefined) {
                        try {
                            salesOrderRec.setCurrentSublistValue({
                                sublistId: sublistId,
                                fieldId: fieldId,
                                value: fieldMap[fieldId]
                            });
                        } catch (err) {
                            log.debug(
                                'Skipped field',
                                fieldId + ' - ' + err.message
                            );
                        }
                    }
                }

                // log.audit('Amazon Record line added', JSON.stringify(fieldMap));
                salesOrderRec.commitLine({ sublistId: sublistId });
            });

            salesOrderRec.save({
                enableSourcing: true,
                ignoreMandatoryFields: true
            });

            log.audit('Amazon Records linked successfully', 'Sales Order ID: ' + salesOrderId);

            if (recordId) {
                record.submitFields({
                    type: 'customrecord_order_fulfillment_details',
                    id: recordId,
                    values: {
                        custrecord_jyswms_amzcc_updated: true
                    }
                });
            }

        } catch (e) {
            log.error('Error linking Amazon Records', e.message);
        }
    }

    /**
   * Create or link package records to the Item Fulfillment
   * @param {Array} ssccCodes - list of SSCC codes
   * @param {Array} trackingObj - list of tracking data (each item = {recordId, palletNumber, weight, ssccCode, bolTrackingNumber, itemName})
   * @param {Number} fulfillmentId - internal ID of the Item Fulfillment
   */
    function createPackageRecords(ssccCodes, trackingObj, fulfillmentId, carrierProNumber, recordId) {
        try {

            // log.error("Debug Info", {
            //     ssccCodes: ssccCodes,
            //     trackingObj: trackingObj,
            //     fulfillmentId: fulfillmentId
            // });
            var carrierProNumber = carrierProNumber;


            if (!ssccCodes || !ssccCodes.length) {
                log.debug('No SSCC codes provided', 'Skipping package creation');
                return;
            }

            // Get existing package IDs
            var packageIds = getInternalIdsBySsccCodes(ssccCodes);
            // log.error("packageIds", packageIds);

            // CASE 1: Create new package records if none found
            if (!packageIds || packageIds.length === 0) {
                // log.error("packageIds.length - ", packageIds.length);

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
                var packageBoxNumber = 1;
                var lastRecordId = null;

                trackingObj.forEach(function (line) {
                    lastRecordId = line.recordId;
                    // packageBoxNumber++;
                    fulfillmentRec.selectNewLine({ sublistId });

                    var fieldMap = {
                        custrecordhj_pkg_pallet: line.palletNumber,
                        custrecordhj_pkgbox: packageBoxNumber,
                        custrecordhj_tc_packagecontentslbs: line.weight || 1,
                        custrecordhj_ucc: line.ssccCode,
                        custrecord_jyswms_related_cif: recordId,
                        custrecord_jyswms_createdfrom: true,
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
                                log.error('Skipped field', `${fieldId} - ${err.message}`);
                            }
                        }
                    });

                    packageBoxNumber++;

                    fulfillmentRec.commitLine({ sublistId });
                  // log.debug('Package line added', JSON.stringify(fieldMap));
                });

                fulfillmentRec.save({
                    enableSourcing: true,
                    ignoreMandatoryFields: true
                });

                log.audit('New Packages Created', `Fulfillment ID: ${fulfillmentId}`);
            }

            // CASE 2: Packages already exist → link them to fulfillment
            else {

              //  log.debug('Existing Package IDs', packageIds);

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
                        // log.error("linesremovedCount", linesremovedCount);
                    }
                } catch (error) {
                    log.error("error while lines ", error)
                }

                var packageBoxNumber = 0;

                packageIds.forEach(function (pkgId) {
                    packageBoxNumber++;
                    try {
                        record.submitFields({
                            type: 'customrecordhj_tc_package_contents',
                            id: pkgId,
                            values: {
                                custrecord_hj_packagecontents_sublist: fulfillmentId,
                                custrecordhj_pkg_trackingnumber: carrierProNumber,
                                custrecord_jyswms_related_cif: recordId,
                                custrecord_jyswms_createdfrom: true,
                                custrecordhj_pkgbox: packageBoxNumber,
                            }
                        });

                        // log.debug('Linked Existing Package', {
                        //     packageId: pkgId,
                        //     fulfillmentId: fulfillmentId
                        // });
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
            // log.error("linesCountwithNoPlattet", linesCountwithNoPlattet);

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
                    // log.debug('Fulfillment Detail Updated', `Record ID: ${firstTracking.recordId}`);
                }
            }

            log.audit('Package Processing Complete', `Fulfillment: ${fulfillmentId}`);

        } catch (e) {
            log.error('Error in createPackageRecords', e);
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
            log.error("Error in trackingLines", e);
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
            log.error('Error in InternalIdsBySsccCodes', e);
        }
        return ids;
    }

    function beforeSubmit(context) {
        try {
            var rec = context.newRecord;
            var form = context.form;
            var shipvia = rec.getValue({ fieldId: 'custrecord_jyswms_order_ship_via' });
            var customer = rec.getValue({ fieldId: 'custrecord_jyswms_customer_frm_so' });
            if (shipvia == 59691 && (customer != 1807 || customer != 476)) {

                var lineCount = rec.getLineCount({ sublistId: 'recmachcustrecord_jyswms_so_header' });
                for (var i = 0; i < lineCount; i++) {
                    var tracking_dropship = rec.getSublistValue({
                        sublistId: 'recmachcustrecord_jyswms_so_header',
                        fieldId: 'custrecord_jyswms_track_dropship',
                        line: i
                    });
                    var track_ssc = rec.getSublistValue({
                        sublistId: 'recmachcustrecord_jyswms_so_header',
                        fieldId: 'custrecord_jyswms_track_number',
                        line: i
                    });
                    if (!tracking_dropship && track_ssc) {
                        rec.setSublistValue({
                            sublistId: 'recmachcustrecord_jyswms_so_header',
                            fieldId: 'custrecord_jyswms_track_dropship',
                            line: i,
                            value: track_ssc
                        });
                        rec.setSublistValue({
                            sublistId: 'recmachcustrecord_jyswms_so_header',
                            fieldId: 'custrecord_jyswms_track_number',
                            line: i,
                            value: ''
                        });
                    }
                }
            }
        } catch (e) {
            log.error('beforeLoad error', e);
        }
    }

    return { afterSubmit: afterSubmit, beforeSubmit: beforeSubmit };

});