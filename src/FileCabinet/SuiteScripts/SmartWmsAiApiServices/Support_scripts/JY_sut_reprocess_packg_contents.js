/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 */

define([
    'N/ui/serverWidget',
    'N/record',
    'N/search',
    'N/https',
    'N/log',
    '../JYSWMS_generateToken_API.js'
], function (ui, record, search, https, log, tokenModule) {

    function onRequest(context) {

        var form = ui.createForm({
            title: 'Reprocess Fulfillment Packages'
        });

        try {

            var fulfillmentId = context.request.parameters.ifid;

            if (!fulfillmentId) {
                throw 'Item Fulfillment internal id required';
            }

            var fulfillment = record.load({
                type: record.Type.ITEM_FULFILLMENT,
                id: fulfillmentId,
                isDynamic: true
            });

            var soId = fulfillment.getValue({
                fieldId: 'createdfrom'
            });

            if (!soId) {
                throw 'Created From Sales Order missing';
            }

            /* CALL WMS */

            var wmsLines = callWmsApi(soId);

            var pickMap = buildPickMapByItem(wmsLines);

            var trackingArray = [];

            wmsLines.forEach(function (line) {

                if (!line.item || line.is_picked !== 'picked') return;

                if (!line.tracking_data) return;

                line.tracking_data.forEach(function (track) {

                    trackingArray.push({
                        trackingNumber: track.trackingNumber || '',
                        SSCC: track.SSCC || '',
                        itemName: line.item
                    });

                });

            });
            
            if (!trackingArray.length) {
                throw 'No tracking numbers returned from API';
            }

            /* CLEAR EXISTING PACKAGES */

            var existing = fulfillment.getLineCount({
                sublistId: 'package'
            });

            for (var i = existing - 1; i >= 0; i--) {

                fulfillment.removeLine({
                    sublistId: 'package',
                    line: i,
                    ignoreRecalc: true
                });

            }

            /* CREATE PACKAGE LINES */

            var packageIndexMap = {};

            trackingArray.forEach(function (track) {

                if (!track.trackingNumber) return;

                if (!packageIndexMap[track.trackingNumber]) {

                    var itemId = getItemIdByName(track.itemName);
                    log.error('Item ID', itemId);
                    var weight = getItemWeight(itemId);
                    log.error('Item Weight', weight);

                    fulfillment.selectNewLine({
                        sublistId: 'package'
                    });

                    fulfillment.setCurrentSublistValue({
                        sublistId: 'package',
                        fieldId: 'packagetrackingnumber',
                        value: track.trackingNumber
                    });

                    fulfillment.setCurrentSublistValue({
                        sublistId: 'package',
                        fieldId: 'packageweight',
                        value: weight
                    });

                    fulfillment.commitLine({
                        sublistId: 'package'
                    });

                    packageIndexMap[track.trackingNumber] = true;
                }

            });

            var savedId = fulfillment.save({
                enableSourcing: true,
                ignoreMandatoryFields: true
            });

            createCustomPackageContents(savedId, trackingArray);

            form.addField({
                id: 'custpage_success',
                type: ui.FieldType.INLINEHTML,
                label: ' '
            }).defaultValue =
                '<h3 style="color:green">Reprocessing Completed</h3>' +
                '<p>Fulfillment ID: ' + savedId + '</p>' +
                '<p>Packages Created: ' + Object.keys(packageIndexMap).length + '</p>';

        } catch (e) {

            log.error('Reprocess Error', e);

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

    /* ======================
    CALL WMS
    ====================== */

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

    /* ======================
    PICK MAP
    ====================== */

    function buildPickMapByItem(wmsLines) {

        var map = {};

        wmsLines.forEach(function (line) {

            if (!line.item || line.is_picked !== 'picked') return;

            var itemName = line.item;

            if (!map[itemName]) {
                map[itemName] = {
                    tracking: []
                };
            }

            if (line.tracking_data) {

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

    /* ======================
    GET ITEM ID
    ====================== */

    function getItemIdByName(itemName) {

        var itemSearch = search.create({
            type: search.Type.ITEM,
            filters: [
                ["itemid", "is", itemName]
            ],
            columns: ["internalid"]
        });

        var id = null;

        itemSearch.run().each(function (r) {

            id = r.getValue("internalid");
            return false;

        });

        return id;
    }

    /* ======================
    ITEM WEIGHT
    ====================== */

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

    /* ======================
    CUSTOM PACKAGE CONTENT
    ====================== */

    function createCustomPackageContents(fulfillmentId, trackingArray) {

        var fulfillmentRec = record.load({
            type: record.Type.ITEM_FULFILLMENT,
            id: fulfillmentId,
            isDynamic: true
        });

        var sublistId = 'recmachcustrecord_hj_packagecontents_sublist';

        var existingCount = fulfillmentRec.getLineCount({
            sublistId: sublistId
        });

        for (var i = existingCount - 1; i >= 0; i--) {

            fulfillmentRec.removeLine({
                sublistId: sublistId,
                line: i,
                ignoreRecalc: true
            });

        }

        var box = 0;
        var seenTracking = {};

        trackingArray.forEach(function (line) {

            if (!line.trackingNumber) return;
            if (seenTracking[line.trackingNumber]) return;

            seenTracking[line.trackingNumber] = true;

            box++;

            fulfillmentRec.selectNewLine({
                sublistId: sublistId
            });

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

            var itemWeight = getItemWeight(getItemIdByName(line.itemName));

            fulfillmentRec.setCurrentSublistValue({
                sublistId: sublistId,
                fieldId: 'custrecordhj_tc_packagecontentslbs',
                value: itemWeight
            });

            if (line.SSCC) {

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
                fieldId: 'custrecord_jyswms_item_not_populated',
                value: true
            });
            fulfillmentRec.setCurrentSublistValue({
                sublistId: sublistId,
                fieldId: 'custrecord_jyswms_createdfrom',
                value: true
            });

            fulfillmentRec.commitLine({
                sublistId: sublistId
            });

        });

        fulfillmentRec.save({
            enableSourcing: true,
            ignoreMandatoryFields: true
        });
    }

    return { onRequest: onRequest };

});