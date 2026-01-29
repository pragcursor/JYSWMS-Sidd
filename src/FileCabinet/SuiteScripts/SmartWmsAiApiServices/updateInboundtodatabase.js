/**

*@NApiVersion 2.1

*@NScriptType UserEventScript

*/

define(['N/record', 'N/runtime','N/search', 'N/https', 'N/log','./Orders/orderUtils'], function (record,runtime,search, https, log,orderUtils) {
 
    function afterSubmit(context) {

        try {

          if (context.type == context.UserEventType.CREATE) {
            return;
        }

            var inboundShipmentID = context.newRecord.id;
            log.error("recordId ",inboundShipmentID);
           var recType = context.newRecord.type;
           log.error("recType ",recType);
          
        
            log.error("Internal IDs", JSON.stringify(inboundShipmentID));
			var params = {
                inboundShipmentID:inboundShipmentID,
                pageSize: 1000
            };
           
            var startIndex = 0;
            var pageSize = 1000;
			var response= orderUtils.getInboundRecords(params,pageSize,startIndex);
          
			var status = sendData(response);
 
            log.error("status", JSON.stringify(status));
 
        } catch (e) {

            log.error('Error collecting item IDs', e.toString());

        }

    }

  function generateToken() {
       try {
        var webhookUrl = 'https://api.jyswms.com/user/login'; // prod Url
		var token = "";

        // Convert object to x-www-form-urlencoded string
        var formData = { userid: "jyswms_integration_user", password: "s9u[7zC720%pZr"};
        log.error("formData ", formData );

        var headerObj = {
            'Content-Type': 'application/json'
        };

        try {
            var response = https.post({
                url: webhookUrl,
                body: JSON.stringify(formData),
                headers: headerObj
            });

        log.error("response",JSON.stringify(response));

            log.error('Response Body', response.body);
          var responseBody = response.body;
          var parsedBody = JSON.parse(responseBody); // Convert JSON string to object
			log.error("parsedBody",parsedBody);
          token =parsedBody.access_token;
			log.error("token",token);

        } catch (e) {
            log.error('Error while sending request', e.message);
        }

        
	
         return token;
		
        } 
       catch (e) {
            log.error('Error in hash generation', e);
            return {
                success: false,
                error: e.message
            };
        }
		}

   function sendData(body) {
	
	  try {
          const webhookUrl = 'https://api.jyswms.com/update-inbound-shipment-id';
        // custsecret_wms_ai_portal_credientals
          const requestBody = body ;
        var token = generateToken();
       
        log.error("token",token);
         log.error("result", JSON.stringify(body));
     const headers = {
      'Authorization': `Bearer ${token}`, 
       'Content-Type': 'application/json'
      }; 
		
          const response = https.post({
              url: webhookUrl,
              body: JSON.stringify(requestBody),
              headers: headers
          });
      log.error("response",JSON.stringify(response));
          return {
              success: true,
              response: response
          };
			
      } 
    catch (e) {
          log.error('Error sendData', e);
          return {
              success: false,
              error: e.message
          };
      }
   }

   function toSnakeCase(str) {
        return str
            .trim()
            .replace(/[^a-zA-Z0-9 ]/g, '')
            .replace(/\s+/g, '_')
            .toLowerCase();
    }
  // Helper function: Converts labels to camelCase
function toCamelCase(label) {
    return label
        .replace(/[^a-zA-Z0-9 ]/g, '')
        .replace(/\s+(.)/g, (_, group1) => group1.toUpperCase())
        .replace(/^./, str => str.toLowerCase());
}

	
 
    return {

        afterSubmit: afterSubmit

    };

});




 