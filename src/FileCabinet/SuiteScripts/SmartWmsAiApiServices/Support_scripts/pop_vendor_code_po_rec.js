/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/record', 'N/search', 'N/log'], function (record, search, log) {

    function afterSubmit(context) {
        try {

            if (context.type === context.UserEventType.DELETE) return;

            var poId = context.newRecord.id;

            var poRec = record.load({
                type: record.Type.PURCHASE_ORDER,
                id: poId,
                isDynamic: false
            });

            var poVendor = poRec.getValue('entity');
            var lineCount = poRec.getLineCount({ sublistId: 'item' });
            if (!lineCount) return;

            // ===============================
            // Collect unique item ids
            // ===============================
            var itemMap = {};
            var itemList = [];

            for (var i = 0; i < lineCount; i++) {
                var itemId = poRec.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'item',
                    line: i
                });

                if (itemId && !itemMap[itemId]) {
                    itemMap[itemId] = true;
                    itemList.push(itemId);
                }
            }

            if (!itemList.length) return;

            // ===============================
            // Bulk item search (YOUR WORKING MODEL)
            // ===============================
            var itemDataMap = {};

            var itemSearch = search.create({
                type: search.Type.INVENTORY_ITEM,
                filters: [
                    ['internalid', 'anyof', itemList],
  
                ],
                columns: [
                    'internalid',
                    'mpn',
                  'othervendor',
                    'vendorcode'
                ]
            });

            itemSearch.run().each(function (result) {

                var itemId = result.getValue('internalid');
                var mpn = result.getValue('mpn') || '';
                var vendorCode = result.getValue('vendorcode') || '';
              var othervendor=result.getValue('othervendor') || '';

              if(othervendor!=poVendor)
                vendorCode='';
                itemDataMap[itemId] = {
                    mpn: mpn,
                    vendorCode: vendorCode
                };

                return true;
            });

            // ===============================
            // Update PO lines
            // ===============================
            var needsSave = false;

            for (var j = 0; j < lineCount; j++) {

                var lineItemId = poRec.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'item',
                    line: j
                });

                var itemInfo = itemDataMap[lineItemId];
                if (!itemInfo) continue;

                var valueToSet = '';

                // Priority 1: vendor code
                if (itemInfo.vendorCode) {
                    valueToSet = itemInfo.vendorCode;
                }
                // Priority 2: MPN fallback
                else if (itemInfo.mpn) {
                    valueToSet = itemInfo.mpn;
                }

                if (valueToSet) {
                    poRec.setSublistValue({
                        sublistId: 'item',
                        fieldId: 'custcol_vendor_idv2',
                        line: j,
                        value: valueToSet
                    });
                    needsSave = true;
                }
            }

            if (needsSave) {
                poRec.save({
                    enableSourcing: false,
                    ignoreMandatoryFields: true
                });
            }

        } catch (e) {
            log.error('PO Vendor/MPN AfterSubmit Error', e);
        }
    }

    return {
        afterSubmit: afterSubmit
    };
});