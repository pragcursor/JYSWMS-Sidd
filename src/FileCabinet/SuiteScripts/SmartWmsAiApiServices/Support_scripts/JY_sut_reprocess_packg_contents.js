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
            if (!fulfillmentId) throw 'Missing fulfillmentId';

            var fulfillment = record.load({
                type: record.Type.ITEM_FULFILLMENT,
                id: fulfillmentId,
                isDynamic: true
            });

            var soId = fulfillment.getValue({ fieldId: 'createdfrom' });
            if (!soId) throw 'Missing Sales Order';

            /* ======================
               FETCH WMS DATA
            ====================== */

            var wmsLines = callWmsApi(soId);

            if (!wmsLines.length) {
                throw 'No WMS data found';
            }

            /* ======================
               BUILD PACKAGE LINES
            ====================== */

            clearPackages(fulfillment);
            createPackageLines(fulfillment, wmsLines);

            var savedId = fulfillment.save({
                enableSourcing: true,
                ignoreMandatoryFields: true
            });

            /* ======================
               PACKAGE CONTENTS
            ====================== */

            createPackageContentsSmart(savedId, wmsLines);

            renderSuccess(form, savedId);

        } catch (e) {

            log.error('ERROR', e);
            renderError(form, e);

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
                'Authorization': 'Bearer ' + token
            }
        });

        if (response.code !== 200) {
            throw 'WMS API failed: ' + response.code;
        }

        var body = JSON.parse(response.body || '{}');

        var source = body.completed?.length
            ? body.completed
            : body.notcompleted;

        return source[0]?.data || [];
    }

    /* ======================
       CLEAR PACKAGE LINES
    ====================== */

    function clearPackages(fulfillment) {

        var count = fulfillment.getLineCount({ sublistId: 'package' });

        for (var i = count - 1; i >= 0; i--) {
            fulfillment.removeLine({
                sublistId: 'package',
                line: i,
                ignoreRecalc: true
            });
        }
    }

    /* ======================
       CREATE PACKAGE LINES
    ====================== */

    function createPackageLines(fulfillment, wmsLines) {

        var seen = {};

        wmsLines.forEach(function (line) {

            if (!line.item || line.is_picked !== 'picked') return;

            (line.tracking_data || []).forEach(function (track) {

                var tracking = track.trackingNumber;
                if (!tracking || seen[tracking]) return;

                fulfillment.selectNewLine({ sublistId: 'package' });

                fulfillment.setCurrentSublistValue({
                    sublistId: 'package',
                    fieldId: 'packagetrackingnumber',
                    value: tracking
                });
                fulfillment.setCurrentSublistValue({
                    sublistId: 'package',
                    fieldId: 'packageweight',
                    value: getItemWeight(getItemIdByName(line.item))
                });

                fulfillment.commitLine({ sublistId: 'package' });

                seen[tracking] = true;
            });

        });
    }

    /* ======================
       EXISTING PACKAGE COUNTS (SEARCH)
    ====================== */

    function getExistingPackageCounts(fulfillmentId) {

        var map = {};

        var s = search.create({
            type: 'customrecordhj_tc_package_contents',
            filters: [
                ['custrecord_hj_packagecontents_sublist', 'anyof', fulfillmentId]
            ],
            columns: [
                'custrecordhj_pkg_trackingnumber',
                'custrecordhj_pkg_desc'
            ]
        });

        s.run().each(function (r) {

            var tracking = r.getValue('custrecordhj_pkg_trackingnumber') || '';
            var desc = r.getValue('custrecordhj_pkg_desc') || '';

            var itemName = desc.split('/')[0];

            var key = tracking + '|' + itemName;

            if (!map[key]) map[key] = 0;

            map[key]++;

            return true;
        });

        return map;
    }

    /* ======================
       REQUIRED COUNTS FROM WMS
    ====================== */

    function buildRequiredCounts(wmsLines) {

        var required = {};

        wmsLines.forEach(function (line) {

            if (!line.item || line.is_picked !== 'picked') return;

            var itemName = line.item;
            var qty = Number(line.quantity) || 0;

            (line.tracking_data || []).forEach(function (track) {

                var tracking = track.trackingNumber;
                var sscc = track.SSCC || '';

                if (!tracking) return;

                var key = tracking + '|' + itemName;

                if (!required[key]) {
                    required[key] = {
                        qty: 0,
                        sscc: sscc
                    };
                }

                required[key].qty += qty;

            });

        });

        return required;
    }

    /* ======================
       CREATE PACKAGE CONTENTS (SMART)
    ====================== */

    function createPackageContentsSmart(fulfillmentId, wmsLines) {

        var rec = record.load({
            type: record.Type.ITEM_FULFILLMENT,
            id: fulfillmentId,
            isDynamic: true
        });

        var sublistId = 'recmachcustrecord_hj_packagecontents_sublist';

        var existingMap = getExistingPackageCounts(fulfillmentId);
        var requiredMap = buildRequiredCounts(wmsLines);

        var created = 0;

        Object.keys(requiredMap).forEach(function (key) {

            var requiredQty = requiredMap[key];
            var existingQty = existingMap[key] || 0;
            var sscc = requiredMap[key].sscc;


            var missing = requiredQty - existingQty;

            if (missing <= 0) return;

            var parts = key.split('|');
            var tracking = parts[0];
            var itemName = parts[1];

            for (var i = 0; i < missing; i++) {

                rec.selectNewLine({ sublistId: sublistId });

                rec.setCurrentSublistValue({
                    sublistId: sublistId,
                    fieldId: 'custrecordhj_pkgbox',
                    value: created + 1
                });

                rec.setCurrentSublistValue({
                    sublistId: sublistId,
                    fieldId: 'custrecordhj_pkg_trackingnumber',
                    value: tracking
                });

                rec.setCurrentSublistValue({
                    sublistId: sublistId,
                    fieldId: 'custrecordhj_pkg_desc',
                    value: itemName + '/1'
                });

                rec.setCurrentSublistValue({
                    sublistId: sublistId,
                    fieldId: 'custrecordhj_tc_packagecontentslbs',
                    value: getItemWeight(getItemIdByName(itemName))
                });

                rec.setCurrentSublistValue({
                    sublistId: sublistId,
                    fieldId: 'custrecord_jyswms_item_not_populated',
                    value: true
                });

                rec.setCurrentSublistValue({
                    sublistId: sublistId,
                    fieldId: 'custrecord_jyswms_createdfrom',
                    value: true
                });

                if (sscc) {

                    rec.setCurrentSublistValue({
                        sublistId: sublistId,
                        fieldId: 'custrecordhj_ucc',
                        value: sscc
                    });

                }
                rec.commitLine({ sublistId: sublistId });

                created++;
            }

        });

        rec.save({
            enableSourcing: true,
            ignoreMandatoryFields: true
        });

        log.audit('PACKAGE CONTENT CREATED', created);
    }

    function getItemWeight(itemId) {

        try {
            var itemData = search.lookupFields({
                type: search.Type.INVENTORY_ITEM,
                id: itemId,
                columns: ['weight']
            });

            return Number(itemData.weight) || 1;

        } catch (e) {
            return 1;
        }
    }
    function getItemIdByName(itemName) {

        var itemId = null;

        var itemSearchObj = search.create({
            type: "item",
            filters: [
                ["itemid", "is", itemName]
            ],
            columns: [
                search.createColumn({ name: "internalid" })
            ]
        });

        itemSearchObj.run().each(function (result) {

            itemId = result.getValue({ name: "internalid" });

            return false; // stop after first match
        });

        return itemId;
    }

    /* ======================
       UI
    ====================== */

    function renderSuccess(form, id) {

        form.addField({
            id: 'custpage_msg',
            type: ui.FieldType.INLINEHTML,
            label: ' '
        }).defaultValue =
            '<h3 style="color:green">Success</h3>' +
            '<p>Fulfillment: ' + id + '</p>';
    }

    function renderError(form, e) {

        form.addField({
            id: 'custpage_err',
            type: ui.FieldType.INLINEHTML,
            label: ' '
        }).defaultValue =
            '<h3 style="color:red">Error</h3><p>' + e + '</p>';
    }

    return { onRequest: onRequest };

});
