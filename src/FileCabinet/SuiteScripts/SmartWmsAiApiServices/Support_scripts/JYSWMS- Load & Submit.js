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
        // Reads directly from URL params (no JSON body required)
        const params = context.request.parameters;
        const recId = params.record_id;
        const recType = params.record_type;

        if (!recId || !recType) {
          throw new Error('Missing URL params: record_id and record_type');
        }

        const rec = record.load({
          type: recType,
          id: parseInt(recId, 10)
        });

        // Add field changes here if needed
        // rec.setValue({ fieldId: 'custbody_example', value: 'Updated' });

        const updatedRecId = rec.save({
          enableSourcing: true,
          ignoreMandatoryFields: true
        });

        log.audit('Success', `Type: ${recType}, ID: ${recId} -> ${updatedRecId}`);

        result = {
          success: true,
          message: `Updated ${recType} ${recId}`,
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
