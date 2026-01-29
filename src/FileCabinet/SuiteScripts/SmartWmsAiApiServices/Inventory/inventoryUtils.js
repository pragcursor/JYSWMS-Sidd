/**
 * @NApiVersion 2.x
 * @NModuleScope Public
 */
define(['N/record', 'N/search', 'N/log','N/runtime'], function (record, search, log, runtime) {

    function getCounts(context, pageSize) {
		
		return {
			success : true
		}
    }

         function recentUpdatedItems() {
          try {
              var itemIds = [];
              //  Search for items in transactions modified in the last 30 minutes
              var transactionSearchObj = search.create({
                  type: "transaction",
                  filters: [
                      ["formulatext: CASE WHEN {lastmodifieddate} >= (CURRENT_TIMESTAMP - (30/1440)) THEN 1 ELSE 0 END", "is", "1"],
                      "AND",
                      ["posting", "is", "T"],
                      "AND",
                      ["lastmodifieddate", "after", "yesterday"],
                      "AND",
                      ["mainline", "is", "F"]
                  ],
                  columns: [
                      search.createColumn({
                          name: "item",
                          summary: "GROUP",
                          label: "Item"
                      })
                  ]
              });

              transactionSearchObj.run().each(function(result) {
                  var itemId = result.getValue({
                      name: "item",
                      summary: "GROUP"
                  });
                  if (itemId && !itemIds.includes(itemId.toString())) {
                      itemIds.push(itemId.toString());
                      log.debug("Last Modified Item (30 mins)", "Item ID: " + itemId);
                  }
                  return true; // keep iterating
              });

              log.debug("All Last Modified Item IDs (30 mins)", JSON.stringify(itemIds));
              log.error("Total Unique Item IDs Count", itemIds.length);

              if (itemIds.length > 0) {
                  return itemIds;
              }
          } catch (error) {
              log.error("error meassage", e.message);
          }
      }
  function getInventory(context, pageSize, startIndex) {
    try {
        var ScriptStartTime = new Date().getTime();
     //   log.error('Script Started', 'Start Time: ' + ScriptStartTime / 1000 + ' seconds');

        var scriptObj = runtime.getCurrentScript();
        var inventorySearchId = scriptObj.getParameter({ name: 'custscript_wms_ai_inventory_detail' });
      //  log.error('inventory Parameter', inventorySearchId);
        var Data = {};
        var binId = context.binId|| "";
      var existingBinSequenceMap = BinSequenceSearch();
   // log.error("existingBinSequenceMap",JSON.stringify(existingBinSequenceMap));
      
    
        var itemIds = context.itemIds || "";

       //   ---don't remove this section in commnets---
       //    log.audit("itemIds from request", itemIds);
       //    if (!itemIds) {
       //     itemIds = recentUpdatedItems() || "";
       //     log.audit("itemIds", itemIds.length);
       //      }
       //   log.audit("final itemIds", itemIds);

        var inventorySearch = search.load({
            id: inventorySearchId,
            type: search.Type.ITEM
        });
var filters = inventorySearch.filters || [];
     // log.error("filters",JSON.stringify(filters));
           if (itemIds) {
                try {
                    filters.push(search.createFilter({
                        name: 'internalid',
                        operator: search.Operator.ANYOF,
                        values: itemIds
                    }));
                 //   log.audit("item ids", itemIds);
                } catch (e) {
                  log.error("error pushing item filters");
                    var response = e.message + " - " + itemIds;
               //   log.error("response",JSON.stringify(response));
                }
            }
        if (binId) {
 
                try {
 
                    filters.push(search.createFilter({
 
                        name: 'binnumber',
                        join: "binOnHand",
                        operator: search.Operator.ANYOF,
                        values: binId
 
                    }));
 
 
                } catch (e) {
 
                  log.error("error pushing item filters");
 
                    var response = e.message + " - " + binId;
 
 
                }
 
            }
 

       // Apply updated filters back to the search
         inventorySearch.filters = filters;
      
        var totalCount = inventorySearch.runPaged().count;
        var totalPages = Math.ceil(totalCount / pageSize);

        //log.error("total Count", totalCount);

        var searchResult = inventorySearch.run();
        var searchRange = searchResult.getRange({ start: startIndex, end: startIndex + pageSize });

        searchRange.forEach(function (result) {
           // log.error("item search result", JSON.stringify(result));

            var internalId = result.getValue({ name: "internalid" });
            var locationId = result.getValue({ name: "location", join: "binOnHand" });
            var availableQty = parseFloat(result.getValue({ name: "quantityavailable", join: "binOnHand" })) || 0;

            if (!internalId || !locationId) return;

            if (!Data[internalId]) {
                Data[internalId] = {};
            }

            if (!Data[internalId][locationId]) {
                Data[internalId][locationId] = {
                    total_available: 0,
                    itemDetails: []
                };
            }

            var itemData = {};
            result.columns.forEach(function (column) {
                var columnName = toSnakeCase(column.label || column.name);
                if (columnName == 'location') {
                    itemData['loc_internalid'] = result.getValue(column) || " ";
                    itemData['location'] = result.getText(column) || " ";
                } 
              else if (columnName == 'bin_number') {
                   var binId = result.getValue(column);
                    itemData['bin_internalid'] = result.getValue(column) || " ";
                    itemData['bin_number'] = result.getText(column) || " ";
                 var binData = existingBinSequenceMap[binId];
                    itemData['bin_index']  = binData.bin_index || " ";
                    itemData['bin_orientation']  = binData.bin_orientation || "";
                    itemData['wh']  = binData.wh || "";
                    itemData['room']  = binData.room || "";
                    itemData['aisle_no']  = binData.aisle_no || "";
                    itemData['bin']  = binData.bin || "";  
                }   
                 else {
                    itemData[columnName] = result.getText(column) || result.getValue(column);
                }
            });

            Data[internalId][locationId].itemDetails.push(itemData);
            Data[internalId][locationId].total_available += availableQty;
        });

        return {
            status: 200,
            message: 'Data retrieved successfully',
            summary: {
                total_records: totalCount,
                total_pages: totalPages,
                records_per_page: pageSize,
                current_page: Math.floor(startIndex / pageSize) + 1,
                pagination_info: {
                    start_index: startIndex,
                    end_index: startIndex + pageSize - 1,
                    has_next_page: (startIndex + pageSize) < totalCount,
                    has_previous_page: startIndex > 0
                }
            },
            data: Data
        };

    } catch (e) {
        log.error("error message", e.message);

        return {
            status: 500,
            message: e.message
        };
    }
}


  
 function BinSequenceSearch() {

    try {
     
        var existingBinSequenceMap = {};

        var BinSearch = search.create({
            type: 'bin',
            filters: [
            ],
            columns: [
      search.createColumn({name: "custrecord_jyswms_sequence_number",label: "sequence number"  }),
      search.createColumn({name: "internalid", label: "internal id"}),
      search.createColumn({name: "custrecord_bin_position", label: "Bin Orentation"}),
      search.createColumn({name: "custrecord_bin_wh", label: "WH"}),
      search.createColumn({name: "custrecord_bin_room", label: "Room"}),
      search.createColumn({name: "custrecord_aisle_no", label: "Aisle No"}),
      search.createColumn({name: "custrecord_bin_bin", label: "Bin"})
              ]
        });

        var pagedData = BinSearch.runPaged({ pageSize: 1000 });

pagedData.pageRanges.forEach(function (pageRange) {
    var page = pagedData.fetch({ index: pageRange.index });
    page.data.forEach(function (result) {
        var binId = result.getValue({ name: 'internalid' });
        var sequenceNumber = parseFloat(result.getValue({
            name: "custrecord_jyswms_sequence_number"
        })) || 0;

        existingBinSequenceMap[binId] = {
          "bin_index": sequenceNumber,
          "bin_orientation": result.getValue({ name: "custrecord_bin_position" }),
          "wh": result.getValue({ name: "custrecord_bin_wh" }), 
          "room": result.getValue({ name: "custrecord_bin_room" }),
          "aisle_no": result.getValue({ name: "custrecord_aisle_no" }), 
          "bin": result.getValue({ name: "custrecord_bin_bin" })
        };
    });
});
        return existingBinSequenceMap;

    } catch (e) {
        log.error("Error in BinSearch", e.toString());
        return {};
    }
}

  
    function toSnakeCase(str) {
        return str
            .trim()
            .replace(/[^a-zA-Z0-9 ]/g, '')
            .replace(/\s+/g, '_')
            .toLowerCase();
    }

    return {
        getCounts: getCounts,
        getInventory: getInventory
    };
});
