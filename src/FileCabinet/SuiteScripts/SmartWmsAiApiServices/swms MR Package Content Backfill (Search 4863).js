/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/record', 'N/search', 'N/log'], (record, search, log) => {

   
    const getInputData = () => {
        return {
            type: 'search',
            id: '4863' 
        };
      
    };

    /**
     * The map function is called for each row in the search.
     * We pass the Internal ID of the record and the Transaction ID to the reduce stage.
     */
    const map = (context) => {
        const searchResult = JSON.parse(context.value);
        const packageId = searchResult.id;
        // Fetch the Transaction ID from the search column
       // const transactionId = searchResult.values.custrecord_hj_packagecontents_sublist.value;

        if (packageId) {
            context.write({
                key: packageId,
                value: packageId
            });
        }
    };

    /**
     * The reduce function processes each unique Package ID.
     * It loads the Fulfillment, gathers items, and populates the child lines.
     */
    const reduce = (context) => {
         const packageId = context.key;
        // const transactionId = context.values[0]; // The tranid passed from map

        // const packageId = 29952061;
       
        try {
            // Load the Package Record in dynamic mode
            const packageload = record.load({
                type: 'customrecordhj_tc_package_contents',
                id: packageId,
                isDynamic: true
            });

            // var isjyswms = packageload.getValue({ fieldId: 'custrecord_jyswms_createdfrom' });
            // if (!isjyswms) {
            //     log.debug('Skipping Record', `Package ID: ${packageId} not created from JYSWMS process.`);
            //     return;
            // }
           
            const savedId = packageload.save({
                ignoreMandatoryFields: true
            });

         
            log.audit('Success', `Updated Package ID: ${savedId} successfully.`);
            
        } catch (e) {
            log.error(`Error processing Package ID: ${packageId}`, e.toString());
        }
    };

    const summarize = (summary) => {
        summary.mapSummary.errors.iterator().each((key, error) => {
            log.error(`Map Error [${key}]`, error);
            return true;
        });
        summary.reduceSummary.errors.iterator().each((key, error) => {
            log.error(`Reduce Error [${key}]`, error);
            return true;
        });
        log.audit('Process Complete', 'Finished updating package records.');
    };

    return {
        getInputData: getInputData,
        map: map,
        reduce: reduce,
        summarize: summarize
    };
});