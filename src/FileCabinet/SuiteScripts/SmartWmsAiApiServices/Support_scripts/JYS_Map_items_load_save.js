/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 * @NModuleScope SameAccount
 */
define(['N/search', 'N/record', 'N/log', 'N/runtime'],
    (search, record, log, runtime) => {

        const getInputData = () => {
            return search.create({
                type: search.Type.INVENTORY_ITEM,
                filters: [
                    ['type', 'anyof', 'InvtPart'],
                    'AND',
                    ['isinactive', 'is', 'F'],
                    'AND',
                    ["modified", "within", "previousoneday"]
                ],
                columns: [
                    search.createColumn({ name: 'internalid' })
                ]
            });
        };

        const map = (context) => {
            const result = JSON.parse(context.value);
            const internalId = result.id;

            if (!internalId) return; // skip bad rows silently

            context.write({
                key: internalId,
                value: internalId
            });
        };

        const reduce = (context) => {
            const internalId = context.key;

            try {
                // ── Governance guard ──────────────────────────────────────
                // load + save costs ~20 units; guard at 50 to stay safe
                const remaining = runtime.getCurrentScript().getRemainingUsage();
                if (remaining < 50) {
                    log.error('GOVERNANCE SKIP',
                        `Item ${internalId} skipped — only ${remaining} units remaining`);
                    context.write({
                        key: internalId,
                        value: JSON.stringify({ success: false, error: 'governance_skip' })
                    });
                    return;
                }

                // ── Load ──────────────────────────────────────────────────
                const itemRecord = record.load({
                    type: record.Type.INVENTORY_ITEM,
                    id: internalId,
                    isDynamic: false  // standard mode — faster, lower governance
                });

                const savedId = itemRecord.save({
                    enableSourcing: false,
                    ignoreMandatoryFields: true
                });

                log.audit('REDUCE SUCCESS',
                    `Saved item ${savedId} | Remaining Usage: ${runtime.getCurrentScript().getRemainingUsage()}`);

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

        const summarize = (summary) => {
            let success = 0;
            let failed = 0;
            const errors = [];

            // ✅ Fixed: summary.output.length is unreliable — use iterator
            summary.output.iterator().each((key, value) => {
                const result = JSON.parse(value);
                result.success ? success++ : failed++;
                if (!result.success) errors.push(`Item ${key}: ${result.error}`);
                return true;
            });

            // Log any framework-level errors (timeouts, reschedules)
            summary.reduceSummary.errors.iterator().each((key, error) => {
                log.error('FRAMEWORK ERROR', `Key: ${key} | ${JSON.stringify(error)}`);
                return true;
            });

            log.audit('SUMMARIZE',
                `✅ Success: ${success} | ❌ Failed: ${failed} | Duration: ${summary.seconds}s`);

            if (errors.length > 0) {
                log.error('FAILED ITEMS', JSON.stringify(errors));
            }
        };

        return { getInputData, map, reduce, summarize };
    });