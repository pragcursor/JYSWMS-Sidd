/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 *
 * OPTIMIZATIONS:
 *  1. Item name → ID resolved once via a single multi-filter search (batch)
 *  2. Item weights fetched in one search.lookupFields pass per unique item
 *  3. Package-content rows written with a non-dynamic record load (faster commits)
 *  4. Governance guard: checks remaining units before heavy loops and logs warnings
 *
 * BUG FIXES:
 *  1. Package contents now deleted before recreating — prevents stacking on reprocess
 *  2. One content record created per tracking number (not qty × tracking count)
 *  3. Removed flawed diff logic (existingMap key mismatch caused records to never be skipped)
 */

define([
    'N/ui/serverWidget',
    'N/record',
    'N/search',
    'N/https',
    'N/log',
    'N/runtime',
    '../JYSWMS_generateToken_API'
], function (ui, record, search, https, log, runtime, tokenModule) {

    /* ─── governance threshold ───────────────────────────────────────────── */
    var GOVERNANCE_WARN_THRESHOLD = 200;

    /* ═══════════════════════════════════════════════════════════════════════
       ENTRY POINT
    ═══════════════════════════════════════════════════════════════════════ */
    function onRequest(context) {

        var form = ui.createForm({ title: 'Reprocess Fulfillment Packages' });

        try {

            var fulfillmentId = context.request.parameters.ifid;
            if (!fulfillmentId) throw 'Missing fulfillmentId';

            checkGovernance('start');

            var fulfillment = record.load({
                type:      record.Type.ITEM_FULFILLMENT,
                id:        fulfillmentId,
                isDynamic: true
            });

            var soId = fulfillment.getValue({ fieldId: 'createdfrom' });
            if (!soId) throw 'Missing Sales Order';

            /* ── FETCH WMS DATA ──────────────────────────────────────────── */
            var wmsLines = callWmsApi(soId);
            if (!wmsLines.length) throw 'No WMS data found';

            /* ── PRE-CACHE item IDs and weights in bulk ──────────────────── */
            var itemNames   = collectUniqueItemNames(wmsLines);
            var itemIdCache = batchGetItemIds(itemNames);
            var weightCache = batchGetItemWeights(itemIdCache);

            checkGovernance('after-cache');

            /* ── BUILD PACKAGE LINES ─────────────────────────────────────── */
            clearPackages(fulfillment);
            createPackageLines(fulfillment, wmsLines, weightCache);

            var savedId = fulfillment.save({
                enableSourcing:        true,
                ignoreMandatoryFields: true
            });

            checkGovernance('after-package-lines-save');

            /* ── PACKAGE CONTENTS ────────────────────────────────────────── */
            createPackageContentsSmart(savedId, wmsLines, weightCache);

            renderSuccess(form, savedId);

        } catch (e) {

            log.error('ERROR', e);
            renderError(form, e);
        }

        context.response.writePage(form);
    }

    /* ═══════════════════════════════════════════════════════════════════════
       CALL WMS
    ═══════════════════════════════════════════════════════════════════════ */
    function callWmsApi(soId) {

        var token = tokenModule.generateToken();

        var response = https.get({
            url: 'https://api.jyswms.com/dropship-sales-order-status-with-bins?sales_order_id=' + soId,
            headers: {
                'Authorization': 'Bearer ' + token,
                'Content-Type':  'application/json'
            }
        });

        if (response.code !== 200) throw 'WMS API failed: ' + response.code;

        var body = JSON.parse(response.body || '{}');

        var source = (body.completed    && body.completed.length)    ? body.completed    :
                     (body.notcompleted && body.notcompleted.length)  ? body.notcompleted : [];

        if (!source.length || !source[0]) throw 'No WMS order data found for SO: ' + soId;

        return source[0].data || [];
    }

    /* ═══════════════════════════════════════════════════════════════════════
       NORMALIZE KEY
    ═══════════════════════════════════════════════════════════════════════ */
    function normalizeKey(val) {
        if (!val) return '';
        return String(val).split(/[-_]/)[0];
    }

    /* ═══════════════════════════════════════════════════════════════════════
       COLLECT UNIQUE ITEM NAMES
    ═══════════════════════════════════════════════════════════════════════ */
    function collectUniqueItemNames(wmsLines) {
        var seen = {};
        wmsLines.forEach(function (line) {
            if (line.item && line.is_picked === 'picked') seen[line.item] = true;
        });
        return Object.keys(seen);
    }

    /* ═══════════════════════════════════════════════════════════════════════
       BATCH GET ITEM IDs — single search for all items
    ═══════════════════════════════════════════════════════════════════════ */
    function batchGetItemIds(itemNames) {

        var cache = {};
        if (!itemNames.length) return cache;

        var filters = [];
        itemNames.forEach(function (name, idx) {
            if (idx > 0) filters.push('OR');
            filters.push(['itemid', 'is', name]);
        });

        search.create({
            type:    'item',
            filters: filters,
            columns: [
                search.createColumn({ name: 'internalid' }),
                search.createColumn({ name: 'itemid'     })
            ]
        }).run().each(function (result) {
            var name = result.getValue({ name: 'itemid'     });
            var id   = result.getValue({ name: 'internalid' });
            if (name && id) cache[name] = id;
            return true;
        });

        log.audit('BATCH_ITEM_IDS', 'Resolved ' + Object.keys(cache).length + ' of ' + itemNames.length);
        return cache;
    }

    /* ═══════════════════════════════════════════════════════════════════════
       BATCH GET ITEM WEIGHTS — one lookup per unique item
    ═══════════════════════════════════════════════════════════════════════ */
    function batchGetItemWeights(itemIdCache) {

        var weightCache = {};

        Object.keys(itemIdCache).forEach(function (itemName) {
            var itemId = itemIdCache[itemName];
            try {
                var fields = search.lookupFields({
                    type:    search.Type.INVENTORY_ITEM,
                    id:      itemId,
                    columns: ['weight']
                });
                weightCache[itemName] = Number(fields.weight) || 1;
            } catch (e) {
                weightCache[itemName] = 1;
            }
        });

        return weightCache;
    }

    /* ═══════════════════════════════════════════════════════════════════════
       CLEAR PACKAGE LINES
    ═══════════════════════════════════════════════════════════════════════ */
    function clearPackages(fulfillment) {
        var count = fulfillment.getLineCount({ sublistId: 'package' });
        for (var i = count - 1; i >= 0; i--) {
            fulfillment.removeLine({ sublistId: 'package', line: i, ignoreRecalc: true });
        }
    }

    /* ═══════════════════════════════════════════════════════════════════════
       CREATE PACKAGE LINES — uses weight cache, no per-line searches
    ═══════════════════════════════════════════════════════════════════════ */
    function createPackageLines(fulfillment, wmsLines, weightCache) {

        var seen = {};

        wmsLines.forEach(function (line) {

            if (!line.item || line.is_picked !== 'picked') return;
            var qty = Number(line.quantity) || 0;
            if (!qty) return;

            var weight = weightCache[line.item] || 1;

            (line.tracking_data || []).forEach(function (track) {

                var tracking = track.trackingNumber;
                if (!tracking || seen[tracking]) return;

                fulfillment.selectNewLine({ sublistId: 'package' });

                fulfillment.setCurrentSublistValue({
                    sublistId: 'package',
                    fieldId:   'packagetrackingnumber',
                    value:     tracking
                });
                fulfillment.setCurrentSublistValue({
                    sublistId: 'package',
                    fieldId:   'packageweight',
                    value:     weight
                });

                fulfillment.commitLine({ sublistId: 'package' });
                seen[tracking] = true;
            });
        });
    }

    /* ═══════════════════════════════════════════════════════════════════════
       CREATE PACKAGE CONTENTS (SMART)

       FIX 1: Deletes ALL existing package content records for this fulfillment
              before creating new ones — prevents stacking on reprocess.
       FIX 2: Creates exactly 1 content record per tracking number.
              (old logic did qty × tracking count = thousands of records)
    ═══════════════════════════════════════════════════════════════════════ */
    function createPackageContentsSmart(fulfillmentId, wmsLines, weightCache) {

        /* ── STEP 1: DELETE existing package content records ── */
        var toDelete = [];

        search.create({
            type:    'customrecordhj_tc_package_contents',
            filters: [['custrecord_hj_packagecontents_sublist', 'anyof', fulfillmentId]],
            columns: ['internalid']
        }).run().each(function (r) {
            toDelete.push(r.getValue('internalid'));
            return true;
        });

        toDelete.forEach(function (id) {
            try {
                record.delete({
                    type: 'customrecordhj_tc_package_contents',
                    id:   id
                });
            } catch (e) {
                log.error('DELETE_FAILED', 'Could not delete record ' + id + ': ' + e);
            }
        });

        log.audit('PACKAGE_CONTENTS_DELETED', toDelete.length + ' existing records removed');

        checkGovernance('after-delete');

        /* ── STEP 2: Load fulfillment non-dynamically (faster bulk writes) ── */
        var rec = record.load({
            type:      record.Type.ITEM_FULFILLMENT,
            id:        fulfillmentId,
            isDynamic: false
        });

        var sublistId = 'recmachcustrecord_hj_packagecontents_sublist';
        var lineCount = rec.getLineCount({ sublistId: sublistId });
        var created   = 0;

        checkGovernance('before-content-loop');

        /* ── STEP 3: One record per tracking number ── */
        wmsLines.forEach(function (line) {

            if (!line.item || line.is_picked !== 'picked') return;
            if (!Number(line.quantity)) return;

            var itemName = line.item;
            var weight   = weightCache[itemName] || 1;

            (line.tracking_data || []).forEach(function (track) {

                var tracking = track.trackingNumber;
                var sscc     = track.SSCC || '';
                if (!tracking) return;

                var lineIdx = lineCount + created;

                rec.setSublistValue({ sublistId: sublistId, fieldId: 'custrecordhj_pkgbox',                  line: lineIdx, value: created + 1    });
                rec.setSublistValue({ sublistId: sublistId, fieldId: 'custrecordhj_pkg_trackingnumber',      line: lineIdx, value: tracking        });
                rec.setSublistValue({ sublistId: sublistId, fieldId: 'custrecordhj_pkg_desc',                line: lineIdx, value: itemName + '/1' });
                rec.setSublistValue({ sublistId: sublistId, fieldId: 'custrecordhj_tc_packagecontentslbs',   line: lineIdx, value: weight          });
                rec.setSublistValue({ sublistId: sublistId, fieldId: 'custrecord_jyswms_item_not_populated', line: lineIdx, value: true            });
                rec.setSublistValue({ sublistId: sublistId, fieldId: 'custrecord_jyswms_createdfrom',        line: lineIdx, value: true            });

                if (sscc) {
                    rec.setSublistValue({ sublistId: sublistId, fieldId: 'custrecordhj_ucc', line: lineIdx, value: sscc });
                }

                created++;
            });
        });

        rec.save({
            enableSourcing:        true,
            ignoreMandatoryFields: true
        });

        log.audit('PACKAGE_CONTENT_CREATED', created + ' records created');
        checkGovernance('after-content-save');
    }

    /* ═══════════════════════════════════════════════════════════════════════
       GOVERNANCE GUARD
    ═══════════════════════════════════════════════════════════════════════ */
    function checkGovernance(label) {
        var remaining = runtime.getCurrentScript().getRemainingUsage();
        log.audit('GOVERNANCE [' + label + ']', 'Remaining units: ' + remaining);
        if (remaining < GOVERNANCE_WARN_THRESHOLD) {
            log.error('GOVERNANCE_LOW', 'Low governance at [' + label + ']: ' + remaining + ' units left');
        }
    }

    /* ═══════════════════════════════════════════════════════════════════════
       LEGACY HELPERS — retained, no longer called in hot paths
    ═══════════════════════════════════════════════════════════════════════ */
    function getItemWeight(itemId) {
        try {
            var itemData = search.lookupFields({ type: search.Type.INVENTORY_ITEM, id: itemId, columns: ['weight'] });
            return Number(itemData.weight) || 1;
        } catch (e) { return 1; }
    }

    function getItemIdByName(itemName) {
        var itemId = null;
        search.create({
            type:    'item',
            filters: [['itemid', 'is', itemName]],
            columns: [search.createColumn({ name: 'internalid' })]
        }).run().each(function (result) {
            itemId = result.getValue({ name: 'internalid' });
            return false;
        });
        return itemId;
    }

    /* ═══════════════════════════════════════════════════════════════════════
       UI
    ═══════════════════════════════════════════════════════════════════════ */
    function renderSuccess(form, id) {
        form.addField({ id: 'custpage_msg', type: ui.FieldType.INLINEHTML, label: ' ' })
            .defaultValue = '<h3 style="color:green">Success</h3><p>Fulfillment: ' + id + '</p>';
    }

    function renderError(form, e) {
        form.addField({ id: 'custpage_err', type: ui.FieldType.INLINEHTML, label: ' ' })
            .defaultValue = '<h3 style="color:red">Error</h3><p>' + e + '</p>';
    }

    return { onRequest: onRequest };

});