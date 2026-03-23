/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */

define([
    'N/record',
    'N/search',
    'N/https',
    'N/log'
], function (record, search, https, log) {


    function generateToken() {
        const url = 'https://api.jyswms.com/user/login';
        const creds = {
            userid: 'jyswms_integration_user',
            password: 's9u[7zC720%pZr'
        };

        try {
            const response = https.post({
                url: url,
                body: JSON.stringify(creds),
                headers: { 'Content-Type': 'application/json' }
            });

            const parsed = JSON.parse(response.body || '{}');

            if (parsed.access_token) {
                return parsed.access_token;
            }

           // log.error('Token Generation Failed', parsed);
            return null;

        } catch (e) {
            log.error('generateToken Error', e);
            // return null;
        }
    }
  
    var ITEM_CACHE = {};

    /* ======================
       INPUT
    ====================== */

    function getInputData() {

        return search.load({
            id: '1134'
        });

    }

    /* ======================
       MAP
    ====================== */

    function map(context) {

        var result = JSON.parse(context.value);

        var fulfillmentId = result.id;

        var soId = result.values.createdfrom.value;

        if (!soId) return;

        context.write({
            key: soId,
            value: fulfillmentId
        });

    }

    /* ======================
       REDUCE
    ====================== */

    function reduce(context) {

        var soId = context.key;

        var fulfillmentIds = context.values;

        try {

            log.audit('Processing Sales Order', soId);

            var wmsLines = callWmsApi(soId);

            var pickMap = buildPickMapByItem(wmsLines);

            var trackingArray = [];

            Object.keys(pickMap).forEach(function (itemName) {

                pickMap[itemName].tracking.forEach(function (track) {

                    trackingArray.push({
                        trackingNumber: track.trackingNumber,
                        SSCC: track.SSCC,
                        itemName: itemName
                    });

                });

            });

            if (!trackingArray.length) {

                log.audit('No Tracking Returned', soId);
                return;

            }

            fulfillmentIds.forEach(function (fid) {

                processFulfillment(fid, trackingArray);

            });

        } catch (e) {

            log.error('Reduce Error SO ' + soId, e);

        }

    }

    /* ======================
       PROCESS FULFILLMENT
    ====================== */

    function processFulfillment(fulfillmentId, trackingArray) {

        var fulfillment = record.load({
            type: record.Type.ITEM_FULFILLMENT,
            id: fulfillmentId,
            isDynamic: true
        });

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

        var packageIndexMap = {};

        trackingArray.forEach(function (track) {

            if (!track.trackingNumber) return;

            if (!packageIndexMap[track.trackingNumber]) {

                var itemData = getItemData(track.itemName);

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
                    value: itemData.weight
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

        log.audit('Fulfillment Updated', savedId);

    }

    /* ======================
       CALL WMS API
    ====================== */

    function callWmsApi(soId) {

        var token = generateToken();

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
       TOKEN CACHE
    ====================== */

    function getToken() {

        if (!TOKEN) {

            TOKEN = generateToken();

        }

        return TOKEN;

    }

    /* ======================
       BUILD PICK MAP
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
       ITEM CACHE
    ====================== */

    function getItemData(itemName) {

        if (ITEM_CACHE[itemName]) {

            return ITEM_CACHE[itemName];

        }

        var itemSearch = search.create({
            type: search.Type.ITEM,
            filters: [["itemid", "is", itemName]],
            columns: ["internalid", "weight"]
        });

        var result = itemSearch.run().getRange({ start: 0, end: 1 });

        if (!result || !result.length) {

            return { id: null, weight: 0 };

        }

        var data = {
            id: result[0].getValue("internalid"),
            weight: Number(result[0].getValue("weight")) || 0
        };

        ITEM_CACHE[itemName] = data;

        return data;

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

            var itemData = getItemData(line.itemName);

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

            fulfillmentRec.setCurrentSublistValue({
                sublistId: sublistId,
                fieldId: 'custrecordhj_tc_packagecontentslbs',
                value: itemData.weight
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

    /* ======================
       SUMMARY
    ====================== */

    function summarize(summary) {

        summary.reduceSummary.errors.iterator().each(function (key, error) {

          //  log.error('Reduce Error ' + key, error);
            return true;

        });

        log.audit('Map Reduce Completed');

    }

    return {
        getInputData: getInputData,
        map: map,
        reduce: reduce,
        summarize: summarize
    };

});