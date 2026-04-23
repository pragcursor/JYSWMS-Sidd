/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */

define(['N/record', 'N/log', 'N/search'], (record, log, search) => {

    const beforeLoad = (context) => {

        // Show only in VIEW mode
        if (context.type !== context.UserEventType.VIEW) return;

        const form = context.form;
        const rec = context.newRecord;

        const recId = rec.id;

        // 🔗 Your saved search URL (dynamic)
        const url = "https://4809897.app.netsuite.com/app/common/search/savedsearchresults.nl?rectype=940&searchid=5088&searchtype=Custom&CUSTRECORD_IBHSN_INBOUND_RECORD_REFF=" + recId;

        // ➕ Add Button
        form.addButton({
            id: 'custpage_view_hts',
            label: 'Additional HTS Records',
            functionName: "window.open('" + url + "', '_blank')"
        });

    };


    function afterSubmit(context) {
        try {
            const newRecord = context.newRecord;
            const recId = newRecord.id;
            const lineCount = newRecord.getLineCount({ sublistId: 'items' });

            let items = [];


            for (let i = 0; i < lineCount; i++) {

                let location = newRecord.getSublistValue({
                    sublistId: 'items',
                    fieldId: 'receivinglocation',
                    line: i
                });

                // Skiping L60 & L41 locations(only want 23 & 24)
                if (location != 23 && location != 24) {
                    continue;
                }

                let lineuniquekey = newRecord.getSublistValue({
                    sublistId: 'items',
                    fieldId: 'id',
                    line: i
                });

                let itemObj = {
                    itemId: newRecord.getSublistValue({
                        sublistId: 'items',
                        fieldId: 'itemid',
                        line: i
                    }),
                    quantity: newRecord.getSublistValue({
                        sublistId: 'items',
                        fieldId: 'quantityexpected',
                        line: i
                    }),
                    location: newRecord.getSublistValue({
                        sublistId: 'items',
                        fieldId: 'receivinglocation',
                        line: i
                    }),
                    purchaseorder: newRecord.getSublistValue({
                        sublistId: 'items',
                        fieldId: 'purchaseorder',
                        line: i
                    }),
                    qtyReceived: newRecord.getSublistValue({
                        sublistId: 'items',
                        fieldId: 'quantityreceived',
                        line: i
                    }),

                    lineuniquekey: String(lineuniquekey)
                };

                items.push(itemObj);
                // lineKeys.push(lineuniquekey);
            }
            log.error('items', JSON.stringify(items));

            items.forEach(item => {

                var existing = getExistingRecords(item.lineuniquekey);

                let rec;

                if (existing.length > 0) {
                    // ✅ UPDATE
                    rec = record.load({
                        type: 'customrecord_jyswms_inbound_hsn_record',
                        id: existing[0],
                        isDynamic: true
                    });

                    log.error('Updating Record', existing[0]);

                } else {
                    // ✅ CREATE
                    rec = record.create({
                        type: 'customrecord_jyswms_inbound_hsn_record',
                        isDynamic: true
                    });

                    rec.setValue({
                        fieldId: 'custrecord_ib_line_unique_id',
                        value: item.lineuniquekey
                    });

                    log.error('Creating New Record');
                }

                // 🔁 COMMON FIELD SET (for both create + update)
                rec.setValue({
                    fieldId: 'custrecord_ibhsn_item',
                    value: item.itemId
                });

                rec.setValue({
                    fieldId: 'custrecord_ibhsn_quantity',
                    value: item.quantity
                });

                rec.setValue({
                    fieldId: 'custrecord_jys_quantity_received', 
                    value: item.qtyReceived 
                });

                rec.setValue({
                    fieldId: 'custrecord_ibhsn_inbound_record_reff',
                    value: recId
                });

                rec.setValue({
                    fieldId: 'custrecord_ibhsn_purchase_order',
                    value: item.purchaseorder
                });

                rec.setValue({
                    fieldId: 'custrecord_ibhsn_location',
                    value: item.location
                });

                const id = rec.save();

                log.error('Saved Record', id);
            });

            // items.forEach(item => {
            //     var _existing = getExistingRecords(item.lineuniquekey);
            //     // log.error('existing', JSON.stringify(_existing));
            //     if (_existing.length > 0) {
            //         log.error('Skipping existing', item.lineuniquekey);
            //         return;
            //     }
            //     // Skip if exists
            //     // return
            //     //  Create new custom record
            //     let rec = record.create({
            //         type: 'customrecord_jyswms_inbound_hsn_record',
            //         isDynamic: true
            //     });

            //     rec.setValue({
            //         fieldId: 'custrecord_ib_line_unique_id',
            //         value: item.lineuniquekey
            //     });

            //     rec.setValue({
            //         fieldId: 'custrecord_ibhsn_item',
            //         value: item.itemId
            //     });

            //     rec.setValue({
            //         fieldId: 'custrecord_ibhsn_quantity',
            //         value: item.quantity
            //     });

            //     rec.setValue({
            //         fieldId: 'custrecord_ibhsn_inbound_record_reff',
            //         value: recId
            //     });
            //     rec.setValue({
            //         fieldId: 'custrecord_ibhsn_purchase_order',
            //         value: item.purchaseorder
            //     });

            //     rec.setValue({ fieldId: 'custrecord_ibhsn_location', value: item.location });

            //     const newId = rec.save();

            //     log.error('Created Record', newId);
            // });

        } catch (error) {
            log.error({
                title: 'Error in afterSubmit',
                details: error
            });
        }
    }

    // function getExistingRecords(lineKeys) {
    //     log.error('lineKeys', lineKeys);
    //     if (!lineKeys || lineKeys.length === 0) return [];

    //     const cust_inbound_search = search.create({
    //         type: "customrecord_jyswms_inbound_hsn_record",
    //         filters:
    //             [
    //                 ["custrecord_ib_line_unique_id", "is", String(lineKeys)]
    //             ],
    //         columns:
    //             [
    //                 search.createColumn({ name: "name", label: "ID" }),
    //                 search.createColumn({ name: "custrecord_ib_line_unique_id", label: "IB Line Unique Id" }),

    //             ]
    //     });
    //     var results = [];
    //     cust_inbound_search.run().each(function (result) {
    //         results.push(result.getValue({ name: "custrecord_ib_line_unique_id" }));
    //         return true;
    //     });
    //     log.error('results', results);


    //     return results;
    // }

    function getExistingRecords(lineKey) {

        const cust_inbound_search = search.create({
            type: "customrecord_jyswms_inbound_hsn_record",
            filters: [
                ["custrecord_ib_line_unique_id", "is", String(lineKey)]
            ],
            columns: [
                search.createColumn({ name: "internalid" }) 
            ]
        });

        var results = [];

        cust_inbound_search.run().each(function (result) {
            results.push(result.getValue({ name: "internalid" }));
            return true;
        });

        return results;
    }

    return { beforeLoad, afterSubmit };
});