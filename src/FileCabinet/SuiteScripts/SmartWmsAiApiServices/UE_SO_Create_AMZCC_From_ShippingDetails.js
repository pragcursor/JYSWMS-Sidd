/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/record', 'N/search', 'N/log'], function (record, search, log) {

    function afterSubmit(context) {

        if (context.type !== context.UserEventType.CREATE &&
            context.type !== context.UserEventType.EDIT) {
            return;
        }

        try {
            var newRecord = context.newRecord;
            var salesOrderId = newRecord.id;

            // 1. Check checkbox
            var isCreateAmz = newRecord.getValue({
                fieldId: 'custbody_jy_prag_creat_amzc_frm_ns_lin'
            });

            if (!isCreateAmz) {
               // log.debug('Skipped', 'Checkbox not checked');
                return;
            }

            // 2. Get Shipping Header ID
            var shippingHeaderId = newRecord.getValue({
                fieldId: 'custbody_shipping_details_header'
            });

            if (!shippingHeaderId) {
              //  log.debug('Missing Header', 'custbody_shipping_details_header is empty');
                return;
            }

            // 3. Search Shipping Details Records
            var trackingObj = [];

            var shippingSearch = search.create({
                type: 'customrecord_shipping_details_record',
                filters: [
                    ['custrecord_ship_detail_hdr_link', 'anyof', shippingHeaderId]
                ],
                columns: [
                    search.createColumn({ name: 'custrecord_amzz_code_value' }),
                    search.createColumn({ name: 'custrecord_tracking_number' }),
                    search.createColumn({ name: 'custrecord_sales_order' }),
                    search.createColumn({ name: 'custrecord_shdl_item_upc_code' }),
                    search.createColumn({ name: 'custrecord_shipping_record_item' })
                ]
            });

            var resultCount = shippingSearch.runPaged().count;
           // log.debug('Shipping Search Count', resultCount);

            shippingSearch.run().each(function (result) {

                trackingObj.push({
                    recordId: result.id,
                    ssccCode: result.getValue('custrecord_amzz_code_value'),
                    tracking: result.getValue('custrecord_tracking_number'),
                    upcCode: result.getValue('custrecord_shdl_item_upc_code'),
                    itemName: result.getText('custrecord_shipping_record_item'), // TEXT
                    poNumber: '',
                    palletNumber: '',
                    bolTrackingNumber: ''
                });

                return true;
            });

            if (!trackingObj.length) {
               // log.debug('No Data', 'No shipping detail records found');
                return;
            }

            // 4. Load Sales Order
          //  log.debug("salesOrderId", salesOrderId);

            var salesOrderRec = record.load({
                type: record.Type.SALES_ORDER,
                id: salesOrderId,
                isDynamic: true
            });

            var sublistId = 'recmachcustrecord_sales_order_id';
            var packageBoxNumber = 0;

            trackingObj.forEach(function (line) {

                packageBoxNumber++;

                salesOrderRec.selectNewLine({ sublistId: sublistId });

                // SSCC handling
                var amzccCode = line.ssccCode;
                if (amzccCode) {
                    amzccCode = String(amzccCode).slice(2);
                }

                var fieldMap = {
                    custrecord_sales_order_id: salesOrderId,
                    custrecord_amzcc_code: amzccCode,
                    custrecord_itemid: line.itemName,
                    custrecord_ucc_code: line.upcCode,
                    custrecord_wms_bulkbatch_picking: 22306500,
                    custrecord_ponumber: line.poNumber,
                    custrecord_pallet_sscc_code: line.palletNumber,
                    custrecord_bol_tracking_number: line.bolTrackingNumber,
                    custrecord_trackingnumber: line.tracking
                };

                for (var fieldId in fieldMap) {
                    if (fieldMap[fieldId] !== null &&
                        fieldMap[fieldId] !== '' &&
                        fieldMap[fieldId] !== undefined) {
                        try {
                            salesOrderRec.setCurrentSublistValue({
                                sublistId: sublistId,
                                fieldId: fieldId,
                                value: fieldMap[fieldId]
                            });
                        } catch (e) {
                            log.debug('Skipped field', fieldId + ' | ' + e.message);
                        }
                    }
                }



                salesOrderRec.setValue({
                    fieldid: 'custbody_jy_prag_creat_amzc_frm_ns_lin',
                    value: false
                });

                log.audit('Amazon Record line added', fieldMap);
                salesOrderRec.commitLine({ sublistId: sublistId });
            });

            // 5. Save Sales Order
            salesOrderRec.save({
                enableSourcing: true,
                ignoreMandatoryFields: true
            });

        } catch (e) {
            log.error('afterSubmit Error', e);
        }
    }

    function beforeLoad(context) {
        if (context.type !== context.UserEventType.VIEW) {
            return;
        }

        var rec = context.newRecord;
        var form = context.form;

        form.clientScriptModulePath =
            'SuiteScripts/SmartWmsAiApiServices/JYSWMS_cli_sales_order.js';

        var isSuspended = rec.getValue({
            fieldId: 'custbody_jyswms_suspend_picking'
        });

        if (isSuspended) {
            form.addButton({
                id: 'custpage_resume_picking',
                label: 'Resume Picking',
                functionName: 'resumePicking'
            });
        } else {
            form.addButton({
                id: 'custpage_suspend_picking',
                label: 'Suspend Picking',
                functionName: 'suspendPicking'
            });
        }

        /* ===================== BUTTON STYLING ===================== */

        var styleField = form.addField({
            id: 'custpage_button_styles',
            type: 'inlinehtml',
            label: 'Button Styles'
        });

        styleField.defaultValue = `
            <style>
                /* Suspend Picking – Red */
                #custpage_suspend_picking {
                    background-color: #d9534f !important;
                    color: #ffffff !important;
                    border: 1px solid #c9302c !important;
                }

                #custpage_suspend_picking:hover {
                    background-color: #c9302c !important;
                }

                /* Resume Picking – Green */
                #custpage_resume_picking {
                    background-color: #5cb85c !important;
                    color: #ffffff !important;
                    border: 1px solid #4cae4c !important;
                }

                #custpage_resume_picking:hover {
                    background-color: #449d44 !important;
                }

                /* Disabled state */
                #custpage_suspend_picking:disabled,
                #custpage_resume_picking:disabled {
                    opacity: 0.6 !important;
                    cursor: not-allowed !important;
                }
            </style>
        `;
    }



    return {
        afterSubmit: afterSubmit,
        beforeLoad: beforeLoad,
    };
});