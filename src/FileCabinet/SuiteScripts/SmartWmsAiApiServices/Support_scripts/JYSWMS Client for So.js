/**
 * @NApiVersion 2.x
 * @NScriptType ClientScript
 */
define(['N/search','N/currentRecord','N/ui/message','N/log'], function (search, currentRecord, message, log) {

    var JYSWMS_ENABLED = false;

    /* ---------------- PAGE INIT ---------------- */
    function pageInit(context) {
        alert('JYSWMS Client Script Loaded');
        var rec = context.currentRecord;
       
        var customer = rec.getValue({ fieldId: 'entity' });
        var cuslookup = search.lookupFields({
            type: search.Type.CUSTOMER,
            id: customer,
            columns: ['custentity_jyswms_enable']
        });
        // Check customer-level flag
        var isEnabled = cuslookup.custentity_jyswms_enable;

        log.error('JYSWMS Client Script Loaded. JYSWMS Enabled: ' , isEnabled);
        JYSWMS_ENABLED = (isEnabled === true || isEnabled === 'T');

        if (!JYSWMS_ENABLED) return;

        // Color all existing lines on load
        colorAllLines(rec);
    }

    /* ---------------- LINE INIT ---------------- */
    function lineInit(context) {
        if (!JYSWMS_ENABLED) return;
        if (context.sublistId !== 'item') return;

        colorCurrentLine(context.currentRecord);
    }

    /* ---------------- FIELD CHANGED ---------------- */
    function fieldChanged(context) {
        if (!JYSWMS_ENABLED) return;
        if (context.sublistId !== 'item') return;

        if (
            context.fieldId === 'quantity' ||
            context.fieldId === 'custcol_jyswms_picked_qty'
        ) {
            colorCurrentLine(context.currentRecord);
        }
    }

    /* ---------------- HELPERS ---------------- */

    function colorAllLines(rec) {
        var lineCount = rec.getLineCount({ sublistId: 'item' });

        for (var i = 0; i < lineCount; i++) {
            applyColor(rec, i);
        }
    }

    function colorCurrentLine(rec) {
        var line = rec.getCurrentSublistIndex({
            sublistId: 'item'
        });
        applyColor(rec, line);
    }

    function applyColor(rec, line) {
        var orderedQty = rec.getSublistValue({
            sublistId: 'item',
            fieldId: 'quantity',
            line: line
        });

        var pickedQty = rec.getSublistValue({
            sublistId: 'item',
            fieldId: 'custcol_jyswms_picked_qty',
            line: line
        });

        var row = document.querySelector(
            '#item_splits > tbody > tr[data-line="' + line + '"]'
        );

        if (!row) return;

        // Clear existing color
        row.style.backgroundColor = '';

        // No picked qty → no color
        if (!pickedQty && pickedQty !== 0) return;

        if (Number(pickedQty) === Number(orderedQty)) {
            row.style.backgroundColor = '#76f38f'; // green
        } else {
            row.style.backgroundColor = '#ea9ca5'; // red
        }
    }

    return {
        pageInit: pageInit,
        lineInit: lineInit,
        fieldChanged: fieldChanged
    };
});
