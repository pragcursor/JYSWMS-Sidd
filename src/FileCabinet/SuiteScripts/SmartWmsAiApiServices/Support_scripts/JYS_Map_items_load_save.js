/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 * @NModuleScope SameAccount
 */
define(['N/search', 'N/record', 'N/log', 'N/runtime'],
    (search, record, log, runtime) => {

        /**
         * GET INPUT DATA
         * Runs once. Returns up to 16,000 items via paged search.
         * Time estimate: ~10–30 seconds
         */
        const getInputData = () => {
            return search.create({
                type: search.Type.INVENTORY_ITEM,
                filters: [
                    ['type', 'anyof', 'InvtPart'],
                    'AND',
                    ['isinactive', 'is', 'F'],
                    'AND',
                    ['modified', 'within', 'previousoneweek']
                ],
                columns: [
                    search.createColumn({ name: 'internalid' })
                ]
            });
            // Returning the search object directly lets the M/R framework
            // handle pagination — no 4,000-row .run().each() limit here.
        };

        /**
         * MAP
         * Called once per search result row.
         * Key = internalId, value = internalId (we only need the ID to load the record).
         * NetSuite runs map stages in parallel across multiple queues.
         * Time estimate: ~5–15 minutes for 16,000 items
         */
        const map = (context) => {
            const result = JSON.parse(context.value);
            const internalId = result.id; // M/R passes the record's internal ID as result.id

            log.debug('MAP', `Processing internalId: ${internalId}`);
            context.write({
                key: internalId,
                value: internalId
            });
        };

        /**
         * REDUCE
         * Called once per unique key (= once per item).
         * Loads the full record and saves it — this triggers all beforeLoad /
         * beforeSubmit / afterSubmit user events you have on Inventory Item.
         * Time estimate: ~40–90 minutes for 16,000 items
         *   (each load+save ~200–400 ms on average, 4 queues × parallel)
         */
        const reduce = (context) => {
            const internalId = context.key;

            try {
                // Governance check — each load+save costs ~20 units; limit is 10,000/queue
                const remainingUnits = runtime.getCurrentScript().getRemainingUsage();
                log.debug('GOVERNANCE', `Remaining units before processing ${internalId}: ${remainingUnits}`);

                // Load record — triggers beforeLoad user event
                const itemRecord = record.load({
                    type: record.Type.INVENTORY_ITEM,
                    id: internalId,
                    isDynamic: false   // Use standard mode for M/R (more stable, lower governance)
                });

                // Optional: make a field touch so user events fire even with no changes
                // Some UEs check for actual field changes — touch 'lastmodifieddate' equivalent
                // by setting a harmless field. Skip if your UE fires unconditionally.
                // itemRecord.setValue({ fieldId: 'custitem_mr_trigger', value: true });

                // Save record — triggers beforeSubmit + afterSubmit user events
                const savedId = itemRecord.save({
                    enableSourcing: true,
                    ignoreMandatoryFields: false
                });

                log.audit('REDUCE SUCCESS', `Saved item ${savedId}`);

                context.write({
                    key: internalId,
                    value: JSON.stringify({ success: true, savedId })
                });

            } catch (e) {
                log.error('REDUCE ERROR', `Item ${internalId} | ${e.message}`);

                context.write({
                    key: internalId,
                    value: JSON.stringify({ success: false, error: e.message })
                });
            }
        };

        /**
         * SUMMARIZE
         * Runs once after all reduce stages finish.
         * Logs success / failure counts.
         * Time estimate: < 1 minute
         */
        const summarize = (summary) => {
          log.audit('SUMMARIZE', `Total keys processed: ${summary.output.length}`);
        };

        return { getInputData, map, reduce, summarize };
    });