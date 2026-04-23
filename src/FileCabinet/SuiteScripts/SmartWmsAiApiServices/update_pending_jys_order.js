/**
 * @NApiVersion 2.1
 * @NScriptType ScheduledScript
 */
define(['N/search', 'N/record', 'N/log'], function (search, record, log) {

    function execute(context) {
        try {
            var sales_order_ids = [];

            /*------------------- DROPSHIP SALES ORDERS ------------------*/
            const dropship_salesorderSearchObj = search.create({
                type: "salesorder",
                filters:
                    [
                        ["type", "anyof", "SalesOrd"],
                        "AND",
                        ["status", "anyof", "SalesOrd:F", "SalesOrd:E"],
                        "AND",
                        ["mainline", "is", "T"],
                        "AND",
                        ["shipmethod", "anyof", "4"],
                        "AND",
                        ["name", "anyof", "1807", "476"],
                        "AND",
                        ["shipdate", "onorafter", "3/1/2026"],
                        "AND",
                        ["location", "anyof", "15", "9"]
                    ],
                columns:
                    [
                        search.createColumn({ name: "internalid", label: "Internal ID" })
                    ]
            });
            const dropship_searchResultCount = dropship_salesorderSearchObj.runPaged().count;
            log.error("dropship_salesorderSearchObj result count", dropship_searchResultCount);
            dropship_salesorderSearchObj.run().each(function (result) {
                var dropship_id = result.getValue({ name: 'internalid' });
                sales_order_ids.push(dropship_id);
                return true;
            });

            /*------------------- LTL SALES ORDERS ------------------*/
            const Ltl_salesorderSearchObj = search.create({
                type: "salesorder",
                filters:
                    [
                        ["type", "anyof", "SalesOrd"],
                        "AND",
                        ["mainline", "is", "T"],
                        "AND",
                        ["location", "anyof", "15", "9"],
                        "AND",
                        ["shipdate", "onorafter", "3/1/2026"],
                        "AND",
                        ["custbody_bol_tracking_number", "isnotempty", ""],
                        "AND",
                        ["shipmethod", "anyof", "57733"],
                        "AND",
                        ["status", "anyof", "SalesOrd:D", "SalesOrd:E", "SalesOrd:F"],
                        "AND",
                        ["customer.custentity_jyswms_suspended", "is", "F"],
                        "AND",
                        [[["name", "anyof", "476", "1807"], "AND", ["custbody_send_to_jyswms_amazon_1yz7n", "is", "T"]], "OR", [["customer.custentity_wms_ltl_customer", "is", "T"]]]
                    ],
                columns:
                    [
                        search.createColumn({ name: "internalid", label: "Internal ID" })
                    ]
            });
            const Ltl_searchResultCount = Ltl_salesorderSearchObj.runPaged().count;
            log.error("Ltl_salesorderSearchObj result count", Ltl_searchResultCount);
            Ltl_salesorderSearchObj.run().each(function (result) {
                var Ltl_id = result.getValue({ name: 'internalid' });
                sales_order_ids.push(Ltl_id);
                return true;
            });
            log.error('Total Sales Orders to Process', sales_order_ids.length);

            
            /*------------------- PROCESSING SALES ORDERS ------------------*/
            for (var i = 0; i < sales_order_ids.length; i++) {
                try {
                    var soId = sales_order_ids[i];
            
                    log.error('Processing SO', soId);
            
                    var soRec = record.load({
                        type: record.Type.SALES_ORDER,
                        id: soId,
                        isDynamic: false
                    });
            
                    var savedId = soRec.save({
                        enableSourcing: true,
                        ignoreMandatoryFields: true
                    });
            
                    log.error('Saved SO', savedId);
            
                } catch (err) {
                    log.error('Error processing SO ID ' + sales_order_ids[i], err);
                }
            }
           

        } catch (e) {
            log.error('Scheduled Script Error', e);
        }
    }

    return {
        execute: execute
    };
});