/**
 * @NApiVersion 2.x
 * @NModuleScope Public
 */
define(['N/record', 'N/log', 'N/task'], function (record, log, task) {

    function sopicked_endoftheday(context) {
        try {
            var payload = context.data; // Assuming the payload is passed directly as the context
            // log.error('Received payload', payload);
            if (!payload || payload.length === 0) {
                log.error('No records to process', 'Payload is empty or invalid');
                return { success: false, message: 'No records to process' };
            }

            var mrTask = task.create({
                taskType: task.TaskType.MAP_REDUCE,
                scriptId: 'customscript_jysmreodloadsubmitjs',
                params: {
                    custscript_so_ids: JSON.stringify(payload)
                }
            });

            var taskId = mrTask.submit();

            log.audit('MR Task Submitted', taskId);
            return {
                success: true,
                message: 'Map/Reduce script Triggered'
            }
        } catch (error) {
            log.error('sopicked_endoftheday fatal error', error);
            return { success: false, message: 'Error processing records', error: error };
        }
    }

    return {
        sopicked_endoftheday: sopicked_endoftheday
    };
});
