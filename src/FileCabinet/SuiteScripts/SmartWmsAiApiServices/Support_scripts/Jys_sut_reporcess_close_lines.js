/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 */
define(['N/record', 'N/log'], (record, log) => {

    const onRequest = (context) => {

        if (context.request.method !== 'GET') {
            context.response.write('Only GET supported');
            return;
        }

        try {

            const fulfillmentId = context.request.parameters.ifid;

            if (!fulfillmentId) {
                context.response.write('Missing parameter: ifid');
                return;
            }

            // Load Item Fulfillment
            const ifRec = record.load({
                type: record.Type.ITEM_FULFILLMENT,
                id: fulfillmentId,
                isDynamic: false
            });

            const soId = ifRec.getValue({ fieldId: 'createdfrom' });

            if (!soId) {
                context.response.write('No originating Sales Order found.');
                return;
            }

            // Build Fulfilled Line Map (Composite Key)
            const fulfilledMap = new Set();
            const ifLineCount = ifRec.getLineCount({ sublistId: 'item' });

            for (let i = 0; i < ifLineCount; i++) {

                const isFulfilled = ifRec.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'itemreceive',
                    line: i
                });

                if (isFulfilled) {

                    const lineKey = ifRec.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'lineuniquekey',
                        line: i
                    });

                    const item = ifRec.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'item',
                        line: i
                    });

                    const qty = ifRec.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'quantity',
                        line: i
                    });

                    const compositeKey = `${lineKey}_${item}_${qty}`;
                    fulfilledMap.add(compositeKey);
                }
            }

            // Load Sales Order
            const soRec = record.load({
                type: record.Type.SALES_ORDER,
                id: soId,
                isDynamic: false
            });

            const soLineCount = soRec.getLineCount({ sublistId: 'item' });
            let closedCount = 0;

            for (let i = 0; i < soLineCount; i++) {

                const soLineKey = soRec.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'lineuniquekey',
                    line: i
                });

                const soItem = soRec.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'item',
                    line: i
                });

                const soQty = soRec.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'quantity',
                    line: i
                });

                const isClosed = soRec.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'isclosed',
                    line: i
                });

                const soCompositeKey = `${soLineKey}_${soItem}_${soQty}`;

                // If no exact match in fulfilled set → close line
                if (!fulfilledMap.has(soCompositeKey) && !isClosed) {

                    soRec.setSublistValue({
                        sublistId: 'item',
                        fieldId: 'isclosed',
                        line: i,
                        value: true
                    });

                    closedCount++;
                }
            }

            if (closedCount > 0) {
                soRec.save({
                    enableSourcing: false,
                    ignoreMandatoryFields: true
                });
            }

            context.response.write(
                `Process complete. Closed ${closedCount} Sales Order lines.`
            );

        } catch (error) {

            log.error({
                title: 'Error',
                details: error
            });

            context.response.write('Error: ' + error.message);
        }
    };

    return { onRequest };
});