/**
 * @NApiVersion 2.0
 * @NScriptType UserEventScript
 */
define(['N/record', 'N/search', 'N/format'],
    function(record, search, format) {
        function afterSubmit(context) {
            try {
              
				var oldRecord = context.oldRecord;
                var internalId = context.newRecord.id;
                var recType = context.newRecord.type
                var l41LocQty = 0,
                    l60locQty = 0;

                var itemRec = record.load({
                    type: recType,
                    id: internalId
                })
              
				var manufacturer_tariff = itemRec.getValue({
                    fieldId: 'manufacturertariff'
                })

                var days_Sales_Goal = itemRec.getValue({
                    fieldId: 'custitem_30d_sales_goal'
                })

				days_Sales_Goal = Number(days_Sales_Goal) * 4

                var itemSearchObj = search.create({
                    type: "item",
                    filters: [
                        ["binonhand.binnumber", "noneof", "17066", "17064", "7573", "4859", "7586", "7565", "1206", "1408", "16692", "16734", "2633", "4672", "16691", "16727", "16733", "16735", "4964", "4963", "1410", "1408", "16727","17373"],//"7575", "7577", "7578", "7579", "7580", "7581", "7582", "7583", "7584", "7585"
                        "AND",
                        ["binonhand.location", "anyof", "9"],
                        "AND",
                        ["internalid", "anyof", internalId]
                    ],
                    columns: [
                        search.createColumn({
                            name: "internalid",
                            summary: "GROUP",
                            label: "Internal ID"
                        }),

                        search.createColumn({
                            name: "itemid",
                            summary: "GROUP",
                            sort: search.Sort.ASC,
                            label: "Name"
                        }),

                        search.createColumn({
                            name: "quantityavailable",
                            join: "binOnHand",
                            summary: "SUM",
                            label: "Quantity Available"
                        })
                    ]
                });

                var searchResultCount = itemSearchObj.runPaged().count;
                log.debug("itemSearchObj result count", searchResultCount);
                itemSearchObj.run().each(function(result) {
                    // .run().each has a limit of 4,000 results
                    l41LocQty = result.getValue({
                        name: "quantityavailable",
                        join: "binOnHand",
                        summary: "SUM"
                    })

                    return true;
                });


                var itemSearchObj = search.create({
                    type: "item",
                    filters: [
                        ["binonhand.binnumber", "noneof", "17066", "17064", "7573", "4859", "7586", "7565", "1206", "1408", "16692", "16734", "2633", "4672", "16691", "16727", "16733", "16735", "4964", "4963",  "1410", "1408", "16727","17373"],//"7575", "7577", "7578", "7579", "7580", "7581", "7582", "7583", "7584", "7585",
                        "AND",
                        ["binonhand.location", "anyof", "15"],
                        "AND",
                        ["internalid", "anyof", internalId]
                    ],

                    columns: [

                        search.createColumn({
                            name: "internalid",
                            summary: "GROUP",
                            label: "Internal ID"
                        }),

                        search.createColumn({
                            name: "itemid",
                            summary: "GROUP",
                            sort: search.Sort.ASC,
                            label: "Name"
                        }),

                        search.createColumn({
                            name: "quantityavailable",
                            join: "binOnHand",
                            summary: "SUM",
                            label: "Quantity Available"
                        })

                    ]
                });
                var searchResultCount = itemSearchObj.runPaged().count;
              //  log.debug("itemSearchObj result count", searchResultCount);
                itemSearchObj.run().each(function(result) {
                    // .run().each has a limit of 4,000 results
              
					l60locQty = result.getValue({
                        name: "quantityavailable",
                        join: "binOnHand",
                        summary: "SUM"
                    })

                    return true;
                });
	
              
					record.submitFields({
                        type: 'inventoryitem',
                        id: internalId,
                        values: {

                            custitem_jy_avail_qty_l41: l41LocQty,
                            custitem_jy_available_quantity_l60: l60locQty
                        },
                        options: {
                            enableSourcing: false,
                            ignoreMandatoryFields: true
                        }
                    });
					
					
				//saved searches to update sold qty in last 7 days, 30 days & 6 Months & Life Time
        

            } catch (e) {
                log.error('Error', e.message)
            }
        }
        return {
            afterSubmit: afterSubmit
        }

    });