/**
 * @NApiVersion 2.x
 * @NModuleScope Public
 */
define(['N/record', 'N/log'], function (record, log) {

    function sopicked_endoftheday(context) {
        try {
            if (!context || !Array.isArray(context) || context.length === 0) {
                log.debug('No data received', context);
                return;
            }
            const processed_socount = '';
            context.forEach(function (row) {
                try {
                    // Adjust this line depending on your payload structure
                    var soId = row.internalid || row.soId || row;

                    if (!soId) {
                        log.debug('Missing SO ID', row);
                        return;
                    }

                    var soRec = record.load({
                        type: record.Type.SALES_ORDER,
                        id: Number(soId),
                        isDynamic: false
                    });

                    soRec.save({
                        enableSourcing: false,
                        ignoreMandatoryFields: true
                    });
                    processed_socount++;
                    log.debug('Sales Order processed: ', soId);

                } catch (e) {
                    log.error('Error processing SO', {
                        soId: row,
                        error: e
                    });
                }

            });

            log.Audit('sopicked_endoftheday', processed_socount + ' records processed')

        } catch (error) {
            log.error('sopicked_endoftheday fatal error', error);
        }
    }

    return {
        sopicked_endoftheday: sopicked_endoftheday
    };
});
