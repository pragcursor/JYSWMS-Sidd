/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 */
define(['N/record', 'N/log'],
  (record, log) => {

    const onRequest = (context) => {
      context.response.setHeader({
        name: 'Content-Type',
        value: 'application/json'
      });

      let result = { success: false, message: '', updatedId: null };

      try {
        const params = context.request.parameters;

        const recId = params.record_id;

        // ❌ OLD GENERIC APPROACH (COMMENTED OUT)
        // const recType = params.record_type;
        // if (!recId || !recType) {
        //   throw new Error('Missing URL params: record_id and record_type');
        // }

        if (!recId) {
          throw new Error('Missing URL param: record_id');
        }

        // ❌ OLD LOAD (COMMENTED OUT)
        // const rec = record.load({
        //   type: recType,
        //   id: parseInt(recId, 10)
        // });

        // ✅ NEW: LOAD SALES ORDER ONLY
        const rec = record.load({
          type: record.Type.SALES_ORDER,
          id: parseInt(recId, 10)
        });

        // Optional: field updates go here
        // rec.setValue({ fieldId: 'memo', value: 'Updated via Suitelet' });

        const updatedRecId = rec.save({
          enableSourcing: true,
          ignoreMandatoryFields: true
        });

        log.audit('Success', `Sales Order ID: ${recId} -> ${updatedRecId}`);

        result = {
          success: true,
          message: `Updated Sales Order ${recId}`,
          updatedId: updatedRecId
        };

      } catch (e) {
        log.error('Error', e.message);
        result.message = e.message;
      }

      context.response.write(JSON.stringify(result));
    };

    return { onRequest };
  });