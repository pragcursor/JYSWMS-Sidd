/**
 * @NApiVersion 2.x
 * @NScriptType Suitelet
 */
define(['N/search', 'N/record', 'N/log'],
    function (search, record, log) {

        function onRequest(context) {

            try {

                var existingMap = {};

                var headerSearch = search.create({
                    type: 'customrecord_order_fulfillment_details',
                    filters: [
                        ["custrecord_jyswms_rel_item_ful", "anyof", "@NONE@"],
                        "AND",
                        ["custrecord_jyswms_order_ship_via", "anyof", 57733],
                        "AND",
                        ["isinactive", "is", "F"],
                        "AND",
                       ["custrecord_jyswms_sales_order_id", "anyof", 62395446]
                        // "AND",
                        // ["datecreated", "onorafter", "2/6/2026"]
                    ],
                    columns: ['internalid', 'custrecord_jyswms_sales_order_id']
                });

                headerSearch.run().each(function (result) {

                    var soId = result.getValue('custrecord_jyswms_sales_order_id');
                    var headerId = result.getValue('internalid');

                    if (!existingMap[soId]) {
                        existingMap[soId] = [];
                    }

                    existingMap[soId].push(headerId);

                    return true;
                });

                log.error('Existing SO Map', JSON.stringify(existingMap));

                // ==========================================
                // 2️⃣ Process Each SO
                // ==========================================
                for (var salesorderId in existingMap) {

                    var headerIds = existingMap[salesorderId];

                    if (!headerIds || headerIds.length === 0) {
                        continue;
                    }

                    var primaryHeaderId = headerIds[0]; // use first header

                    // =====================================================
                    // 🔹 Merge customrecord_jyswms_sales_order_item
                    // =====================================================
                    var itemSearch = search.create({
                        type: "customrecord_jyswms_sales_order_item",
                        filters: [
                            ["custrecord_jyswms_sales_order.internalid", "anyof", salesorderId],
                            "AND",
                            ["custrecord_jyswms_sales_order.mainline", "is", "T"],
                            "AND",
                            ["isinactive", "is", "F"],
                            "AND",
                            ["custrecord_sales_order_header", "noneof", primaryHeaderId]
                        ],
                        columns: ["internalid"]
                    });

                    itemSearch.run().each(function (result) {

                        var itemRecId = result.getValue('internalid');

                        record.submitFields({
                            type: "customrecord_jyswms_sales_order_item",
                            id: itemRecId,
                            values: {
                                custrecord_sales_order_header: primaryHeaderId
                            }
                        });

                        log.error('Merged Item Record', itemRecId);
                        return true;
                    });



                    // =====================================================
                    // 🔹 Merge customrecord_jyswms_sales_order_track
                    // =====================================================
                    var trackSearch = search.create({
                        type: "customrecord_jyswms_sales_order_track",
                        filters: [
                            ["custrecord_jyswms_track_so_id.internalid", "anyof", salesorderId],
                            "AND",
                            ["custrecord_jyswms_track_so_id.mainline", "is", "T"],
                            "AND",
                            ["isinactive", "is", "F"],
                            "AND",
                            ["custrecord_jyswms_so_header", "noneof", primaryHeaderId]
                        ],
                        columns: ["internalid"]
                    });

                    trackSearch.run().each(function (result) {

                        var trackRecId = result.getValue('internalid');

                        record.submitFields({
                            type: "customrecord_jyswms_sales_order_track",
                            id: trackRecId,
                            values: {
                                custrecord_jyswms_so_header: primaryHeaderId
                            }
                        });

                        log.error('Merged Track Record', trackRecId);
                        return true;
                    });

                    var primaryheaderlength = headerIds.length;
                    log.error('Merged primaryheaderlength Record', primaryheaderlength);
                    log.error('headerIds -------', headerIds);

                    for (var i = 1; i < primaryheaderlength; i++) {
                        record.submitFields({
                            type: "customrecord_order_fulfillment_details",
                            id: headerIds[i],
                            values: {
                                custrecord_jyswms_sales_order_id: null,
                                inactive: true
                            }
                        });
                    }

                  if(primaryHeaderId){
                      record.submitFields({
                            type: "customrecord_order_fulfillment_details",
                            id: primaryHeaderId,
                            values: {
                                custrecord_jyswms_approved: true,
                                custrecord_jyswms_total_pick_qty: '344'
                            }
                        });
                  }

                }
                log.audit('Merge Process Completed: headerIds: ' + headerIds.join(', '), 'All records have been processed and merged successfully.');
                context.response.write("Merge Process Completed Successfully.");

            } catch (e) {
                log.error('Error in Suitelet', e);
                context.response.write("Error: " + e.message);
            }
        }

        return {
            onRequest: onRequest
        };

    });