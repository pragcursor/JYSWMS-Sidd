/**
 * @NApiVersion 2.1
 * @NModuleScope Public
 */
define(['N/record', 'N/log'], function (record, log) {

    var locRma = '';
    // if (locRma == 15) {
    //     const STATIC_RESALE_BIN_ID = 16735;
    // } else if (locRma == 9) {
    //     const STATIC_RESALE_BIN_ID = 4963;
    // }

    function processReturn(payload) {
        var results = [];
        var hasFailure = false;
       // log.error("payload received", payload);
        // var body = Array.isArray(payload)
        //     ? payload
        //     : JSON.parse(payload);

        var body = payload;


        log.error("payload", body);
       // return { 'test': 'test' };

        body.forEach(function (orderObj) {
            try {
                var soId = orderObj.soId;
                var items = orderObj.items || [];

                var rmaId = createRMA(soId, items);
                var irId = createItemReceipt(rmaId, items);

                results.push({
                    salesOrderId: Number(soId),
                    returnAuthorizationId: rmaId,
                    itemReceiptId: irId,
                    status: 'SUCCESS'
                });

            } catch (e) {
                hasFailure = true;

                log.error('Return failed for SO ' + orderObj.soId, e);

                results.push({
                    salesOrderId: Number(orderObj.soId),
                    status: 'FAILED',
                    errorMessage: e.message || 'Unknown error',
                    // errorStack: e.stack
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
    function createRMA(soId, payloadItems) {
        try {
            var rmaRec = record.transform({
                fromType: record.Type.SALES_ORDER,
                fromId: soId,
                toType: record.Type.RETURN_AUTHORIZATION,
                isDynamic: true
            });

            rmaRec.setValue({
                fieldId: 'orderstatus',
                value: 'B' // Pending Approval
            });
            locRma = rmaRec.getValue({
                fieldId: 'location'
            });
            var memoBlocks = [];
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
                    memoBlocks.push(
                        'Item: ' + payloadItem.itemName +
                        '\n' + payloadItem.images_urls.join('\n')
                    );
                }

                rmaRec.commitLine({ sublistId: 'item' });
            }

            if (memoBlocks.length) {
                rmaRec.setValue({
                    fieldId: 'custbody_jyswms__returns_captured_url',
                    value: memoBlocks.join('\n\n')
                });
            }

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
    function createItemReceipt(rmaId, payloadItems) {
        try {
            var irRec = record.transform({
                fromType: record.Type.RETURN_AUTHORIZATION,
                fromId: rmaId,
                toType: record.Type.ITEM_RECEIPT,
                isDynamic: true
            });

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

                var isResale = payloadItem.item_return_type.toUpperCase() === 'RE-SALE';

                irRec.setCurrentSublistValue({
                    sublistId: 'item',
                    fieldId: 'quantity',
                    value: payloadItem.return_qty
                });

                if (isResale) {
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
                    // inventoryDetail.setCurrentSublistValue({
                    //     sublistId: 'inventoryassignment',
                    //     fieldId: 'binnumber',
                    //     value: STATIC_RESALE_BIN_ID
                    // });

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