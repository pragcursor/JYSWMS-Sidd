/**
 * @NApiVersion 2.1
 * @NModuleScope Public
 */
define(['N/record', 'N/log', 'N/search', 'N/format'], function (record, log, search, format) {

    /* =========================
       ENTRY POINT
       ========================= */
    function processReturn(payload) {
        var results = [];
        var hasFailure = false;

        var body = payload;

        body.forEach(function (orderObj) {
            try {
                var soId = orderObj.soId;
                var items = orderObj.items || [];

                var damageItems = items.filter(function (i) {
                    return i.item_return_type &&
                        i.item_return_type.toUpperCase() === 'DAMAGE';
                });

                var resaleItems = items.filter(function (i) {
                    return i.item_return_type &&
                        i.item_return_type.toUpperCase() === 'RE-SALE';
                });

                if (damageItems.length) {
                    var damageRmaId = createRMA(soId, damageItems, 'DAMAGE');
                    var damageIrId = createItemReceipt(damageRmaId, damageItems, 'DAMAGE');
                    var updateso = updatesolines(soId, damageItems)
                    results.push({
                        salesOrderId: Number(soId),
                        returnAuthorizationId: damageRmaId,
                        itemReceiptId: damageIrId,
                        returnType: 'DAMAGE',
                        status: 'SUCCESS'
                    });
                }

                if (resaleItems.length) {
                    var resaleRmaId = createRMA(soId, resaleItems, 'RE-SALE');
                    var resaleIrId = createItemReceipt(resaleRmaId, resaleItems, 'RE-SALE');
                    var updateso = updatesolines(soId, damageItems)
                    results.push({
                        salesOrderId: Number(soId),
                        returnAuthorizationId: resaleRmaId,
                        itemReceiptId: resaleIrId,
                        returnType: 'RE-SALE',
                        status: 'SUCCESS'
                    });
                }

            } catch (e) {
                hasFailure = true;
                log.error('Return failed for SO ' + orderObj.soId, e);

                results.push({
                    salesOrderId: Number(orderObj.soId),
                    status: 'FAILED',
                    errorMessage: e.message || 'Unknown error'
                });
            }
        });
        log.error('results', results)
        return {
            success: !hasFailure,
            data: results
        };
    }

    /* =========================
       RMA CREATION
       ========================= */
    function createRMA(soId, payloadItems, returnType) {
        // log.error('payloadItems - RMA', payloadItems)
        // log.error('soId', soId)
        // log.error('returnType', returnType)

        try {
            var rmaRec = record.transform({
                fromType: record.Type.SALES_ORDER,
                fromId: soId,
                toType: record.Type.RETURN_AUTHORIZATION,
                isDynamic: true
            });
            rmaRec.setValue({ fieldId: 'orderstatus', value: 'B' });

            var Imageblocks = [];
            var lineCount = rmaRec.getLineCount({ sublistId: 'item' });

            for (var i = lineCount - 1; i >= 0; i--) {
                rmaRec.selectLine({ sublistId: 'item', line: i });

                var itemId = rmaRec.getCurrentSublistValue({
                    sublistId: 'item',
                    fieldId: 'item'
                });
                var lineuniqId = rmaRec.getCurrentSublistValue({
                    sublistId: 'item',
                    fieldId: 'lineuniquekey'
                });

                var payloadItem = payloadItems.find(function (p) {
                    //   return Number(p.itemInternalId) === Number(itemId);
                    return Number(p.uniqueId) == Number(lineuniqId);
                });

                if (!payloadItem) {
                    rmaRec.removeLine({ sublistId: 'item', line: i });
                    continue;
                }

                rmaRec.setCurrentSublistValue({
                    sublistId: 'item',
                    fieldId: 'quantity',
                    value: payloadItem.return_qty
                });

                if (payloadItem.reason) {
                    rmaRec.setCurrentSublistValue({
                        sublistId: 'item',
                        fieldId: 'description',
                        value: payloadItem.reason
                    });
                }

                if (payloadItem.images_urls && payloadItem.images_urls.length) {
                    Imageblocks.push(
                        'Item: ' + payloadItem.itemName +
                        '\n' + payloadItem.images_urls.join('\n')
                    );
                }

                rmaRec.commitLine({ sublistId: 'item' });
            }

            if (Imageblocks.length) {
                rmaRec.setValue({
                    fieldId: 'custbody_jyswms__returns_captured_url',
                    value: Imageblocks.join('\n\n')
                });

            }

            rmaRec.setValue({
                fieldId: 'custbody_jyswms_rma_status',
                value: returnType
            });

            return rmaRec.save({
                enableSourcing: true,
                ignoreMandatoryFields: true
            });

        } catch (e) {
            log.error('RMA Creation Error', e);
            // throw new Error('RMA_CREATION_FAILED: ' + e.message);
        }
    }

    /* =========================
       ITEM RECEIPT CREATION
       ========================= */
    function createItemReceipt(rmaId, payloadItems, returnType) {

        try {
            var irRec = record.transform({
                fromType: record.Type.RETURN_AUTHORIZATION,
                fromId: rmaId,
                toType: record.Type.ITEM_RECEIPT,
                isDynamic: true
            });

            var locRma = irRec.getValue({ fieldId: 'location' });
            var lineCount = irRec.getLineCount({ sublistId: 'item' });

            for (var i = 0; i < lineCount; i++) {
                irRec.selectLine({ sublistId: 'item', line: i });

                var itemId = irRec.getCurrentSublistValue({
                    sublistId: 'item',
                    fieldId: 'item'
                });
                var lineuniqId = irRec.getCurrentSublistValue({
                    sublistId: 'item',
                    fieldId: 'lineuniquekey'
                });

                var payloadItem = payloadItems.find(function (p) {
                    return Number(p.itemInternalId) === Number(itemId);
                    // if (lineuniqId == p.uniqueId) {
                    //     log.error('lineuniqId', lineuniqId)
                    //     log.error('p.uniqueId', p.uniqueId)
                    // }
                    // return Number(p.uniqueId) == Number(lineuniqId);
                });

                if (!payloadItem) {
                    irRec.setCurrentSublistValue({
                        sublistId: 'item',
                        fieldId: 'itemreceive',
                        value: false
                    });
                    irRec.commitLine({ sublistId: 'item' });
                    continue;
                }

                irRec.setCurrentSublistValue({
                    sublistId: 'item',
                    fieldId: 'quantity',
                    value: payloadItem.return_qty
                });

                if (returnType === 'RE-SALE') {
                    irRec.setCurrentSublistValue({
                        sublistId: 'item',
                        fieldId: 'itemreceive',
                        value: true
                    });

                    irRec.setCurrentSublistValue({
                        sublistId: 'item',
                        fieldId: 'restock',
                        value: true
                    });

                    var inventoryDetail = irRec.getCurrentSublistSubrecord({
                        sublistId: 'item',
                        fieldId: 'inventorydetail'
                    });

                    inventoryDetail.selectNewLine({
                        sublistId: 'inventoryassignment'
                    });

                    if (locRma == 15) {
                        inventoryDetail.setCurrentSublistValue({
                            sublistId: 'inventoryassignment',
                            fieldId: 'binnumber',
                            value: 16735
                        });
                    } else if (locRma == 9) {
                        inventoryDetail.setCurrentSublistValue({
                            sublistId: 'inventoryassignment',
                            fieldId: 'binnumber',
                            value: 4963
                        });
                    }

                    inventoryDetail.setCurrentSublistValue({
                        sublistId: 'inventoryassignment',
                        fieldId: 'quantity',
                        value: payloadItem.return_qty
                    });

                    inventoryDetail.commitLine({
                        sublistId: 'inventoryassignment'
                    });
                }

                irRec.commitLine({ sublistId: 'item' });
            }

            return irRec.save({
                enableSourcing: true,
                ignoreMandatoryFields: true
            });

        } catch (e) {
            log.error('Item Receipt Creation Error', e);
            // throw new Error('ITEM_RECEIPT_CREATION_FAILED: ' + e.message);
        }
    }

    function updatesolines(soId, payloadItems) {
        try {
            var soRec = record.load({
                type: record.Type.SALES_ORDER,
                id: soId,
                isDynamic: false
            });

            var lineCount = soRec.getLineCount({ sublistId: 'item' });

            for (var i = 0; i < lineCount; i++) {
                var unique_Id = soRec.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'lineuniquekey',
                    line: i
                });
                var payloadItem = payloadItems.find(function (p) {
                    return Number(p.uniqueId) == Number(unique_Id);
                });
                if (payloadItem) {
                    soRec.setSublistValue({
                        sublistId: 'item',
                        fieldId: 'custcol_jyswms_picked_qty',
                        line: i,
                        value: Number(payloadItem.return_qty)
                    });
                }
            }
            soRec.save({
                enableSourcing: false,
                ignoreMandatoryFields: true
            });
            log.debug('Success', 'Retuned quantities updated successfully');
        } catch (error) {
            log.error('error in updating so', error)
        }
    }



    // =========================
    // get details of sales order return
    // =========================

    function getSalesOrderForReturn(context) {
        try {
            var payload = context;
            log.error('Get Sales Order for Return Payload', payload);

            var soNum = payload.soNumber;
            var ponum = payload.poNumber;
            var customerName = payload.customerName;
            var itemName = payload.itemName;
            var shipzip = payload.shipzip || payload.shipZip;
            shipzip = shipzip ? String(shipzip) : null;
            if (!soNum && !ponum && !customerName && !itemName && !shipzip) {
                return {
                    success: false,
                    message: 'At least one search criteria (soNumber, poNumber, customerName, itemName, shipzip) must be provided.'
                };
            }

            const today = new Date();
            const twelveMonthsAgo = new Date();
            twelveMonthsAgo.setMonth(today.getMonth() - 12);

            // Format to NetSuite (MM/DD/YYYY)
            function formatDate(date) {
                return (date.getMonth() + 1) + '/' + date.getDate() + '/' + date.getFullYear();
            }

            const startDate = formatDate(twelveMonthsAgo);
            const endDate = formatDate(today);

            var filters = [
                ["type", "anyof", "SalesOrd"], "AND",
                ["mainline", "is", "F"], "AND",
                ["taxline", "is", "F"], "AND",
                ["shipping", "is", "F"], "AND",
                ["shipdate", "within", startDate, endDate],
                // ["shipdate", "within", "previousonemonth"], // i want last 60 days

            ];

            if (soNum) {
                filters.push("AND", ["tranid", "is", soNum]);
            }
            if (ponum) {
                filters.push("AND", ["otherrefnum", "equalto", ponum]);
            }
            if (customerName) {
                filters.push("AND", ["customer.entityid", "haskeywords", customerName]);
            }
            if (itemName) {
                filters.push("AND", ["item.name", "is", itemName]);
            }
            if (shipzip) {
                filters.push("AND", ["shipzip", "is", shipzip]);
            }

            // log.error('Search Filters', filters);
            var salesorderSearchObj = search.create({
                type: "salesorder",
                filters: filters,
                columns: [
                    search.createColumn({ name: "internalid", sort: search.Sort.DESC }),          // SO ID
                    search.createColumn({ name: "tranid" }),              // SO Number
                    search.createColumn({ name: "otherrefnum" }),         // PO
                    search.createColumn({ name: "entityid", join: "customer" }),
                    search.createColumn({ name: "internalid", join: "customer" }),
                    search.createColumn({ name: "item" }),
                    search.createColumn({ name: "quantity" }),
                    search.createColumn({ name: "custcol_jyswms_picked_qty" }),
                    search.createColumn({ name: "lineuniquekey" }),
                    search.createColumn({ name: "shipzip" }),
                    search.createColumn({ name: "shipdate" }),
                    search.createColumn({ name: "shipstate" }),
                    search.createColumn({ name: "shipaddressee" }),

                ]
            });

            var resultSet = salesorderSearchObj.run();
            var firstResult = resultSet.getRange({ start: 0, end: 1 });
            //  log.error('First Search Result', firstResult);
            if (!firstResult || firstResult.length === 0) {
                return {
                    success: false,
                    message: 'No Sales Order found for the given criteria.'
                };
            }

            var salesOrderMap = {};

            salesorderSearchObj.run().each(function (result) {

                var soId = result.getValue({ name: "internalid" });

                // Create SO container once
                if (!salesOrderMap[soId]) {
                    salesOrderMap[soId] = {
                        soId: soId,
                        soNumber: result.getValue({ name: "tranid" }),
                        poNumber: result.getValue({ name: "otherrefnum" }),
                        customerName: result.getValue({ name: "entityid", join: "customer" }),
                        customerId: result.getValue({ name: "internalid", join: "customer" }),
                        shipzip: result.getValue({ name: "shipzip" }),
                        shipstate: result.getValue({ name: "shipstate" }),
                        shipaddressee: result.getValue({ name: "shipaddressee" }),
                        dateofpurchase: result.getValue({ name: "shipdate" }),
                        items: []
                    };
                }

                // Push line item
                salesOrderMap[soId].items.push({
                    itemInternalId: result.getValue({ name: "item" }),
                    itemName: result.getText({ name: "item" }),
                    quantity: Number(result.getValue({ name: "quantity" })) || 0,
                    pickedQty: Number(result.getValue({ name: "custcol_jyswms_picked_qty" })) || 0,
                    uniqueId: result.getValue({ name: "lineuniquekey" })
                });

                return true;
            });

            // Convert map → array
            var salesOrderArray = Object.keys(salesOrderMap).map(function (key) {
                return salesOrderMap[key];
            });
            log.error('Final Sales Order Array', salesOrderArray);
            return {
                success: true,
                data: salesOrderArray
            };



        } catch (error) {
            log.error('Get Sales Order for Return Error', error);
            return {
                success: false,
                message: 'Error occurred while fetching Sales Order details.' + error.message
            };
        }
    }


    return {
        processReturn: processReturn,
        getSalesOrderForReturn: getSalesOrderForReturn
    };
});
