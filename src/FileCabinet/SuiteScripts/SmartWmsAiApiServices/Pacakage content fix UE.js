/**
 *@NApiVersion 2.1
 *@NScriptType UserEventScript
 */
define(['N/record', 'N/log', 'N/search'], function (record, log, search) {

    function afterSubmit(context) {

        if (context.type !== context.UserEventType.CREATE &&
            context.type !== context.UserEventType.EDIT) {
            return;
        }

        try {
            var recId = context.newRecord.id;
            var swms = context.newRecord.getValue({
                fieldId: 'custrecord_jyswms_createdfrom'
            });

            var issue = context.newRecord.getValue({
                fieldId: 'custrecord_jyswms_item_not_populated'
            });
            // if (!swms) {
            //     log.debug('Exit', 'Not created from SWMS');
            //     return;
            // }
            if(!issue) {
                log.debug('Exit', 'Item already populated');
                return;
            }
            var pkgRec = record.load({
                type: 'customrecordhj_tc_package_contents',
                id: recId,
                isDynamic: true
            });



            var tranId = pkgRec.getValue({
                fieldId: 'custrecord_hj_packagecontents_sublist'
            });

            if (!tranId) {
                log.debug('Exit', 'No fulfillment linked');
                return;
            }

            var itemName = pkgRec.getValue({
                fieldId: 'custrecordhj_pkg_desc'
            });

            if (!itemName) return;

            itemName = itemName.replace(/\/.*$/, '').trim();
            var itemId = getItemId(itemName);

            //log.debug('itemId', itemId);
          
            if (!itemId) return;

            var sublistId = 'recmachcustrecordhj_tc_pkgcont_lineitemparent';

            /** ---------- DUPLICATE PREVENTION ---------- */
            var existingLineCount = pkgRec.getLineCount({ sublistId: sublistId });

            for (var i = 0; i < existingLineCount; i++) {
                var existingItem = pkgRec.getSublistValue({
                    sublistId: sublistId,
                    fieldId: 'custrecordhj_tc_pkgcontents_lineitemitem',
                    line: i
                });

                if (existingItem == itemId) {
                    log.debug('Exit', 'Item already exists on sublist');
                    return; // HARD STOP
                }
            }

            if (existingLineCount > 0) {

                pkgRec.setValue({
                    fieldId: 'custrecord_jyswms_item_not_populated',
                    value: false
                });
            }
            /** ------------------------------------------ */

            var itemDetails = getItemDetails(tranId, itemId);
           log.debug('itemDetails', itemDetails);
            if (!itemDetails || !itemDetails.length) return;
            var updated = false;
            // FORCE SINGLE LINE
            var item = itemDetails[0];
            if (existingLineCount <= 0) {
                pkgRec.selectNewLine({ sublistId: sublistId });
                pkgRec.setCurrentSublistValue({
                    sublistId: sublistId,
                    fieldId: 'custrecordhj_tc_pkgcontents_lineitemitem',
                    value: itemId             //item.itemId
                });
                pkgRec.setCurrentSublistValue({
                    sublistId: sublistId,
                    fieldId: 'custrecordhj_tc_pkgcontents_lineitemqty',
                    value: 1
                });
                pkgRec.setCurrentSublistValue({
                    sublistId: sublistId,
                    fieldId: 'custrecordhj_tc_pkgcontentslineitemdesc',
                    value: item.description
                });
                pkgRec.setCurrentSublistValue({
                    sublistId: sublistId,
                    fieldId: 'custrecordhj_tc_pkgcontents_lineitemwt',
                    value: item.weight
                });
                pkgRec.commitLine({ sublistId: sublistId });
                updated = true;
            }
            if(updated) {
                pkgRec.setValue({
                    fieldId: 'custrecord_jyswms_item_not_populated',
                    value: false
                });
            }
            // pkgRec.setValue({
            //     fieldId: 'custrecord_jyswms_item_not_populated',
            //     value: true
            // });
            pkgRec.save({
                enableSourcing: false,
                ignoreMandatoryFields: true
            });

            log.debug('Success', 'Single line added to package contents' + recId);

        } catch (e) {
            log.error('afterSubmit Error', e);
        }
    }

    function getItemDetails(tranId, itemId) {
        var details = [];

        var fulfill = record.load({
            type: record.Type.ITEM_FULFILLMENT,
            id: tranId
        });

        var count = fulfill.getLineCount({ sublistId: 'item' });

        for (var i = 0; i < count; i++) {
            var lineItem = fulfill.getSublistValue({
                sublistId: 'item',
                fieldId: 'item',
                line: i
            });
            // log.debug('lineItem', lineItem);
            if (lineItem == itemId) {
                details.push({
                    itemId: lineItem,
                    quantity: fulfill.getSublistValue({ sublistId: 'item', fieldId: 'quantity', line: i }),
                    description: fulfill.getSublistValue({ sublistId: 'item', fieldId: 'description', line: i }),
                    weight: fulfill.getSublistValue({ sublistId: 'item', fieldId: 'itemweight', line: i })
                });
            }
        }
        return details;
    }

    function getItemId(itemName) {
        var itemId = null;

        search.create({
            type: search.Type.ITEM,
            filters: [['name', 'is', itemName]],
            columns: ['internalid']
        }).run().each(function (res) {
            itemId = res.getValue('internalid');
            return false;
        });

        return itemId;
    }

    return {
        afterSubmit: afterSubmit
    };
});