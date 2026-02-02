/**
 * @NApiVersion 2.1
 * @NModuleScope Public
 */
define(['N/record', 'N/log'], function (record, log) {

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

        return {
            success: !hasFailure,
            data: results
        };
    }

    /* =========================
       RMA CREATION
       ========================= */
    function createRMA(soId, payloadItems, returnType) {
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

                var payloadItem = payloadItems.find(function (p) {
                    return Number(p.itemInternalId) === Number(itemId);
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
            throw new Error('RMA_CREATION_FAILED: ' + e.message);
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

                var payloadItem = payloadItems.find(function (p) {
                    return Number(p.itemInternalId) === Number(itemId);
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
            throw new Error('ITEM_RECEIPT_CREATION_FAILED: ' + e.message);
        }
    }

    return {
        processReturn: processReturn
    };
});
