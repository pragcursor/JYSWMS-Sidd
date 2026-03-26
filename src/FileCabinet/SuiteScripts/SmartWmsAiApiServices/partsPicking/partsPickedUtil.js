/**
 * @NApiVersion 2.x
 * @NModuleScope Public
 */

define(['N/record', 'N/log', 'N/search'], function (record, log, search) {

    function markAfullFillPartsOrsersPicked(requestBody) {

        try {

            log.error('Incoming Data', JSON.stringify(requestBody));

            if (!requestBody || !requestBody.data) {
                throw 'Invalid payload';
            }

            // =====================================
            // GROUP BY SALES ORDER
            // =====================================
            var soMap = {};

            requestBody.data.forEach(function (bin) {

                var missingStatus = bin.missing_status;

                (bin.salesOrders || []).forEach(function (soLine) {

                    var soId = soLine.salesOrderId;

                    if (!soMap[soId]) {
                        soMap[soId] = {
                            lines: [],
                            tracking: [],
                            totalPicked: 0,
                            missingStatus: missingStatus
                        };
                    }

                    var pickedQty = Number(soLine.picked_quantity) || 0;

                    soMap[soId].totalPicked += pickedQty;
                    soMap[soId].lines.push(soLine);

                    (soLine.labelData || []).forEach(function (label) {
                        if (label.tracking_number) {
                            soMap[soId].tracking.push({
                                trackingNumber: label.tracking_number,
                                itemName: soLine.item,
                                itemInternalId: soLine.itemInternalId
                            });
                        }
                    });

                });

            });

            // =====================================
            // PROCESS EACH SALES ORDER
            // =====================================
            Object.keys(soMap).forEach(function (soId) {

                var soData = soMap[soId];
                log.error('Processing SO', {
                    soId: soId,
                    totalPicked: soData.totalPicked,
                    missingStatus: soData.missingStatus,
                    trackingCount: soData.tracking.length
                });
                // =====================================
                // 🚫 CASE 1: NOTHING PICKED
                // =====================================
                if (soData.totalPicked == 0) {

                    var soRec = record.load({
                        type: record.Type.SALES_ORDER,
                        id: soId,
                        isDynamic: false
                    });
                    var status = soRec.getValue('orderstatus');

                    if (status !== 'B') {
                        log.error('SO Skipped - Not Pending Fulfillment', {
                            soId: soId,
                            status: status
                        });
                        return;
                    }
                    soRec.setValue('custbody_parts_jy_wms_status', soData.missingStatus || 'Missing');
                    soRec.setValue('custbody_jys_parts_not_availble', true);
                    soRec.save();
                    log.error('SO Updated - No Fulfillment', soId);
                    return;
                }

                // =====================================
                // ✅ CASE 2: CREATE FULFILLMENT
                // =====================================

                // ---- Load SO for remaining qty
                var soRec = record.load({
                    type: record.Type.SALES_ORDER,
                    id: soId,
                    isDynamic: false
                });
                var status = soRec.getValue('orderstatus');

                if (status !== 'B') {
                    log.error('SO Skipped - Not Pending Fulfillment', {
                        soId: soId,
                        status: status
                    });
                    return;
                }
                var soLineCount = soRec.getLineCount({ sublistId: 'item' });
                var soRemainingMap = {};

                for (var i = 0; i < soLineCount; i++) {

                    var itemId = soRec.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'item',
                        line: i
                    });

                    var orderedQty = Number(soRec.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'quantity',
                        line: i
                    })) || 0;

                    var fulfilledQty = Number(soRec.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'quantityfulfilled',
                        line: i
                    })) || 0;

                    var remainingQty = orderedQty - fulfilledQty;

                    if (!soRemainingMap[itemId]) {
                        soRemainingMap[itemId] = 0;
                    }

                    soRemainingMap[itemId] += remainingQty;
                }

                // ---- Transform
                var fulfillment = record.transform({
                    fromType: record.Type.SALES_ORDER,
                    fromId: soId,
                    toType: record.Type.ITEM_FULFILLMENT,
                    isDynamic: true
                });
                fulfillment.setValue("shipstatus", "C"); // Set to 'Packed'

                var lineCount = fulfillment.getLineCount({ sublistId: 'item' });

                for (var j = 0; j < lineCount; j++) {

                    fulfillment.selectLine({
                        sublistId: 'item',
                        line: j
                    });

                    var itemId = fulfillment.getCurrentSublistValue({
                        sublistId: 'item',
                        fieldId: 'item'
                    });

                    var matchedLine = soData.lines.find(function (l) {
                        return Number(l.itemInternalId) === Number(itemId);
                    });

                    var remainingQty = soRemainingMap[itemId] || 0;

                    if (matchedLine && remainingQty > 0) {

                        var pickedQty = Number(matchedLine.picked_quantity) || 0;
                        var fulfillQty = Math.min(pickedQty, remainingQty);

                        if (fulfillQty > 0) {

                            fulfillment.setCurrentSublistValue({
                                sublistId: 'item',
                                fieldId: 'itemreceive',
                                value: true
                            });

                            fulfillment.setCurrentSublistValue({
                                sublistId: 'item',
                                fieldId: 'quantity',
                                value: fulfillQty
                            });

                            soRemainingMap[itemId] -= fulfillQty;

                        } else {
                            fulfillment.setCurrentSublistValue({
                                sublistId: 'item',
                                fieldId: 'itemreceive',
                                value: false
                            });
                        }

                    } else {
                        fulfillment.setCurrentSublistValue({
                            sublistId: 'item',
                            fieldId: 'itemreceive',
                            value: false
                        });
                    }

                    fulfillment.commitLine({ sublistId: 'item' });
                }

                // ---- Add tracking (optional but included)
                var seenTracking = {};

                soData.tracking.forEach(function (pkg) {

                    if (!pkg.trackingNumber) return;
                    if (seenTracking[pkg.trackingNumber]) return;

                    seenTracking[pkg.trackingNumber] = true;

                    fulfillment.selectNewLine({ sublistId: 'package' });

                    var weight = _getItemWeight(pkg.itemInternalId);

                    fulfillment.setCurrentSublistValue({
                        sublistId: 'package',
                        fieldId: 'packageweight',
                        value: weight > 0 ? weight : 1
                    });

                    fulfillment.setCurrentSublistValue({
                        sublistId: 'package',
                        fieldId: 'packagetrackingnumber',
                        value: pkg.trackingNumber
                    });

                    fulfillment.commitLine({ sublistId: 'package' });

                });

                var fulfillmentId = fulfillment.save({
                    enableSourcing: true,
                    ignoreMandatoryFields: true
                });

                log.error('Fulfillment Created', fulfillmentId);

                createCustomPackageContents(fulfillmentId, soData.tracking);

            });

            return { status: 'success' };

        } catch (e) {
            log.error('POST Error', e);
            return { status: 'error', message: e.message };
        }
    }

    // =====================================
    // CUSTOM PACKAGE FUNCTION (same)
    // =====================================
    function createCustomPackageContents(fulfillmentId, trackingArray) {
        try {
            var fulfillmentRec = record.load({
                type: record.Type.ITEM_FULFILLMENT,
                id: fulfillmentId,
                isDynamic: true
            });

            var sublistId = 'recmachcustrecord_hj_packagecontents_sublist';

            var count = fulfillmentRec.getLineCount({ sublistId: sublistId });

            for (var i = count - 1; i >= 0; i--) {
                fulfillmentRec.removeLine({
                    sublistId: sublistId,
                    line: i,
                    ignoreRecalc: true
                });
            }

            var seen = {};
            var box = 0;

            trackingArray.forEach(function (line) {

                if (!line.trackingNumber) return;
                if (seen[line.trackingNumber]) return;

                seen[line.trackingNumber] = true;
                box++;

                var weight = _getItemWeight(line.itemInternalId) || 0;
                weight = weight > 0 ? weight : 1;
                fulfillmentRec.selectNewLine({ sublistId: sublistId });

                fulfillmentRec.setCurrentSublistValue({
                    sublistId: sublistId,
                    fieldId: 'custrecordhj_pkgbox',
                    value: box
                });

                fulfillmentRec.setCurrentSublistValue({
                    sublistId: sublistId,
                    fieldId: 'custrecordhj_pkg_trackingnumber',
                    value: line.trackingNumber
                });

                fulfillmentRec.setCurrentSublistValue({
                    sublistId: sublistId,
                    fieldId: 'custrecordhj_pkg_desc',
                    value: line.itemName + '/1'
                });

                fulfillmentRec.setCurrentSublistValue({
                    sublistId: sublistId,
                    fieldId: 'custrecordhj_tc_packagecontentslbs',
                    value: weight
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

                fulfillmentRec.commitLine({ sublistId: sublistId });

            });

            fulfillmentRec.save({
                enableSourcing: true,
                ignoreMandatoryFields: true
            });

        } catch (e) {
            log.error('Custom Package Error', e);
        }
    }

    function _getItemWeight(itemId) {
        try {
            var itemFields = search.lookupFields({
                type: 'noninventoryitem',
                id: itemId,
                columns: ['weight']
            });
            return itemFields.weight;
        } catch (e) {
            log.error('Error occurred while fetching item weight', e);
            return 0;
        }
    }


    return {
        fullFillPartsOrder: markAfullFillPartsOrsersPicked
    };

});