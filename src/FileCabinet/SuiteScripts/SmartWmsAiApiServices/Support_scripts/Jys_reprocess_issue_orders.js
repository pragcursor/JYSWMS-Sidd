/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 */
define([
    'N/ui/serverWidget',
    'N/record',
    'N/https',
    'N/log',
    'N/search',
    '../JYSWMS_generateToken_API.js'
], function (ui, record, https, log, search, tokenModule) {

    /* ======================================
       ENTRY
    ====================================== */
    function onRequest(context) {

        /*  if (context.request.method === 'GET') {
      //        return buildForm(context);
          }
  */
        var soId = context.request.parameters.custpage_soid;
        var form = ui.createForm({ title: 'WMS Fulfillment Result' });

        try {

            if (!soId) throw 'Sales Order Internal ID required.';

            /* ========= CALL WMS ========= */
            // var wmsLines = callWmsApi(soId);
            // var pickMap = buildPickMapByItem(wmsLines);
            var wmsLines = callWmsApi(soId);

            var pickMap = buildPickMapByItem(wmsLines);

            var allTracking = extractTrackingNumbers(wmsLines);

            var existingTracking = getExistingTrackingNumbers(allTracking);

            pickMap = filterPickedTracking(pickMap, existingTracking);
            if (!Object.keys(pickMap).length) {
                throw 'No picked lines returned from WMS.';
            }



            var salesOrderRecord = record.load({
                type: record.Type.SALES_ORDER,
                id: soId,
                isDynamic: true
            });
            var orderStatus = salesOrderRecord.getValue({ fieldId: 'status' });
            var shipvia = salesOrderRecord.getValue({ fieldId: 'shipmethod' });
            var customer = salesOrderRecord.getValue({ fieldId: 'entity' });
            if (orderStatus == 'Billed') {
                throw 'Sales Order is Billed. Cannot be processed.';
            }

            if (customer == 476 || customer == 1807) {
                throw 'Customer is Amazon. Cannot be processed.';
            }




            var headerLocationId = salesOrderRecord.getValue({ fieldId: 'location' });
            var singleIf = salesOrderRecord.getValue({ fieldId: 'custbody_wms_so_single_if' });
            var nonHeaderLocationItems = [];
            if (singleIf) {
                var notPicked = wmsLines.filter(function (line) {
                    return line.is_picked !== 'picked';
                });

                if (notPicked.length) {
                    throw 'Single IF requires ALL items picked.';
                }

                var lineCount = salesOrderRecord.getLineCount({ sublistId: 'item' });
                for (var i = 0; i < lineCount; i++) {
                    salesOrderRecord.selectLine({ sublistId: 'item', line: i });
                    var itemId = salesOrderRecord.getCurrentSublistValue({ sublistId: 'item', fieldId: 'item' });
                    var locationId = salesOrderRecord.getCurrentSublistValue({ sublistId: 'item', fieldId: 'location' });
                    if (locationId !== headerLocationId) {
                        var quantity = salesOrderRecord.getCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity' });
                        nonHeaderLocationItems.push({
                            itemId: itemId,
                            locationId: locationId,
                            headerLocationId: headerLocationId,
                            quantity: quantity
                        });

                    }
                }

            }

            nonHeaderLocationItems.forEach(function (item) {
                var itemId = item.itemId;
                var locationId = item.locationId;
                var quantity = item.quantity;
                var stageBinId = getStageBinByLocation(locationId);
                var headerStageBinId = getStageBinByLocation(headerLocationId);

                var checkBinExists = getInventoryByItemAndBin(itemId, stageBinId, quantity, locationId);

                if (checkBinExists) {
                    createInventoryTransfer(itemId, quantity, locationId, headerLocationId, stageBinId, headerStageBinId, soId);
                }
            });

            /* ========= TRANSFORM ========= */
            var fulfillment = record.transform({
                fromType: record.Type.SALES_ORDER,
                fromId: soId,
                toType: record.Type.ITEM_FULFILLMENT,
                isDynamic: true
            });

            fulfillment.setValue({
                fieldId: 'shipstatus',
                value: 'C'
            });


            var itemLineCount = fulfillment.getLineCount({ sublistId: 'item' });
            var hasFulfillLines = false;
            var packageIndexMap = {};
            var allTrackingArray = [];

            /* ========= PROCESS ITEM LINES ========= */
            for (var i = 0; i < itemLineCount; i++) {

                fulfillment.selectLine({ sublistId: 'item', line: i });

                if (singleIf) {
                    var lineLocationIdvalue = fulfillment.getCurrentSublistValue({
                        sublistId: 'item',
                        fieldId: 'location'
                    });
                    if (lineLocationIdvalue != headerLocationId) {
                        fulfillment.setCurrentSublistValue({
                            sublistId: 'item',
                            fieldId: 'location',
                            value: headerLocationId
                        });
                        //  fulfillment.commitLine({ sublistId: 'item' });

                    }
                }

                var itemIdInternal = fulfillment.getCurrentSublistValue({
                    sublistId: 'item',
                    fieldId: 'item'
                });


                var itemText = fulfillment.getCurrentSublistValue({
                    sublistId: 'item',
                    fieldId: 'item'
                });
                itemText = getItemNameById(itemIdInternal) || itemText;

                var remainingQty = Number(
                    fulfillment.getCurrentSublistValue({
                        sublistId: 'item',
                        fieldId: 'quantityremaining'
                    })
                ) || 0;
                var lineLocationId = Number(fulfillment.getCurrentSublistValue({
                    sublistId: 'item',
                    fieldId: 'location'
                }));

                if (singleIf) {
                    lineLocationId = headerLocationId;
                }
                var stageBinId = getStageBinByLocation(lineLocationId);

                var checkBinExists = getInventoryByItemAndBin(itemIdInternal, stageBinId, remainingQty, lineLocationId);

                if (!checkBinExists) {
                    throw 'Inventory not found for item: ' + itemText + ' in bin: ' + stageBinId;
                }
                log.debug('Processing Item Line', {
                    item: itemText,
                    remainingQty: remainingQty
                });

                /* ========= SAFETY CHECK ========= */
                if (!pickMap[itemText] || remainingQty <= 0) {

                    fulfillment.setCurrentSublistValue({
                        sublistId: 'item',
                        fieldId: 'itemreceive',
                        value: false
                    });

                    fulfillment.commitLine({ sublistId: 'item' });
                    continue;
                }

                /* ========= DETERMINE FULFILL QTY ========= */
                var availablePickedQty = pickMap[itemText].qty;

                var qtyToFulfill = Math.min(
                    availablePickedQty,
                    remainingQty
                );

                if (qtyToFulfill <= 0) {
                    fulfillment.commitLine({ sublistId: 'item' });
                    continue;
                }

                hasFulfillLines = true;

                var itemWeight = getItemWeight(itemIdInternal);

                /* ========= SET FULFILLMENT VALUES ========= */
                fulfillment.setCurrentSublistValue({
                    sublistId: 'item',
                    fieldId: 'itemreceive',
                    value: true
                });

                fulfillment.setCurrentSublistValue({
                    sublistId: 'item',
                    fieldId: 'quantity',
                    value: qtyToFulfill
                });

                assignInventoryDetail(
                    fulfillment,
                    qtyToFulfill,
                    stageBinId
                );

                fulfillment.commitLine({ sublistId: 'item' });

                /* ========= CREATE PACKAGE LINES ========= */
                var trackingList = pickMap[itemText].tracking.slice(0, qtyToFulfill);

                trackingList.forEach(function (trackObj) {

                    var trackingNumber = trackObj.trackingNumber;
                    if (!trackingNumber) return;

                    if (!packageIndexMap[trackingNumber]) {

                        fulfillment.selectNewLine({ sublistId: 'package' });

                        fulfillment.setCurrentSublistValue({
                            sublistId: 'package',
                            fieldId: 'packagetrackingnumber',
                            value: trackingNumber
                        });

                        fulfillment.setCurrentSublistValue({
                            sublistId: 'package',
                            fieldId: 'packageweight',
                            value: itemWeight > 0 ? itemWeight : 1
                        });

                        fulfillment.commitLine({ sublistId: 'package' });

                        packageIndexMap[trackingNumber] = true;
                    }

                    allTrackingArray.push({
                        trackingNumber: trackingNumber,
                        SSCC: trackObj.SSCC,
                        itemName: itemText
                    });
                });

                /* ========= REDUCE PICK MAP QTY ========= */
                pickMap[itemText].qty -= qtyToFulfill;

                if (pickMap[itemText].qty <= 0) {
                    delete pickMap[itemText];
                }
            }

            if (!hasFulfillLines) {
                throw 'No lines qualified for fulfillment.';
            }

            /* ========= SAVE FULFILLMENT ========= */
            var fulfillmentId = fulfillment.save({
                enableSourcing: true,
                ignoreMandatoryFields: true
            });

            /* ========= CREATE CUSTOM PACKAGE CONTENT ========= */
            createCustomPackageContents(
                fulfillmentId,
                allTrackingArray
            );

            form.addField({
                id: 'custpage_success',
                type: ui.FieldType.INLINEHTML,
                label: ' '
            }).defaultValue =
                '<h3 style="color:green">Fulfillment Created</h3>' +
                '<p>ID: ' + fulfillmentId + '</p>';

        } catch (e) {

            log.error('Fulfillment Error', e);
            const now = new Date();
            const estOffset = -5 * 60 * 60 * 1000; // -5 hours in milliseconds
            const estTimestamp = now.getTime() + estOffset;
            const estDate = new Date(estTimestamp);
            var salesOrderRecord = record.load({
                type: record.Type.SALES_ORDER,
                id: soId,
                isDynamic: true
            });
            salesOrderRecord.setValue({
                fieldId: 'custbody_jyswms_fufilment_error',
                value: 'Timestamp: ' + estDate + ' - Error: ' + e
            });
            salesOrderRecord.save({
                enableSourcing: true,
                ignoreMandatoryFields: true
            });

            form.addField({
                id: 'custpage_error',
                type: ui.FieldType.INLINEHTML,
                label: ' '
            }).defaultValue =
                '<h3 style="color:red">Error</h3>' +
                '<p>' + e + '</p>';
        }

        context.response.writePage(form);
    }
    function createInventoryTransfer(itemId, quantity, fromLocation, toLocation, fromBin, toBin, soId) {
        try {

            log.error('Creating Inventory Transfer', {
                itemId: itemId,
                quantity: quantity,
                fromLocation: fromLocation,
                toLocation: toLocation,
                fromBin: fromBin,
                toBin: toBin,
                soId: soId
            });

            var invTransferRec = record.create({
                type: record.Type.INVENTORY_TRANSFER,
                isDynamic: true
            });

            // Header fields
            invTransferRec.setValue({
                fieldId: 'location',
                value: fromLocation
            });

            invTransferRec.setValue({
                fieldId: 'transferlocation',
                value: toLocation
            });

            invTransferRec.setValue({
                fieldId: 'memo',
                value: 'Inventory Transfer for Fulfillment - SO: ' + soId
            });
            // Add item line
            invTransferRec.selectNewLine({
                sublistId: 'inventory'
            });

            invTransferRec.setCurrentSublistValue({
                sublistId: 'inventory',
                fieldId: 'item',
                value: itemId
            });

            invTransferRec.setCurrentSublistValue({
                sublistId: 'inventory',
                fieldId: 'adjustqtyby',
                value: quantity
            });

            // Inventory Detail (Bin Transfer)
            var invDetail = invTransferRec.getCurrentSublistSubrecord({
                sublistId: 'inventory',
                fieldId: 'inventorydetail'
            });

            invDetail.selectNewLine({
                sublistId: 'inventoryassignment'
            });

            invDetail.setCurrentSublistValue({
                sublistId: 'inventoryassignment',
                fieldId: 'binnumber',
                value: fromBin
            });

            invDetail.setCurrentSublistValue({
                sublistId: 'inventoryassignment',
                fieldId: 'tobinnumber',
                value: toBin
            });

            invDetail.setCurrentSublistValue({
                sublistId: 'inventoryassignment',
                fieldId: 'quantity',
                value: quantity
            });

            invDetail.commitLine({
                sublistId: 'inventoryassignment'
            });

            invTransferRec.commitLine({
                sublistId: 'inventory'
            });

            var transferId = invTransferRec.save({
                enableSourcing: true,
                ignoreMandatoryFields: true
            });

            log.debug('Inventory Transfer Created', transferId);

            return transferId;

        } catch (e) {
            log.error('Inventory Transfer Error', e);
        }
    }

    function getItemNameById(itemId) {
        try {
            var itemRecord = search.lookupFields({
                type: search.Type.INVENTORY_ITEM,
                id: itemId,
                columns: ['itemid']
            });
            return itemRecord.itemid || null;
        } catch (error) {
            log.error('Item Lookup Failed', 'ID: ' + itemId + ' - ' + error);
            return null;
        }
    }

    function getLocationFromSalesOrder(soId) {
        var soRecord = search.lookupFields({
            type: search.Type.SALES_ORDER,
            id: soId,
            columns: ['location']
        });
        return soRecord.location[0].value || null;
    }

    function filterPickedTracking(pickMap, existingTracking) {

        Object.keys(pickMap).forEach(function (item) {

            var filteredTracking = [];

            pickMap[item].tracking.forEach(function (trackObj) {

                if (!existingTracking[trackObj.trackingNumber]) {
                    filteredTracking.push(trackObj);
                }

            });

            pickMap[item].tracking = filteredTracking;
            pickMap[item].qty = filteredTracking.length;

            if (pickMap[item].qty <= 0) {
                delete pickMap[item];
            }

        });

        return pickMap;
    }

    /* ======================================
       BUILD PICK MAP BY LINEUNIQUEKEY
    ====================================== */
    function buildPickMapByItem(wmsLines) {

        var map = {};

        wmsLines.forEach(function (line) {

            if (!line.item || line.is_picked !== 'picked') return;

            var itemName = line.item;
            var qty = Number(line.quantity) || 0;

            if (!map[itemName]) {
                map[itemName] = {
                    qty: 0,
                    tracking: []
                };
            }

            map[itemName].qty += qty;

            // Ensure tracking aligns with quantity
            if (line.tracking_data && line.tracking_data.length) {

                line.tracking_data.forEach(function (track) {
                    map[itemName].tracking.push({
                        trackingNumber: track.trackingNumber || '',
                        SSCC: track.SSCC || ''
                    });
                });
            }
        });

        return map;
    }

    function buildPickMapByItem(wmsLines) {

        var map = {};

        wmsLines.forEach(function (line) {

            if (!line.item || line.is_picked !== 'picked') return;

            var itemName = line.item;
            var qty = Number(line.quantity) || 0;

            if (!map[itemName]) {
                map[itemName] = {
                    qty: 0,
                    tracking: []
                };
            }

            map[itemName].qty += qty;

            // Ensure tracking aligns with quantity
            if (line.tracking_data && line.tracking_data.length) {

                line.tracking_data.forEach(function (track) {
                    map[itemName].tracking.push({
                        trackingNumber: track.trackingNumber || '',
                        SSCC: track.SSCC || ''
                    });
                });
            }
        });

        return map;
    }

    /* ======================================
       CREATE CUSTOM PACKAGE CONTENT
    ====================================== */
    function createCustomPackageContents(fulfillmentId, trackingArray) {

        try {

            var fulfillmentRec = record.load({
                type: record.Type.ITEM_FULFILLMENT,
                id: fulfillmentId,
                isDynamic: true
            });

            var customerId = fulfillmentRec.getValue({ fieldId: 'entity' });

            var isLowesCustomer = false;

            // Replace these with your actual Lowe's customer IDs
            var LOWES_CUSTOMERS = [1952, 639];

            if (LOWES_CUSTOMERS.indexOf(Number(customerId)) !== -1) {
                isLowesCustomer = true;
            }

            var sublistId = 'recmachcustrecord_hj_packagecontents_sublist';

            var existingCount = fulfillmentRec.getLineCount({ sublistId: sublistId });

            for (var i = existingCount - 1; i >= 0; i--) {
                fulfillmentRec.removeLine({
                    sublistId: sublistId,
                    line: i,
                    ignoreRecalc: true
                });
            }

            var packageBoxNumber = 0;
            var seenTracking = {};

            trackingArray.forEach(function (line) {

                if (!line.trackingNumber) return;
                if (seenTracking[line.trackingNumber]) return;

                seenTracking[line.trackingNumber] = true;
                packageBoxNumber++;

                fulfillmentRec.selectNewLine({ sublistId: sublistId });

                fulfillmentRec.setCurrentSublistValue({
                    sublistId: sublistId,
                    fieldId: 'custrecordhj_pkgbox',
                    value: packageBoxNumber
                });

                fulfillmentRec.setCurrentSublistValue({
                    sublistId: sublistId,
                    fieldId: 'custrecordhj_pkg_trackingnumber',
                    value: line.trackingNumber
                });

                if (line.SSCC) {
                    fulfillmentRec.setCurrentSublistValue({
                        sublistId: sublistId,
                        fieldId: 'custrecordhj_ucc',
                        value: line.SSCC
                    });
                }

                if (isLowesCustomer && line.SSCC) {

                    fulfillmentRec.setCurrentSublistValue({
                        sublistId: sublistId,
                        fieldId: 'custrecordhj_ucc',
                        value: line.SSCC
                    });

                }

                fulfillmentRec.setCurrentSublistValue({
                    sublistId: sublistId,
                    fieldId: 'custrecordhj_pkg_desc',
                    value: line.itemName + '/1'
                });

                fulfillmentRec.setCurrentSublistValue({
                    sublistId: sublistId,
                    fieldId: 'custrecord_jyswms_createdfrom',
                    value: true
                });

                fulfillmentRec.setCurrentSublistValue({
                    sublistId: sublistId,
                    fieldId: 'custrecord_jyswms_item_not_populated',
                    value: true
                });

                fulfillmentRec.setCurrentSublistValue({
                    sublistId: sublistId,
                    fieldId: 'custrecord_jyswms_fulfillment_link',
                    value: true
                });
                fulfillmentRec.setCurrentSublistValue({
                    sublistId: sublistId,
                    fieldId: 'custrecord_jyswms_createdfrom',
                    value: true
                });

                fulfillmentRec.commitLine({ sublistId: sublistId });
            });

            fulfillmentRec.save({
                enableSourcing: true,
                ignoreMandatoryFields: true
            });

        } catch (e) {
            log.error('Custom Package Content Error', e);
        }
    }

    /* ======================================
       HELPERS
    ====================================== */

    function callWmsApi(soId) {

        var token = tokenModule.generateToken();

        var response = https.get({
            url: 'https://api.jyswms.com/dropship-sales-order-status?sales_order_id=' + soId,
            headers: {
                'Authorization': 'Bearer ' + token,
                'Content-Type': 'application/json'
            }
        });

        if (response.code !== 200) {
            throw 'WMS API returned ' + response.code;
        }

        var body = JSON.parse(response.body || '{}');
        var sourceArray = body.completed?.length
            ? body.completed
            : body.notcompleted;

        return sourceArray[0].data || [];
    }

    function getItemWeight(itemId) {
        try {
            var itemData = search.lookupFields({
                type: search.Type.INVENTORY_ITEM,
                id: itemId,
                columns: ['weight']
            });
            return Number(itemData.weight) || 0;
        } catch (e) {
            return 0;
        }
    }

    function assignInventoryDetail(fulfillment, qty, stageBinId) {

        if (!stageBinId) return;

        try {

            var invDetail = fulfillment.getCurrentSublistSubrecord({
                sublistId: 'item',
                fieldId: 'inventorydetail'
            });

            var assignmentCount = invDetail.getLineCount({
                sublistId: 'inventoryassignment'
            });

            // REMOVE existing lines first
            for (var i = assignmentCount - 1; i >= 0; i--) {
                invDetail.removeLine({
                    sublistId: 'inventoryassignment',
                    line: i,
                    ignoreRecalc: true
                });
            }

            // ADD correct assignment
            invDetail.selectNewLine({
                sublistId: 'inventoryassignment'
            });

            invDetail.setCurrentSublistValue({
                sublistId: 'inventoryassignment',
                fieldId: 'binnumber',
                value: stageBinId
            });

            invDetail.setCurrentSublistValue({
                sublistId: 'inventoryassignment',
                fieldId: 'quantity',
                value: qty
            });

            invDetail.commitLine({
                sublistId: 'inventoryassignment'
            });

        } catch (e) {
            log.error('Inventory Detail Error', e);
            throw e;
        }
    }

    function getStageBinByLocation(locationId) {
        if (Number(locationId) === 15) return 16692;
        if (Number(locationId) === 9) return 4859;
        return null;
    }

    function getInventoryByItemAndBin(itemId, binId, quantity, locationId) {
        log.error('Getting Inventory by Item and Bin', {
            itemId: itemId,
            binId: binId,
            quantity: quantity,
            locationId: locationId
        });
        var invExists = false;
        var inventorybalanceSearchObj = search.create({
            type: "inventorybalance",
            filters:
                [
                    ["item", "anyof", itemId],
                    "AND",
                    ["binnumber", "anyof", binId],
                    "AND",
                    ["onhand", "greaterthan", quantity]
                ],
            columns:
                [
                    search.createColumn({ name: "onhand", label: "On Hand" }),
                    search.createColumn({ name: "available", label: "Available" }),
                    search.createColumn({ name: "binnumber", label: "Bin Number" }),
                    search.createColumn({ name: "location", label: "Location" }),
                    search.createColumn({
                        name: "internalid",
                        join: "binNumber",
                        label: "Internal ID"
                    })
                ]
        });
        var invExists = false;
        const searchResultCount = inventorybalanceSearchObj.runPaged().count;
        log.debug("inventorybalanceSearchObj result count", searchResultCount);
        inventorybalanceSearchObj.run().each(function (result) {
            // .run().each has a limit of 4,000 results
            invExists = true;
            return true;
        });

        if (!invExists) {
            var adjustmentObj = {};
            adjustmentObj[itemId] = quantity;
            createPositiveAdjustment(adjustmentObj, locationId, binId);
            invExists = true;
        }
        return invExists;
    }

    function createPositiveAdjustment(adjustmentObj, locationId, binId) {

        try {

            var adjRec = record.create({
                type: record.Type.INVENTORY_ADJUSTMENT,
                isDynamic: true
            });

            adjRec.setValue({ fieldId: 'subsidiary', value: 1 });
            adjRec.setValue({ fieldId: 'memo', value: 'Inventory Adj for Fulfillment' });
            adjRec.setValue({ fieldId: 'account', value: 464 }); // adjustment account
            adjRec.setValue({ fieldId: 'adjlocation', value: locationId });

            log.debug('Adjustment Object', adjustmentObj);
            log.debug('Location ID', locationId);
            log.debug('Bin ID', binId);

            for (var itemId in adjustmentObj) {

                var qty = adjustmentObj[itemId];

                adjRec.selectNewLine({ sublistId: 'inventory' });

                adjRec.setCurrentSublistValue({
                    sublistId: 'inventory',
                    fieldId: 'item',
                    value: itemId
                });

                adjRec.setCurrentSublistValue({
                    sublistId: 'inventory',
                    fieldId: 'location',
                    value: locationId
                });

                adjRec.setCurrentSublistValue({
                    sublistId: 'inventory',
                    fieldId: 'adjustqtyby',
                    value: qty
                });

                // Inventory Detail (for Bin / Lot / Serial)
                var inventoryDetail = adjRec.getCurrentSublistSubrecord({
                    sublistId: 'inventory',
                    fieldId: 'inventorydetail'
                });

                inventoryDetail.selectNewLine({
                    sublistId: 'inventoryassignment'
                });

                inventoryDetail.setCurrentSublistValue({
                    sublistId: 'inventoryassignment',
                    fieldId: 'binnumber',
                    value: binId
                });

                inventoryDetail.setCurrentSublistValue({
                    sublistId: 'inventoryassignment',
                    fieldId: 'quantity',
                    value: qty
                });

                inventoryDetail.commitLine({
                    sublistId: 'inventoryassignment'
                });

                adjRec.commitLine({ sublistId: 'inventory' });

            }

            var recId = adjRec.save({
                enableSourcing: true,
                ignoreMandatoryFields: true
            });

            log.debug('Inventory Adjustment Created', recId);

            return recId;

        } catch (e) {
            log.error('Error Creating Inventory Adjustment', e);
        }
    }

    function extractTrackingNumbers(wmsLines) {
        try {



            var trackingNumbers = [];

            wmsLines.forEach(function (line) {

                if (line.tracking_data && line.tracking_data.length) {

                    line.tracking_data.forEach(function (track) {

                        if (track.trackingNumber) {
                            trackingNumbers.push(track.trackingNumber);
                        }

                    });

                }

            });

            return trackingNumbers;
        } catch (error) {
            log.error('Error Extracting Tracking Numbers', error);
        }
    }

    function getExistingTrackingNumbers(trackingNumbers) {

        var existingTracking = {};

        try {

            if (!trackingNumbers || !trackingNumbers.length) {
                return existingTracking;
            }

            var filters = [
                ["type", "anyof", "ItemShip"],
                "AND",
                ["mainline", "is", "T"],
                "AND"
            ];

            var trackingFilter = [];

            trackingNumbers.forEach(function (num, index) {

                if (index > 0) {
                    trackingFilter.push("OR");
                }

                trackingFilter.push([
                    "shipmentpackage.trackingnumber",
                    "is",
                    num
                ]);

            });

            filters = filters.concat(trackingFilter);

            var fulfillmentSearch = search.create({
                type: "itemfulfillment",
                filters: filters,
                columns: [
                    search.createColumn({
                        name: "trackingnumber",
                        join: "shipmentpackage"
                    })
                ]
            });

            fulfillmentSearch.run().each(function (result) {

                var tracking = result.getValue({
                    name: "trackingnumber",
                    join: "shipmentpackage"
                });

                if (tracking) {
                    existingTracking[String(tracking)] = true;
                }

                return true;
            });

        } catch (e) {

            log.error('Error Fetching Existing Tracking Numbers', e);

        }

        return existingTracking;
    }

    // function getExistingTrackingNumbers(trackingNumbers) {

    //     var existingTracking = {};

    //     try {
    //         log.debug('Checking Existing Tracking Numbers', trackingNumbers);
    //         if (!trackingNumbers || !trackingNumbers.length) {
    //             return existingTracking;
    //         }

    //         var fulfillmentSearch = search.create({
    //             type: "itemfulfillment",
    //             filters: [
    //                 ["type", "anyof", "ItemShip"],
    //                 "AND",
    //                 ["shipmentpackage.trackingnumber", "is", trackingNumbers],
    //                 "AND",
    //                 ["mainline", "is", "T"]
    //             ],
    //             columns: [
    //                 search.createColumn({
    //                     name: "trackingnumber",
    //                     join: "shipmentpackage"
    //                 })
    //             ]
    //         });

    //         fulfillmentSearch.run().each(function (result) {

    //             var tracking = result.getValue({
    //                 name: "trackingnumber",
    //                 join: "shipmentpackage"
    //             });

    //             if (tracking) {
    //                 existingTracking[String(tracking)] = true;
    //             }

    //             return true;

    //         });

    //     } catch (e) {

    //         log.error('Error Fetching Existing Tracking Numbers', e);

    //     }

    //     return existingTracking;
    // }

    function buildForm(context) {

        var form = ui.createForm({
            title: 'WMS Direct Fulfillment Processor'
        });

        form.addField({
            id: 'custpage_soid',
            type: ui.FieldType.TEXT,
            label: 'Sales Order Internal ID'
        }).isMandatory = true;

        form.addSubmitButton({
            label: 'Process Fulfillment'
        });

        context.response.writePage(form);
    }

    return { onRequest: onRequest };
});