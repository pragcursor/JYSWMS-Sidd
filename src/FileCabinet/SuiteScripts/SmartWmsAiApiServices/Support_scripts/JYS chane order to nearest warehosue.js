/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 *
 * Bill Sender - Nearest Warehouse Location Update
 * ------------------------------------------------
 * Triggered on Sales Order CREATE and EDIT.
 *
 * LOGIC:
 *   1. Load the customer and check both flags:
 *        - custentity_bill_sender_customer     (bill sender customer flag)
 *        - custentity_jyswms_auto_loc_change   (auto location change flag)
 *      Both must be TRUE — if either is false/missing, exit immediately.
 *
 *   2. Check order-level guard flag:
 *        - custbody_bill_sender_order_location_up
 *      If already TRUE, exit — prevents re-triggering on subsequent edits.
 *
 *   3. Resolve the nearest warehouse from the shipping state (falling back
 *      to billing state) using the STATE → WH map from closest_WH.csv:
 *        L41 → Flemington  (NetSuite location ID: 9)
 *        L60 → Hardee      (NetSuite location ID: 15)
 *        L74 → Location 74 (NetSuite location ID: 23)
 *
 *   4. For each InvtPart line — check available inventory at the target
 *      (nearest) warehouse. Only move the line if inventory is available
 *      there. Lines with no stock at the target WH are left as-is.
 *      No fallback to 2nd/3rd warehouse — nearest or nothing.
 *
 *   5. If at least one line was moved, update the SO header location to
 *      match and set custbody_bill_sender_order_location_up = true so
 *      this never re-fires on future edits of the same order.
 *      If no lines were moved, the guard flag is still set so the script
 *      does not re-evaluate on every subsequent edit.
 *
 * RUNS ON: CREATE, EDIT
 * ALLOWED STATUSES: Pending Approval, Pending Fulfillment only.
 * DATE GATE: Only processes orders with trandate >= 2026-04-30 (today).
 *            Older/existing orders are ignored.
 * NO external API calls are made in this script.
 */
define([
    'N/record',
    'N/search',
    'N/log'
], (record, search, log) => {

    // =========================================================
    // CONSTANTS — NetSuite Location Internal IDs
    // =========================================================
    const LOC_FLEMINGTON = '9';    // L41 — East (NJ)
    const LOC_HARDEE     = '15';   // L60 — South (FL)
    const LOC_74         = '23';   // L74 — West

    // Warehouse code → NetSuite location ID
    const WH_CODE_TO_LOC = {
        L41: LOC_FLEMINGTON,
        L60: LOC_HARDEE,
        L74: LOC_74
    };

    // NetSuite location ID → warehouse label (for logging only)
    const LOC_LABEL = {
        [LOC_FLEMINGTON]: 'L41 - Flemington',
        [LOC_HARDEE]:     'L60 - Hardee',
        [LOC_74]:         'L74 - West'
    };

    // =========================================================
    // STATE → NEAREST WAREHOUSE
    // Source: closest_WH.csv (primary WH only — no fallback needed,
    // this flow does NOT check inventory)
    // =========================================================
    const STATE_TO_WH = {
        // L41 — Flemington (East)
        CT: 'L41', DE: 'L41', ME: 'L41', MD: 'L41', MA: 'L41',
        MI: 'L41', MN: 'L41', NH: 'L41', NJ: 'L41', NY: 'L41',
        OH: 'L41', PA: 'L41', RI: 'L41', VT: 'L41', VA: 'L41',
        WV: 'L41', WI: 'L41',

        // L60 — Hardee (South/Central)
        AL: 'L60', AR: 'L60', FL: 'L60', GA: 'L60', IL: 'L60',
        IN: 'L60', IA: 'L60', KS: 'L60', KY: 'L60', LA: 'L60',
        MS: 'L60', MO: 'L60', NE: 'L60', NC: 'L60', OK: 'L60',
        SC: 'L60', TN: 'L60', TX: 'L60',

        // L74 — West
        AZ: 'L74', CA: 'L74', CO: 'L74', ID: 'L74', MT: 'L74',
        NV: 'L74', NM: 'L74', ND: 'L74', OR: 'L74', SD: 'L74',
        UT: 'L74', WA: 'L74', WY: 'L74'
    };

    // Default when state is blank / not found
    const DEFAULT_WH = 'L60';

    // =========================================================
    // ALLOWED ORDER STATUSES
    // Only Pending Approval and Pending Fulfillment are processed.
    // =========================================================
    const ALLOWED_STATUSES = ['Pending Approval'];   //, 'Pending Fulfillment'

    // =========================================================
    // DATE GATE — only orders on or after April 30, 2026
    // Month is 0-indexed: 3 = April
    // =========================================================
    const GATE_DATE = new Date(2026, 4, 04);

    /**
     * Resolves the nearest warehouse NetSuite location ID for a given state.
     * @param  {string} stateAbbr  Two-letter state abbreviation (e.g. 'FL')
     * @return {string}            NetSuite location ID (e.g. '15')
     */
    const getNearestLocation = (stateAbbr) => {
        const upper  = (stateAbbr || '').toString().trim().toUpperCase();
        const whCode = STATE_TO_WH[upper] || DEFAULT_WH;
        return WH_CODE_TO_LOC[whCode];
    };

    // =========================================================
    // AFTER SUBMIT
    // Using afterSubmit so we can load + save the full record
    // cleanly, and it fires on both CREATE and EDIT including
    // Pending Approval status orders.
    // =========================================================
    const afterSubmit = (context) => {

        // Fire on CREATE and EDIT only
        if (![
            context.UserEventType.CREATE,
            context.UserEventType.EDIT
        ].includes(context.type)) {
            return;
        }

        try {

            const newRec = context.newRecord;
            const soId   = newRec.id;

            // newRec.type can return null on CREATE in some NetSuite versions,
            // so we hardcode the type and just validate the record ID exists.
            const soType = record.Type.SALES_ORDER;

            if (!soId) {
                log.error('BILL SENDER LOC | EXIT', 'Record ID is null — cannot proceed.');
                return;
            }

            // ---- Guard: skip if already processed ----
            const alreadyUpdated = newRec.getValue('custbody_bill_sender_order_location_up');
            if (alreadyUpdated) {
                log.debug('BILL SENDER LOC | EXIT', 'Order ' + soId + ' already processed — skipping.');
                return;
            }

            // ---- Guard: only Pending Approval and Pending Fulfillment ----
            const status = newRec.getValue('status');
            if (!ALLOWED_STATUSES.includes(status)) {
                log.debug('BILL SENDER LOC | EXIT', {
                    soId,
                    status,
                    reason: 'Status not in allowed list (Pending Approval / Pending Fulfillment).'
                });
                return;
            }

            // ---- Guard: only orders on or after the gate date (Apr 30 2026) ----
            const tranDateRaw = newRec.getValue('trandate');
            const tranDate    = tranDateRaw ? new Date(tranDateRaw) : null;

            if (!tranDate || tranDate < GATE_DATE) {
                log.debug('BILL SENDER LOC | EXIT', {
                    soId,
                    tranDate : tranDateRaw,
                    reason   : 'Order date is before gate date (2026-04-30) — skipping.'
                });
                return;
            }

            // ---- Resolve customer ----
            const customerId = newRec.getValue({ fieldId: 'entity' });
            if (!customerId) {
                log.debug('BILL SENDER LOC | EXIT', 'No customer on order ' + soId);
                return;
            }

            // ---- Check BOTH customer-level flags ----
            const customerFields = search.lookupFields({
                type: search.Type.CUSTOMER,
                id:   customerId,
                columns: [
                    'custentity_bill_sender_customer',
                    'custentity_jyswms_auto_loc_change'
                ]
            });

            const isBillSender = (
                customerFields.custentity_bill_sender_customer === true ||
                customerFields.custentity_bill_sender_customer === 'T'
            );

            const isAutoLocEnabled = (
                customerFields.custentity_jyswms_auto_loc_change === true ||
                customerFields.custentity_jyswms_auto_loc_change === 'T'
            );

            if (!isBillSender || !isAutoLocEnabled) {
                log.debug('BILL SENDER LOC | EXIT', {
                    soId,
                    isBillSender,
                    isAutoLocEnabled,
                    reason: 'One or both customer flags are false — no location update.'
                });
                return;
            }

            // ---- Resolve nearest warehouse from shipping state ----
            // Prefer ship-to state; fall back to bill-to state
            const shipState   = newRec.getValue('shipstate')  || '';
            const billState   = newRec.getValue('billstate')  || '';
            const resolvedState = shipState || billState;

            const targetLocId = getNearestLocation(resolvedState);

            log.error('BILL SENDER LOC | RESOLVED', {
                soId,
                resolvedState : resolvedState || '(blank — using default)',
                targetLocId,
                targetLabel   : LOC_LABEL[targetLocId]
            });

            // ---- Load SO ----
            const so = record.load({
                type:      soType,
                id:        soId,
                isDynamic: false
            });

            const lineCount = so.getLineCount({ sublistId: 'item' });
            if (!lineCount) return;

            // ---- Collect all InvtPart item IDs for inventory check ----
            const itemSet = new Set();

            for (let i = 0; i < lineCount; i++) {
                const itemType = so.getSublistValue({ sublistId: 'item', fieldId: 'itemtype', line: i });
                if (itemType !== 'InvtPart') continue;
                const itemId = String(so.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i }) || '');
                if (itemId) itemSet.add(itemId);
            }

            // ---- Build inventory map: { itemId: availableQty } at target location only ----
            // Only checks the single nearest WH — no fallback.
            // Uses OR on the exclude flag so bins with null field are not dropped.
            const inventoryAtTarget = {};  // { itemId: totalAvailable }

            if (itemSet.size) {
                search.create({
                    type: 'inventorybalance',
                    filters: [
                        ['item',     'anyof',       [...itemSet]],
                        'AND',
                        ['location', 'anyof',       [targetLocId]],
                        'AND',
                        ['available','greaterthan', '0'],
                        'AND',
                        [
                            ['binnumber.custrecord_jyswms_exclude_from_inventory', 'is',      'F'],
                            'OR',
                            ['binnumber.custrecord_jyswms_exclude_from_inventory', 'isempty', '']
                        ],
                        'AND',
                        ['binnumber.inactive',  'is',        'F'],
                        'AND',
                        ['binnumber.binnumber', 'isnotempty', '']
                    ],
                    columns: ['item', 'location', 'available']
                }).run().each(result => {
                    const itemId = String(result.getValue('item') || '');
                    const qty    = parseFloat(result.getValue('available')) || 0;
                    if (!itemId) return true;
                    inventoryAtTarget[itemId] = (inventoryAtTarget[itemId] || 0) + qty;
                    return true;
                });
            }

            log.error('BILL SENDER LOC | INVENTORY AT TARGET', {
                soId,
                targetLocId,
                targetLabel: LOC_LABEL[targetLocId],
                inventoryAtTarget
            });

            // ---- Per-line: only move if inventory exists at target WH ----
            const currentHeaderLoc = String(so.getValue('location') || '');
            let anyLineUpdated     = false;

            for (let i = 0; i < lineCount; i++) {

                const itemType = so.getSublistValue({ sublistId: 'item', fieldId: 'itemtype', line: i });
                const itemId   = String(so.getSublistValue({ sublistId: 'item', fieldId: 'item',     line: i }) || '');

                // For non-inventory lines (service, description, etc.) move freely
                // For InvtPart lines — only move if stock exists at target
                if (itemType === 'InvtPart') {
                    const availableAtTarget = inventoryAtTarget[itemId] || 0;
                    if (availableAtTarget <= 0) {
                        log.debug('BILL SENDER LOC | LINE ' + i + ' SKIPPED — no stock at target', {
                            itemId,
                            targetLocId,
                            targetLabel: LOC_LABEL[targetLocId]
                        });
                        continue;  // Leave this line at its current location
                    }
                }

                const currentLineLoc = String(
                    so.getSublistValue({ sublistId: 'item', fieldId: 'location', line: i }) || ''
                );

                // Skip if already at target
                if (currentLineLoc === targetLocId) continue;

                so.setSublistValue({ sublistId: 'item', fieldId: 'location',                    line: i, value: targetLocId });
                so.setSublistValue({ sublistId: 'item', fieldId: 'custcol_jyswms_line_location', line: i, value: targetLocId });

                log.debug('BILL SENDER LOC | LINE ' + i + ' UPDATED', {
                    itemId,
                    from: LOC_LABEL[currentLineLoc] || currentLineLoc,
                    to:   LOC_LABEL[targetLocId]
                });

                anyLineUpdated = true;
            }

            // Update header only if at least one line was moved
            if (anyLineUpdated) {
                so.setValue({ fieldId: 'location', value: targetLocId });
                log.error('BILL SENDER LOC | HEADER UPDATED', {
                    soId,
                    from: LOC_LABEL[currentHeaderLoc] || currentHeaderLoc,
                    to:   LOC_LABEL[targetLocId]
                });
            } else {
                log.error('BILL SENDER LOC | NO LINES MOVED — no stock at nearest WH', {
                    soId,
                    targetLocId,
                    targetLabel: LOC_LABEL[targetLocId]
                });
            }

            // ---- Always set guard flag so we never re-evaluate this order ----
            so.setValue({ fieldId: 'custbody_bill_sender_order_location_up', value: true });

            so.save({
                enableSourcing:        false,
                ignoreMandatoryFields: true
            });

            log.error('BILL SENDER LOC | COMPLETE', {
                soId,
                anyLineUpdated,
                targetLoc : LOC_LABEL[targetLocId],
                state     : resolvedState || '(default)'
            });

        } catch (e) {
            log.error('BILL SENDER LOC | ERROR', e);
        }
    };

    return { afterSubmit };

});