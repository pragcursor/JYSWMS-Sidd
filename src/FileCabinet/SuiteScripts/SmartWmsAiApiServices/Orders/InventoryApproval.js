/**
* @NApiVersion 2.1
* @NModuleScope Public
*/
define(['N/search', 'N/log', 'N/runtime', 'N/record'], function (search, log, runtime, record) {

    function getUnapprovedAdjustments(context) {
        try {
            var unapprovedAdjustments = [];
            const transactionSearchObj = search.create({
                type: "transaction",
                filters:
                    [
                        [["type", "anyof", "InvAdjst"], "AND", ["mainline", "is", "F"], "AND", ["inventorydetail.binnumber", "noneof", "4859", "16692", "1206", "503", "16691", "1408", "1410", "16727", "16735", "16752"], "AND", ["datecreated", "onorafter", "1/1/2026 12:00 am"], "AND", ["custbody_wms_ai_created_by", "is", "T"]],
                        "AND",
                        [["quantity", "greaterthanorequalto", "-10"], "OR", ["quantity", "greaterthanorequalto", "10"]],
                        "AND",
                        [[["custbody_realted_sales_order.internalidnumber", "isnotempty", ""], "AND", ["custbody_realted_sales_order.mainline", "is", "T"]], "OR", ["custbody_realted_sales_order.internalidnumber", "isempty", ""]],
                        "AND",
                        ["custcol_jyswms_adj_manager_approved", "is", "F"],
                        "AND",
                        ["datecreated", "onorafter", "3/1/2026 12:00 am"]
                    ],
                columns:
                    [
                        search.createColumn({
                            name: "lineuniquekey",
                            summary: "GROUP",
                            label: "Line Unique Key"
                        }),
                        search.createColumn({
                            name: "internalid",
                            summary: "GROUP",
                            label: "INVADJ Internal Id"
                        }),
                        search.createColumn({
                            name: "tranid",
                            summary: "GROUP",
                            label: "INV Adjustment"
                        }),
                        search.createColumn({
                            name: "datecreated",
                            summary: "GROUP",
                            label: "Date Created"
                        }),
                        search.createColumn({
                            name: "item",
                            summary: "GROUP",
                            label: "Item"
                        }),
                        search.createColumn({
                            name: "binnumber",
                            join: "inventoryDetail",
                            summary: "GROUP",
                            label: "Bin Number"
                        }),
                        search.createColumn({
                            name: "quantity",
                            summary: "SUM",
                            label: "Quantity"
                        }),
                        search.createColumn({
                            name: "location",
                            summary: "GROUP",
                            label: "Location"
                        }),
                        search.createColumn({
                            name: "memomain",
                            summary: "GROUP",
                            label: "Memo (Main)"
                        }),
                        search.createColumn({
                            name: "custbody_wms_ai_pickername",
                            summary: "GROUP",
                            label: "JYSWMS User Id"
                        }),
                        search.createColumn({
                            name: "internalid",
                            join: "CUSTBODY_REALTED_SALES_ORDER",
                            summary: "GROUP",
                            label: "Internal ID"
                        }),
                        search.createColumn({
                            name: "tranid",
                            join: "CUSTBODY_REALTED_SALES_ORDER",
                            summary: "GROUP",
                            label: "Document Number"
                        }),
                        search.createColumn({
                            name: "custcol_jyswms_adj_manager_approved",
                            summary: "GROUP",
                            label: "JYSWMS ADJ Manager Approved"
                        })
                    ]
            });
            const searchResultCount = transactionSearchObj.runPaged().count;
            log.debug("transactionSearchObj result count", searchResultCount);
            transactionSearchObj.run().each(function (result) {

                var pickerName = result.getValue({
                    name: "custbody_wms_ai_pickername",
                    summary: "GROUP"
                });

                var cleanPickerName = pickerName
                    ? pickerName.replace(/(portal Id:.*|via Portal-.*)$/i, '').trim()
                    : '';
                // .run().each has a limit of 4,000 results
                var adjustmentData = {
                    datecreated: result.getValue({ name: "datecreated", summary: "GROUP" }),
                    invadjstinternalid: result.getValue({ name: "internalid", summary: "GROUP" }),
                    invadjsttranid: result.getValue({ name: "tranid", summary: "GROUP" }),
                    item: result.getText({ name: "item", summary: "GROUP" }),
                    itemid: result.getValue({ name: "item", summary: "GROUP" }),
                    binnumber: result.getText({ name: "binnumber", join: "inventoryDetail", summary: "GROUP" }),
                    binid: result.getValue({ name: "binnumber", join: "inventoryDetail", summary: "GROUP" }),
                    quantity: result.getValue({ name: "quantity", summary: "SUM" }),
                    location: result.getText({ name: "location", summary: "GROUP" }),
                    locationid: result.getValue({ name: "location", summary: "GROUP" }),
                    memomain: result.getValue({ name: "memomain", summary: "GROUP" }),
                    pickername: cleanPickerName,
                    salesorderid: result.getValue({ name: "internalid", join: "CUSTBODY_REALTED_SALES_ORDER", summary: "GROUP" }),
                    salesordernumber: result.getValue({ name: "tranid", join: "CUSTBODY_REALTED_SALES_ORDER", summary: "GROUP" }),
                    jyswmsadjmanagerapproved: result.getValue({ name: "custcol_jyswms_adj_manager_approved", summary: "GROUP" }),
                    lineuniquekey: result.getValue({ name: "lineuniquekey", summary: "GROUP" })
                };
                unapprovedAdjustments.push(adjustmentData); // unapprovedAdjustments.push();
                return true;

            });

            return {
                status: 200,
                message: "Unapproved Adjustments retrieved successfully",
                totalCount: searchResultCount,
                data: unapprovedAdjustments
            };
        } catch (e) {
            log.error("Error in getUnapprovedAdjustments function", e);
            return false;
        }
    }

    function getOldBinTransfers(context) {
        try {
            var oldBinTransfers = [];
            const binTransferSearchObj = search.create({
                type: "bintransfer",
                filters:
                    [
                        ["type", "anyof", "BinTrnfr"],
                        "AND",
                        ["custbodybulk_picking_processed", "is", "F"],
                        "AND",
                        ["mainline", "is", "T"],
                        "AND",
                        ["location", "anyof", "15", "9"],
                        "AND",
                        ["custbody_wms_bulk_picking_processed", "is", "F"],
                        "AND",
                        ["custbody_wms_mobile_trans_created_by", "anyof", "@NONE@"],
                        "AND",
                        ["custbody_realted_sales_order.status", "noneof", "SalesOrd:C", "SalesOrd:G", "SalesOrd:H"],
                        "AND",
                        ["custbody_realted_sales_order.mainline", "is", "T"],
                        "AND",
                        ["custbody_do_not_batch_bt", "is", "F"],
                        "AND",
                        ["custbody_realted_sales_order.custbody_wms_donotpick_so", "is", "F"],
                        "AND",
                        ["custbody_realted_sales_order.custbody_bulk_picking_rec", "anyof", "@NONE@"]
                    ],
                columns:
                    [
                        search.createColumn({
                            name: "internalid",
                            summary: "GROUP",
                            label: "Internal ID"
                        })
                    ]
            });
            const searchResultCount = binTransferSearchObj.runPaged().count;
            log.error("binTransferSearchObj result count", searchResultCount);
            binTransferSearchObj.run().each(function (result) {
                oldBinTransfers.push(result.getValue({
                    name: "internalid",
                    summary: "GROUP",
                }));
                return true;
            });

            return {
                status: 200,
                message: "Old Bin Transfers retrieved successfully",
                data: oldBinTransfers
            };
        } catch (e) {
            log.error("Error in getOldBinTransfers function", e);
            return false;
        }
    }

    function getOldUnpickedOrders(context) {
        try {
            var oldUnpickedOrders = [];
            const salesorderSearchObj = search.create({
                type: "salesorder",
                filters:
                    [
                        ["type", "anyof", "SalesOrd"],
                        "AND",
                        ["mainline", "is", "T"],
                        "AND",
                        ["custbody_jys_enabled_customer", "is", "F"],
                        "AND",
                        ["status", "anyof", "SalesOrd:A", "SalesOrd:B"],
                        "AND",
                        ["custbody_bulk_picking_rec", "anyof", "@NONE@"]
                    ],
                columns:
                    [
                        search.createColumn({
                            name: "internalid",
                            summary: "GROUP",
                            label: "Internal ID"
                        })
                    ]
            });
            const searchResultCount = salesorderSearchObj.runPaged().count;
            log.debug("salesorderSearchObj result count", searchResultCount);
            salesorderSearchObj.run().each(function (result) {
                oldUnpickedOrders.push(result.getValue({
                    name: "internalid",
                    summary: "GROUP",
                }));
                // .run().each has a limit of 4,000 results
                return true;
            });

            return {
                status: 200,
                message: "Old Unpicked Orders retrieved successfully",
                data: oldUnpickedOrders
            };
        } catch (e) {
            log.error("Error in getOldUnpickedOrders function", e);
            return {
                status: 500,
                message: e.message
            };
        }
    }

    function InventoryManagerApproved(context) {
        try {

            var invId = context.invadjstinternalid;
            var lineUniqueKey = context.unique_id;


            var searchItem = null;
            var searchQty = null;

            var searchObj = search.create({
                type: 'inventoryadjustment',
                filters: [
                    // ['internalid', 'is', invId],
                    // 'AND',
                    // ['mainline', 'is', 'F'],
                    // 'AND',
                    // ['lineuniquekey', 'is', lineUniqueKey]
                    ["type", "anyof", "InvAdjst"],
                    "AND",
                    ["lineuniquekey", "equalto", lineUniqueKey],
                    "AND",
                    ["mainline", "is", "F"]
                ],
                columns: [
                    search.createColumn({ name: "item", label: "Item" }),
                    search.createColumn({ name: "quantity", label: "Quantity" }),
                    // 'item',
                    // search.createColumn({
                    //     name: 'formulanumeric',
                    //     formula: '{inventory.adjustqtyby}'
                    // })
                ]
            });
            searchObj.run().each(function (result) {
                searchItem = result.getValue('item');
                // searchQty = result.getValue('adjustqtyby');
                searchQty = result.getValue('quantity');
                log.error('Search Match Found', {
                    item: searchItem,
                    qty: searchQty
                });

                return false;
            });

            if (!searchItem) {
                return {
                    status: 'failed',
                    message: 'Line not found in search'
                };
            }


            var rec = record.load({
                type: record.Type.INVENTORY_ADJUSTMENT,
                id: invId,
                isDynamic: false
            });

            var lineCount = rec.getLineCount({ sublistId: 'inventory' });

            var lineFound = false;

            var payloadQty = Number(context.quantity);
            var userName = context.username;

            for (var i = 0; i < lineCount; i++) {

                var currentItem = rec.getSublistValue({
                    sublistId: 'inventory',
                    fieldId: 'item',
                    line: i
                });

                var currentQty = rec.getSublistValue({
                    sublistId: 'inventory',
                    fieldId: 'adjustqtyby',
                    line: i
                });

                log.error('Compare Line', {
                    line: i,
                    currentItem: currentItem,
                    currentQty: currentQty,
                    searchItem: searchItem,
                    payloadQty: payloadQty
                });

                if (
                    String(currentItem) === String(searchItem) &&
                    Number(currentQty) === Number(payloadQty)
                ) {

                    rec.setSublistValue({
                        sublistId: 'inventory',
                        fieldId: 'custcol_jyswms_adj_manager_approved',
                        line: i,
                        value: true
                    });
                    rec.setSublistValue({
                        sublistId: 'inventory',
                        fieldId: 'memo',
                        line: i,
                        value: "Approved by " + userName
                    });

                    log.emergency('Line Updated', i);
                    lineFound = true;
                    break;
                }
            }

            if (!lineFound) {
                return {
                    status: 'failed',
                    message: 'Line not matched in record'
                };
            }

            var savedId = rec.save();

            return {
                status: 'success',
                recordId: savedId
            };

        } catch (e) {
            log.error('Error', e);

            return {
                status: 'error',
                message: e.message
            };
        }
    }

    return {
        getUnapprovedAdjustments: getUnapprovedAdjustments,
        InventoryManagerApproved: InventoryManagerApproved,
        getOldBinTransfers: getOldBinTransfers,
        getOldUnpickedOrders: getOldUnpickedOrders
    };
});