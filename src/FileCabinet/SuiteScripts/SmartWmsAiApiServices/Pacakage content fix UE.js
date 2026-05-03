/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 *
 * FIX SUMMARY:
 * 1. custrecordhj_pkg_desc stores "itemInternalId/qty" (e.g. "12345/1") — NOT an item name.
 *    Old code tried to strip "(qty)" and do a name-based search → always returned null.
 *    Fix: Parse the internal ID directly from the slash-delimited string,
 *         AND also read custrecord_jyswms_item_id as a fallback (set by orderUtils.js).
 *
 * 2. shouldPopulate was read from the re-loaded record (pkgRec), which may already
 *    have been reset to false by the time afterSubmit fires.
 *    Fix: Read it from context.newRecord first (snapshot at save time), fall back
 *    to the loaded record only if context.newRecord returns null/undefined.
 *
 * 3. getItemDetails used 'itemweight' field on the IF sublist — this is unreliable.
 *    Fix: Added 'custcol_item_weight' as a secondary fallback, and default to 0.
 *
 * 4. qty-fix loop ran even when shouldPopulate=true (just added a line), causing
 *    the new line's qty to be overwritten before totalWeight was calculated.
 *    Fix: Only run the qty-fix block when shouldPopulate is false (already the intent,
 *    but now guarded properly after the line-add block completes).
 */
define(['N/record', 'N/log', 'N/search'], (record, log, search) => {

    const afterSubmit = (context) => {

        if (context.type !== context.UserEventType.CREATE &&
            context.type !== context.UserEventType.EDIT) {
            return;
        }

        try {
            const recId = context.newRecord.id;

            // ─── FIX #2: Read flag from context.newRecord (snapshot at save time) ──────
            // context.newRecord reflects the values the user actually submitted.
            // Loading the record again risks reading a value already reset by another
            // script or by the save pipeline itself.
            let shouldPopulate = context.newRecord.getValue({
                fieldId: 'custrecord_jyswms_item_not_populated'
            });

            log.debug('shouldPopulate (from context.newRecord)', shouldPopulate);

            // Load the record for mutation (we need isDynamic to edit sublists)
            const pkgRec = record.load({
                type: 'customrecordhj_tc_package_contents',
                id: recId,
                isDynamic: true
            });

            // Fallback: if context gave us null/undefined, read from the loaded record
            if (shouldPopulate === null || shouldPopulate === undefined) {
                shouldPopulate = pkgRec.getValue({
                    fieldId: 'custrecord_jyswms_item_not_populated'
                });
                log.debug('shouldPopulate (fallback from pkgRec)', shouldPopulate);
            }

            const sublistId = 'recmachcustrecordhj_tc_pkgcont_lineitemparent';

            // =====================================================
            // STEP 1: ADD LINE ONLY IF FLAG = TRUE
            // =====================================================

            if (shouldPopulate) {

                const tranId = pkgRec.getValue({
                    fieldId: 'custrecord_hj_packagecontents_sublist'
                });

                log.debug('tranId', tranId);

                // ─── FIX #1: Read item ID — two sources ───────────────────────────────
                //
                // Source A (preferred): custrecord_jyswms_item_id
                //   orderUtils.js sets this directly to the item's internal ID.
                //
                // Source B (fallback): custrecordhj_pkg_desc
                //   orderUtils.js stores this as  itemInternalId + "/1"  e.g. "12345/1"
                //   The old code stripped "(qty)" and searched by name — WRONG.
                //   Correct parse: split on "/" and take the first segment.
                //
                let itemId = pkgRec.getValue({ fieldId: 'custrecord_jyswms_item_id' });

                if (!itemId) {
                    const pkgDescRaw = pkgRec.getValue({ fieldId: 'custrecordhj_pkg_desc' });
                    log.debug('pkgDescRaw (for fallback parse)', pkgDescRaw);

                    if (pkgDescRaw) {
                        // Format written by orderUtils.js:  "<itemInternalId>/1"
                        // e.g. "12345/1"  →  itemId = "12345"
                        const parts = String(pkgDescRaw).split('/');
                        const candidate = parts[0].trim();

                        // Validate it is numeric (internal IDs always are)
                        if (/^\d+$/.test(candidate)) {
                            itemId = candidate;
                            log.debug('itemId parsed from custrecordhj_pkg_desc', itemId);
                        } else {
                            // The field might still contain an old-style item name — do a
                            // name-based lookup as a last resort.
                            log.debug('pkgDesc candidate is not numeric, trying name lookup', candidate);
                            itemId = getItemIdByName(candidate);
                            log.debug('itemId from name lookup', itemId);
                        }
                    }
                } else {
                    log.debug('itemId from custrecord_jyswms_item_id', itemId);
                }

                if (!tranId || !itemId) {
                    log.error('Cannot add line', 'tranId: ' + tranId + ' | itemId: ' + itemId);
                } else {

                    // Check if the item already exists in the sublist
                    const lineCount = pkgRec.getLineCount({ sublistId });
                    let exists = false;

                    for (let i = 0; i < lineCount; i++) {
                        const existingItem = pkgRec.getSublistValue({
                            sublistId,
                            fieldId: 'custrecordhj_tc_pkgcontents_lineitemitem',
                            line: i
                        });

                        if (String(existingItem) === String(itemId)) {
                            exists = true;
                            break;
                        }
                    }

                    if (!exists) {

                        const itemDetails = getItemDetails(tranId, itemId);
                       // log.debug('itemDetails from IF', JSON.stringify(itemDetails));

                        if (itemDetails && itemDetails.length > 0) {

                            const item = itemDetails[0];

                            pkgRec.selectNewLine({ sublistId });

                            pkgRec.setCurrentSublistValue({
                                sublistId,
                                fieldId: 'custrecordhj_tc_pkgcontents_lineitemitem',
                                value: itemId
                            });

                            pkgRec.setCurrentSublistValue({
                                sublistId,
                                fieldId: 'custrecordhj_tc_pkgcontents_lineitemqty',
                                value: 1
                            });

                            pkgRec.setCurrentSublistValue({
                                sublistId,
                                fieldId: 'custrecordhj_tc_pkgcontentslineitemdesc',
                                value: item.description || ''
                            });
                            if (item.weight) {
                                pkgRec.setCurrentSublistValue({
                                    sublistId,
                                    fieldId: 'custrecordhj_tc_pkgcontents_lineitemwt',
                                    value: parseFloat(item.weight)
                                });
                            }
                            pkgRec.commitLine({ sublistId });

                            log.debug('Line Added', 'itemId: ' + itemId);

                        } else {
                            // Item not found on the fulfillment — log clearly and still mark flag false
                            log.error('getItemDetails returned empty', 'tranId: ' + tranId + ' | itemId: ' + itemId);
                        }

                    } else {
                        log.debug('Line already exists', 'itemId: ' + itemId + ' already in sublist');
                    }

                    // Always mark the flag false — whether we added the line or it already existed
                    pkgRec.setValue({
                        fieldId: 'custrecord_jyswms_item_not_populated',
                        value: false
                    });
                }

            } // end if (shouldPopulate)

            // =====================================================
            // STEP 2: ALWAYS CALCULATE HEADER WEIGHT
            // =====================================================

            const updatedLineCount = pkgRec.getLineCount({ sublistId });
            let totalWeight = 0;

            for (let i = 0; i < updatedLineCount; i++) {

                let qty = parseFloat(pkgRec.getSublistValue({
                    sublistId,
                    fieldId: 'custrecordhj_tc_pkgcontents_lineitemqty',
                    line: i
                })) || 0;

                var weight = parseFloat(pkgRec.getSublistValue({
                    sublistId,
                    fieldId: 'custrecordhj_tc_pkgcontents_lineitemwt',
                    line: i
                })) || 0;

                const itemCode = pkgRec.getSublistValue({
                    sublistId,
                    fieldId: 'custrecordhj_tc_pkgcontents_lineitemitem',
                    line: i
                });
               // log.debug('itemCode', itemCode);

                if (itemCode == '57740') {
                    log.debug('Weight Override', 'Line ' + i + ' has item code "PARTS" → overriding weight to 1');
                    weight = 1;
                }
                // ─── FIX #4: Only run qty-fix for EDIT flows (not shouldPopulate=true) ─
                // When shouldPopulate=true we just added the line with the correct qty.
                // The fix below is for lines that already existed with qty=0.
                if (!shouldPopulate) {
                    if (!qty || qty === 0) {

                        pkgRec.selectLine({ sublistId, line: i });

                        pkgRec.setCurrentSublistValue({
                            sublistId,
                            fieldId: 'custrecordhj_tc_pkgcontents_lineitemqty',
                            value: 1
                        });

                        pkgRec.setCurrentSublistValue({
                            sublistId,
                            fieldId: 'custrecordhj_tc_pkgcontents_lineitemqtyd',
                            value: 1
                        });

                        pkgRec.commitLine({ sublistId });

                        qty = 1;
                        log.debug('Qty Fixed', 'Line ' + i + ' was 0 → set to 1');
                    }
                }

                log.debug('Line ' + i, 'Qty: ' + qty + ' | Weight: ' + weight);
                totalWeight += (qty * weight);
            }

            pkgRec.setValue({
                fieldId: 'custrecordhj_tc_packagecontentslbs',
                value: totalWeight
            });

            // =====================================================
            // STEP 3: SAVE
            // =====================================================

            pkgRec.save({
                enableSourcing: false,
                ignoreMandatoryFields: true
            });

            log.audit('Done', 'Package ' + recId + ' | Total Weight: ' + totalWeight);

        } catch (e) {
            log.error('afterSubmit Error', e.message + ' | ' + JSON.stringify(e));
        }
    };

    // ================= HELPERS =================

    /**
     * Load the Item Fulfillment and find all lines matching itemId.
     * FIX #3: Weight fallback chain — 'itemweight' → 'custcol_item_weight' → 0
     */
    const getItemDetails = (tranId, itemId) => {

        const details = [];

        try {
            const fulfill = record.load({
                type: record.Type.ITEM_FULFILLMENT,
                id: tranId
            });

            const count = fulfill.getLineCount({ sublistId: 'item' });

            for (let i = 0; i < count; i++) {

                const lineItem = fulfill.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'item',
                    line: i
                });

                if (String(lineItem) === String(itemId)) {

                    // Weight: try standard field first, then custom column, then 0
                    let weight = parseFloat(fulfill.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'itemweight',
                        line: i
                    }));

                    if (!weight) {
                        weight = parseFloat(fulfill.getSublistValue({
                            sublistId: 'item',
                            fieldId: 'custcol_item_weight',
                            line: i
                        }));
                    }

                    details.push({
                        itemId: lineItem,
                        quantity: fulfill.getSublistValue({ sublistId: 'item', fieldId: 'quantity', line: i }),
                        description: fulfill.getSublistValue({ sublistId: 'item', fieldId: 'description', line: i }),
                        weight: weight
                    });
                }
            }
        } catch (e) {
            log.error('getItemDetails Error', 'tranId: ' + tranId + ' | ' + e.message);
        }

        return details;
    };

    /**
     * Last-resort: look up item internal ID by display name.
     * Only reached when custrecordhj_pkg_desc is in old name format (not "id/qty").
     */
    const getItemIdByName = (itemName) => {

        if (!itemName) return null;

        let itemId = null;

        try {
            search.create({
                type: search.Type.ITEM,
                filters: [['name', 'is', itemName]],
                columns: ['internalid']
            }).run().each((res) => {
                itemId = res.getValue('internalid');
                return false;
            });
        } catch (e) {
            log.error('getItemIdByName Error', e.message);
        }

        return itemId;
    };

    return { afterSubmit };
});