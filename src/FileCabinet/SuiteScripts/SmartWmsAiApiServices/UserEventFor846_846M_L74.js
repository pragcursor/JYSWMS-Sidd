/**
 *@NApiVersion 2.x
 *@NScriptType UserEventScript
 */
define(['N/search', 'N/log', 'N/record', 'N/runtime', 'N/https', 'N/email', 'N/format'],
	function (search, log, record, runtime, https, email, format) {
		function userEventScript846_CustomRecord(context) {
			try {
				var recordId = context.newRecord.id;
				//log.error("UserEvent====>recordId", recordId);

				/////////////////===================Date Logic==================================///////////////////
				var todayDate = new Date();
				var local = todayDate.getTime();
				var offset = todayDate.getTimezoneOffset() * (60 * 1000);
				var utc = local + offset;
				//var doffset = -4.00;
				var doffset = -5.00;
				var estValue = utc + (3600000 * doffset);
				var estNewDate = new Date(estValue);
				var estCurrentDate = estNewDate.getDate();
				var estCurrentHour = estNewDate.getHours();

				if (estCurrentHour < 12) {
					if (estCurrentHour <= 9) {
						estCurrentHour = "0" + estCurrentHour + ":" + "00" + " " + "AM";
					} else {
						estCurrentHour = estCurrentHour + ":" + "00" + " " + "AM";
					}
				} else {
					estCurrentHour = estCurrentHour + ":" + "00" + " " + "PM";
				}

				var custom856MObj = record.load({
					type: "customrecord_customer_item_special_id",
					id: recordId,
					isDynamic: true
				});
				var itemId = custom856MObj.getValue("custrecord_cis_item");
				var isinactive = custom856MObj.getValue("isinactive");
				log.error('isinactive', isinactive)
				if (isinactive)
					return true;

				//logic to update the KIT item inventory
				if (itemId) {
					var itemSearchObj = search.create({
						type: "item",
						filters:
							[
								["internalid", "anyof", itemId]
							],
						columns:
							[
								search.createColumn({ name: "type", label: "Type" })
							]
					});
					var searchResultCount = itemSearchObj.runPaged().count;
					log.debug("itemSearchObj result count", searchResultCount);
					itemSearchObj.run().each(function (result) {
						// .run().each has a limit of 4,000 results
						itemType = result.getValue({ name: "type", label: "Type" });
						return true;
					});

				}
				log.error("itemType", itemType);
				//logic to update custom records for KIT item
				if (itemType == 'Kit') {
					var kitLookUp = search.lookupFields({
						type: 'kititem',
						id: itemId,
						columns: ['custitem_l41_inventory_on_hand', 'custitem_l60_inventory_on_hand']
					});
					var l41Onhand = kitLookUp.custitem_l41_inventory_on_hand;
					var l60Onhand = kitLookUp.custitem_l60_inventory_on_hand;
					if (!l41Onhand)
						l41Onhand = 0;
					if (!l60Onhand)
						l60Onhand = 0;
					/* var custom856MObj = record.load({
						type: 'customrecord_customer_item_special_id',
						id: internalId,
						isDynamic: true
					}); */
					
					custom856MObj.setValue({
						fieldId: "custrecord_available_qty_l74",
						value: Math.round(l41Onhand)
					});
					custom856MObj.setValue({
						fieldId: "custrecord_available_qty_l60",
						value: Math.round(l60Onhand)
					});
					custom856MObj.setValue({
						fieldId: "custrecord_cis_feed_date_time",
						value: estCurrentHour
					});
					var rec856ID = custom856MObj.save({
						enableSourcing: true,
						ignoreMandatoryFields: true
					});
				} else {
					var backOrderQty = 0;
					var qtyValue = 0;
					var actual_date = "";
					var transitQty = "";
					var expected_date = "";

					//geeting Bin Avaiable Qty based on Item Input.
					var itemSearchObj = search.create({
						type: "item",
						filters:
							[
								[["binonhand.binnumber", "noneof", "7574", "7573", "4861", "4859", "7565", "4964", "4963", "1206", "503", "1408", "7586", "502", "16727", "16734", "16735", "17064", "17066","17373"], "AND", ["binonhand.location", "anyof", "23","24"]],
								"AND",
								["internalid", "anyof", itemId]
							],
						columns:
							[
								search.createColumn({
									name: "internalid",
									summary: "GROUP",
									label: "Internal ID"
								}),
								search.createColumn({
									name: "itemid",
									summary: "GROUP",
									sort: search.Sort.ASC,
									label: "Name"
								}),
								search.createColumn({
									name: "quantityavailable",
									join: "binOnHand",
									summary: "SUM",
									label: "Quantity Available"
								}),
								search.createColumn({
									name: "custitem_locationqtyintransitext2",
									summary: "MAX",
									label: "QUANTITY IN TRANSIT"
								}),
								search.createColumn({
									name: "custitem_arrival_date",
									summary: "MAX",
									label: "Container Arrival Date "
								}),
								search.createColumn({
									name: "custitem_quntity_bo_intransit",
									summary: "SUM",
									label: "Quantity(Back Order-Transit)"
								})
							]
					});
					var searchResultCount = itemSearchObj.runPaged().count;
					if (searchResultCount == 0) {
						qtyValue = 0;
					} else {
						itemSearchObj.run().each(function (result) {
							qtyValue = result.getValue({
								name: "quantityavailable",
								join: "binOnHand",
								summary: "SUM",
								label: "Quantity Available"
							})
							return true;
						});
					}
					//log.error({title: 'Avaiable Qty=======>',details: qtyValue});

					var fieldLookUp = search.lookupFields({
						type: "inventoryitem",
						id: itemId,
						columns: ['custitem_locationqtyintransitext2', 'custitem_l60_buffer', 'custitem_l41_buffer']
					});
					var transitQtyValue = fieldLookUp.custitem_locationqtyintransitext2;
					var l60Buffer = fieldLookUp.custitem_l60_buffer;
					var l41Buffer = fieldLookUp.custitem_l41_buffer;
					if (!l60Buffer)
						l60Buffer = 0
					if (!l41Buffer)
						l41Buffer = 0

					if (transitQtyValue.length > 0) {
						//log.error('fieldLookUp Not Empty ', transitQtyValue);
						//Getting Arrival Date and Transist qtyValue
						var inboundshipmentSearchObj = search.create({
							type: "inboundshipment",
							filters: [["item.internalid", "anyof", itemId], "AND", ["status", "anyof", "inTransit"], "AND", ["receivinglocation", "anyof", "23","24"]],
							columns: [search.createColumn({
								name: "actualdeliverydate",
								label: "Actual Delivery Date"
							}),
							search.createColumn({
								name: "quantityremaining",
								label: "Items - Quantity Remaining"
							}),
							search.createColumn({
								name: "expecteddeliverydate",
								label: "EXPECTED DELIVERY DATE"
							})]
						});
						var searchResultCount = inboundshipmentSearchObj.runPaged().count;
						if (searchResultCount > 0) {
							inboundshipmentSearchObj.run().each(function (result) {
								// .run().each has a limit of 4,000 results
								actual_date = result.getValue({
									name: "actualdeliverydate",
									label: "Actual Delivery Date"
								});
								transitQty = result.getValue({
									name: "quantityremaining",
									label: "Items - Quantity Remaining"
								});
								expected_date = result.getValue({
									name: "expecteddeliverydate",
									label: "EXPECTED DELIVERY DATE"
								});
								return false;
							});
						}
						//Getting Back Order Qty
						var salesorderSearchObj = search.create({
							type: "salesorder",
							filters:
								[
									/*    ["type", "anyof", "SalesOrd"], "AND", ["taxline", "is", "F"], "AND", ["shipping", "is", "F"], "AND", ["status", "anyof", "SalesOrd:D", "SalesOrd:E", "SalesOrd:A"],
									"AND", ["custbody_so_items", "doesnotcontain", "PARTS"], "AND", ["item.internalid", "is", itemId],  "AND" ["location", "anyof", "9"]*/
									["type", "anyof", "SalesOrd"],
									"AND",
									["mainline", "is", "F"],
									"AND",
									["taxline", "is", "F"],
									"AND",
									["shipping", "is", "F"],
									"AND",
									["status", "anyof", "SalesOrd:A", "SalesOrd:E", "SalesOrd:D"],
									"AND", ["custbody_so_items", "doesnotcontain", "PARTS"],
									"AND",
									["item", "anyof", itemId],
									"AND",
									["location", "anyof", "23","24"]
								],
							columns:
								[
									search.createColumn({
										name: "item",
										summary: "GROUP",
										label: "Item"
									}),
									search.createColumn({
										name: "formulanumeric",
										summary: "SUM",
										formula: "{quantity}-nvl({quantitycommitted},0)-nvl({quantityshiprecv},0)",
										label: "Formula (Numeric)"
									})
								]
						});
						var searchResultCount1 = salesorderSearchObj.runPaged().count;
						//log.error('searchResultCount1', searchResultCount1);
						if (searchResultCount1 > 0) {
							salesorderSearchObj.run().each(function (result) {
								backOrderQty = result.getValue({
									name: "formulanumeric",
									summary: "SUM",
									formula: "{quantity}-nvl({quantitycommitted},0)-nvl({quantityshiprecv},0)",
									label: "Formula (Numeric)"
								});
								//log.error('backOrderQty', backOrderQty);
								return true;
							});
						}
						//log.error('backOrder Qty', backOrderQty);
					} else {
						//log.error('fieldLookUp Empty ', transitQtyValue);
					}

					/*log.error({title: 'qtyValue=======>',details: qtyValue});
					log.error({title: 'backOrderQty=======>',details: backOrderQty});
					log.error({title: 'actual_date=======>',details: actual_date});
					log.error({title: 'expected_date=======>',details: expected_date});
					log.error({title: 'transitQty=======>',details: transitQty});*/

					try {
						var finalTransitQty = "";
						var finalBinOnhandQty = 0;
						if (Number(qtyValue) <= 2) {
							finalBinOnhandQty = 0;
						} else if (Number(qtyValue) >= 3 && Number(qtyValue) <= 15) {
							finalBinOnhandQty = Math.floor(Number(qtyValue) / 2);
						} else {
							finalBinOnhandQty = qtyValue;
						}
						var arrivalDate = '';
						if (transitQty) {
							if (actual_date.length > 0) {
								//log.error("Date actual_date:",actual_date);
								var stringToDate = format.parse({
									value: actual_date,
									type: format.Type.DATE
								});
								stringToDate.setDate(stringToDate.getDate() + 21);
								//arrivalDate=format.format({value:stringToDate,type: format.Type.DATE});
								arrivalDate = stringToDate;
								//New Date Logic===================================//
								var stringToDateValue = format.format({
									value: stringToDate,
									type: format.Type.DATE
								});
								var today_date = new Date();
								var arrivalDateNew = new Date(stringToDateValue);
								if (arrivalDateNew > today_date) {
									//log.error("Date greater");
								} else if (arrivalDateNew < today_date) {
									//log.error("Date less");
									var Difference_In_Time = today_date.getTime() - arrivalDateNew.getTime();
									var Difference_In_Days = Difference_In_Time / (1000 * 3600 * 24);
									var noOfDaysAdd = 0;
									if (Difference_In_Days < 0) {
										noOfDaysAdd = - (Difference_In_Days) + 7;
									} else if (Difference_In_Days > 0) {
										noOfDaysAdd = Difference_In_Days + 7;
									} else if (Difference_In_Days == 0) {
										noOfDaysAdd = 7;
									} else {
										noOfDaysAdd = 7;
									}
									var stringToDate = format.parse({
										value: arrivalDateNew,
										type: format.Type.DATE
									});
									stringToDate.setDate(stringToDate.getDate() + noOfDaysAdd);
									//arrivalDate=format.format({value:stringToDate,type: format.Type.DATE});
									arrivalDate = stringToDate;
									//log.error({title: 'noOfDaysAdd=======>',details: noOfDaysAdd});
								} else {
									//log.error("Date equal");
									var Difference_In_Time = today_date.getTime() - arrivalDateNew.getTime();
									var Difference_In_Days = Difference_In_Time / (1000 * 3600 * 24);
									var noOfDaysAdd = 0;
									if (Difference_In_Days < 0) {
										noOfDaysAdd = - (Difference_In_Days) + 7;
									} else if (Difference_In_Days > 0) {
										noOfDaysAdd = Difference_In_Days + 7;
									} else if (Difference_In_Days == 0) {
										noOfDaysAdd = 7;
									} else {
										noOfDaysAdd = 7;
									}
									var stringToDate = format.parse({
										value: arrivalDateNew,
										type: format.Type.DATE
									});
									stringToDate.setDate(stringToDate.getDate() + noOfDaysAdd);
									//arrivalDate=format.format({value:stringToDate,type: format.Type.DATE});
									arrivalDate = stringToDate;
									//log.error({title: 'noOfDaysAdd7777=======>',details: noOfDaysAdd});
								}
							}
							finalTransitQty = Number(transitQty) - Number(backOrderQty);
						}

						//Added new Logic
						if (finalBinOnhandQty > 0) {
							finalTransitQty = "";
							arrivalDate = "";
						}
						//checking Negative and Positive
						if (finalBinOnhandQty < 0) {
							finalBinOnhandQty = 0;
						}
						if (finalTransitQty <= 0) {
							//finalTransitQty=0;
							finalTransitQty = "";
						}
						//New Logic on Transit Quantity: adding 3 months
						if (Number(finalBinOnhandQty == 0) && Number(finalTransitQty == 0 || finalTransitQty == "")) {
							finalTransitQty = 5;
							var currentDate = new Date();
							//currentDate.setDate(currentDate.getDate()+90);
							currentDate.setDate(15);
							currentDate.setMonth(currentDate.getMonth() + 3);
							arrivalDate = currentDate;
							//arrivalDate=format.format({value:currentDate,type: format.Type.DATE});
						}

						var customerId = custom856MObj.getValue("custrecord_cis_customer");
						var customerzero = custom856MObj.getValue("custrecord_cis_customer_zero_l60");

						//var customerObj=record.load({type: "customer",id: customerId,isDynamic: true});
						//var showOnlyAvailableQty=customerObj.getValue("custentity_846_available_qty_only");

						var fieldLookUp = search.lookupFields({
							type: "customer",
							id: customerId,
							columns: ['custentity_846_available_qty_only']
						});
						var showOnlyAvailableQty = fieldLookUp.custentity_846_available_qty_only;

						//log.error({title: 'showOnlyAvailableQty=======>',details: showOnlyAvailableQty});

						if (showOnlyAvailableQty == false) {

							if (customerzero == false) {

								if ((arrivalDate == '' || arrivalDate == undefined) && (finalTransitQty > 0 && finalBinOnhandQty == 0)) {
									var currentDate = new Date();
									//currentDate.setDate(currentDate.getDate()+90);
									currentDate.setDate(15);
									currentDate.setMonth(currentDate.getMonth() + 3);
									arrivalDate = currentDate;

								}
								custom856MObj.setValue({
									fieldId: "custrecord_next_stock_date_l74",
									value: arrivalDate
								});
								finalBinOnhandQty = parseInt(finalBinOnhandQty) - l41Buffer
								if (finalBinOnhandQty < 0)
									finalBinOnhandQty = 0
								custom856MObj.setValue({
									fieldId: "custrecord_available_qty_l74",
									value: finalBinOnhandQty
								});
								custom856MObj.setValue({
									fieldId: "custrecord_transit_quantity_l74",
									value: finalTransitQty
								});
								
								//
							} else {
								//=============================================//
								finalTransitQty = 5;
								var currentDate = new Date();
								//currentDate.setDate(currentDate.getDate()+90);
								currentDate.setDate(15);
								currentDate.setMonth(currentDate.getMonth() + 3);
								arrivalDate = currentDate;

								custom856MObj.setValue({
									fieldId: "custrecord_next_stock_date_l74",
									value: arrivalDate
								});
								custom856MObj.setValue({
									fieldId: "custrecord_available_qty_l74",
									value: 0
								});
								custom856MObj.setValue({
									fieldId: "custrecord_transit_quantity_l74",
									value: finalTransitQty
								});
							}
						} else {
							if (customerzero) {

								if ((arrivalDate == '' || arrivalDate == undefined)) {

									var currentDate = new Date();
									//currentDate.setDate(currentDate.getDate()+90);
									currentDate.setDate(15);
									currentDate.setMonth(currentDate.getMonth() + 3);
									arrivalDate = currentDate;
									//  log.error("Empty", arrivalDate);

								}

								custom856MObj.setValue({
									fieldId: "custrecord_next_stock_date_l74",
									value: arrivalDate
								});
								custom856MObj.setValue({
									fieldId: "custrecord_available_qty_l74",
									value: 0
								});
								custom856MObj.setValue({
									fieldId: "custrecord_transit_quantity_l74",
									value: ""
								});

							} else {
								if ((arrivalDate == '' || arrivalDate == undefined) && (finalTransitQty > 0 && finalBinOnhandQty == 0)) {

									var currentDate = new Date();
									//currentDate.setDate(currentDate.getDate()+90);
									currentDate.setDate(15);
									currentDate.setMonth(currentDate.getMonth() + 3);
									arrivalDate = currentDate;
									//  log.error("Empty", arrivalDate);

								}

								custom856MObj.setValue({
									fieldId: "custrecord_next_stock_date_l74",
									value: arrivalDate
								});
								finalBinOnhandQty = parseInt(finalBinOnhandQty) - l41Buffer
								if (finalBinOnhandQty < 0)
									finalBinOnhandQty = 0
								custom856MObj.setValue({
									fieldId: "custrecord_available_qty_l74",
									value: finalBinOnhandQty
								});
								custom856MObj.setValue({
									fieldId: "custrecord_transit_quantity_l74",
									value: ""
								});
							}

						}
						
						//updating custrecord_transit_qty_l60 & custrecord_next_stock_date_l60 in item record(itemId)
						try{
							record.submitFields({
								type: 'inventoryitem',
								id: itemId,
								values: {
									'custitem_l41_qty_in_transit': Number(finalTransitQty),
									'custitem_l41_eta_date': arrivalDate
								},
								options: {
									enableSourcing: false,
									ignoreMandatoryFields: true
								}
							});
						}catch(e){
							log.error("error while updating item record",itemId+'---'+e);
						}
						
						

						custom856MObj.setValue({
							fieldId: "custrecord_cis_feed_date",
							value: estNewDate
						});
						custom856MObj.setValue({
							fieldId: "custrecord_cis_feed_date_time",
							value: estCurrentHour
						});
						var retunId = custom856MObj.save({
							enableSourcing: true,
							ignoreMandatoryFields: true
						});

						//log.error("Record Updated::======>>", retunId);
					} catch (e) {
						log.error("Record Error::======>>", e);
					}
					finally { }
					//=============================================Ends==================================================//
				}
			} catch (e) {
				log.error("UserEvent====>1st Level Error:", e);
			}
			finally { }
		}
		return {
			afterSubmit: userEventScript846_CustomRecord
		};
	});