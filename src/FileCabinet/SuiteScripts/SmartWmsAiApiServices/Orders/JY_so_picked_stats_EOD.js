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

            // var processed_socount = 0;
            // payload.forEach(function (row) {
            //     try {
            //         // Adjust this line depending on your payload structure
            //         var soId = row.internalid || row.soId || row;

            //         if (!soId) {
            //             log.debug('Missing SO ID', row);
            //             return;
            //         }

            //         var soRec = record.load({
            //             type: record.Type.SALES_ORDER,
            //             id: Number(soId),
            //             isDynamic: false
            //         });

            //         soRec.save({
            //             enableSourcing: false,
            //             ignoreMandatoryFields: true
            //         });
            //         processed_socount++;
            //         // log.error('Sales Order processed: ', soId);

            //     } catch (e) {
            //         log.error('Error processing SO', e);
            //     }

            // });

         //   log.audit('sopicked_endoftheday: ' + new Date(), processed_socount + ' records processed')

        } catch (error) {
            log.error('sopicked_endoftheday fatal error', error);
            return { success: false, message: 'Error processing records', error: error };
        }
    }

    return {
        sopicked_endoftheday: sopicked_endoftheday
    };
});
