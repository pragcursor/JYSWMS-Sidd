/**
 * @NApiVersion 2.x
 * @NScriptType MapReduceScript
 */

define(['N/search', 'N/record', 'N/runtime', 'N/log'], function (search, record, runtime, log) {

    /* ===========================
       1. GET INPUT DATA
    ============================ */
    function getInputData() {

        return search.create({
            type: "salesorder",
            filters: [
                ["type", "anyof", "SalesOrd"],
                "AND",
                ["mainline", "is", "F"],
                "AND",
                ["shipping", "is", "F"],
                "AND",
                ["taxline", "is", "F"],
                "AND",
                ["item", "noneof", "57740"],
                "AND",
                ["location", "anyof", "15"],
                "AND",
                ["custbody_jyswms_send_order", "is", "T"],
                "AND",
                ["custbody_bol_tracking_number", "isempty", ""],
                "AND",
                ["status", "anyof", "SalesOrd:B"],
                "AND",
                ["custcol_line_level_bin_tranfer_ref", "anyof", "@NONE@"],
                "AND",
                ["datecreated", "on", "11/24/2025 11:59 pm"]
            ],
            columns: [
                search.createColumn({ name: "internalid" }),
                search.createColumn({ name: "item" }),
                search.createColumn({ name: "quantity" }),
                search.createColumn({ name: "location" }),
                search.createColumn({ name: "custcol_line_level_bin_tranfer_ref" }),
                search.createColumn({ name: "custcol_bin_transfer_details" }),
                search.createColumn({ name: "lineuniquekey" })
            ]
        });
    }

    /* ===========================
       2. MAP
    ============================ */
    function map(context) {

        var result = JSON.parse(context.value);

        var salesOrderId = result.id;
        var binDetails = result.values.custcol_bin_transfer_details;
        var lineUniqueKey = result.values.lineuniquekey;

        if (!binDetails) return;

        // Format expected: itemId@@fromBin@@quantity##
        var clean = binDetails.replace("##", "");
        var parts = clean.split("@@");

        if (parts.length < 3) {
           // log.error("Invalid binDetails format", binDetails);
            return;
        }

        var itemId = parts[0];
        var fromBin = parts[1];
        var qty = parseFloat(parts[2]);

        if (!itemId || !fromBin || isNaN(qty)) {
         //   log.error("Invalid parsed data", parts);
            return;
        }

        var parsedData = {
            salesOrderId: salesOrderId,
            lineUniqueKey: lineUniqueKey,
            itemId: itemId,
            fromBin: fromBin,
            quantity: qty
        };

        context.write({
            key: salesOrderId + "_" + lineUniqueKey,
            value: parsedData
        });
    }

    /* ===========================
       3. REDUCE — CREATE BIN TRANSFER & UPDATE LINE
    ============================ */
    function reduce(context) {

        var data = JSON.parse(context.values[0]);
        var binTransferId = null;

        try {

            var binTransfer = record.create({
                type: record.Type.BIN_TRANSFER,
                isDynamic: true
            });

            binTransfer.setValue({ fieldId: 'location', value: 15 });
            binTransfer.setValue({ fieldId: 'memo', value: 'NetscoreamXYZ' });

            // ⚠⚠ CHECK IF THIS FIELD ID IS CORRECT IN YOUR ACCOUNT
            binTransfer.setValue({ fieldId: 'custbody_realted_sales_order', value: data.salesOrderId });

            // Add Line
            binTransfer.selectNewLine({ sublistId: 'inventory' });

            binTransfer.setCurrentSublistValue({
                sublistId: 'inventory',
                fieldId: 'item',
                value: data.itemId
            });

            binTransfer.setCurrentSublistValue({
                sublistId: 'inventory',
                fieldId: 'quantity',
                value: data.quantity
            });

            // Inventory detail
            var inventoryDetail = binTransfer.getCurrentSublistSubrecord({
                sublistId: 'inventory',
                fieldId: 'inventorydetail'
            });

            inventoryDetail.selectNewLine({ sublistId: 'inventoryassignment' });

            inventoryDetail.setCurrentSublistValue({
                sublistId: 'inventoryassignment',
                fieldId: 'binnumber',
                value: parseInt(data.fromBin)
            });

            // toBin hard-coded from your original script
            inventoryDetail.setCurrentSublistValue({
                sublistId: 'inventoryassignment',
                fieldId: 'tobinnumber',
                value: 16692
            });

            inventoryDetail.setCurrentSublistValue({
                sublistId: 'inventoryassignment',
                fieldId: 'quantity',
                value: data.quantity
            });

            inventoryDetail.commitLine({ sublistId: 'inventoryassignment' });

            binTransfer.commitLine({ sublistId: 'inventory' });

            binTransferId = binTransfer.save();
            log.audit("Bin Transfer Created", binTransferId);

        } catch (error) {
            log.error("Error while creating bin transfer", error);
        }

        // Update SO only if BT created
        if (binTransferId)
            updateSOLine(data.salesOrderId, data.lineUniqueKey, binTransferId);
    }

    /* ===========================
       4. UPDATE SALES ORDER LINE
    ============================ */
    function updateSOLine(salesOrderId, lineUniqueKey, binTransferId) {

        try {
            var soRecord = record.load({
                type: record.Type.SALES_ORDER,
                id: salesOrderId,
                isDynamic: true
            });

            var lineCount = soRecord.getLineCount({ sublistId: 'item' });

            for (var i = 0; i < lineCount; i++) {

                var currentKey = soRecord.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'lineuniquekey',
                    line: i
                });

                if (currentKey == lineUniqueKey) {

                    soRecord.selectLine({ sublistId: 'item', line: i });

                    soRecord.setCurrentSublistValue({
                        sublistId: 'item',
                        fieldId: 'custcol_line_level_bin_tranfer_ref',
                        value: binTransferId
                    });

                    soRecord.commitLine({ sublistId: 'item' });
                    break;
                }
            }

            soRecord.save({ enableSourcing: true, ignoreMandatoryFields: true });

        } catch (error) {
            log.error("Error while updating Sales Order line", error);
        }
    }

    /* ===========================
       5. SUMMARY
    ============================ */
    function summarize(summary) {

        log.audit("Usage", summary.usage);
        log.audit("Concurrency", summary.concurrency);
        log.audit("Yields", summary.yields);

        summary.mapSummary.errors.iterator().each(function (key, error) {
           // log.error("Map Error for key " + key, error);
            return true;
        });

        summary.reduceSummary.errors.iterator().each(function (key, error) {
          // log.error("Reduce Error for key " + key, error);
            return true;
        });
    }

    return {
        getInputData: getInputData,
        map: map,
        reduce: reduce,
        summarize: summarize
    };
});
