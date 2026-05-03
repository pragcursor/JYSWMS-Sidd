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
 *   2. Check order-level guard flags:
 *        - custbody_bill_sender_order_location_up  (this script's own flag)
 *        - custbody_jyswms_loc_updated             (Script 2's flag)
 *      If either is TRUE, exit — prevents re-triggering on subsequent edits.
 *
 *   3. Resolve the nearest warehouse from the shipping state (falling back
 *      to billing state) using the STATE → WH map from closest_WH.csv:
 *        L41 → Flemington  (NetSuite location ID: 9)
 *        L60 → Hardee      (NetSuite location ID: 15)
 *        L74 → Location 74 (NetSuite location ID: 23)
 *
 *   4. Update the SO header location AND every line location to the
 *      nearest warehouse — NO qty check, NO inventory check.
 *
 *   5. Set custbody_bill_sender_order_location_up = true so this never
 *      re-fires on future edits of the same order.
 *
 *   6. After saving, call /update-dropship-lines with the SO ID
 *      and all item IDs — mirrors the Script 2 API pattern.
 *      Fires always (even if all lines were already at the correct location).
 *
 * RUNS ON: CREATE, EDIT
 * ALLOWED STATUSES: Pending Approval, Pending Fulfillment only.
 * DATE GATE: Only processes orders with trandate >= 2026-04-30.
 *            Older/existing orders are ignored.
 */
define([
    'N/record',
    'N/search',
    'N/log',
    'N/https',
    './Orders/orderUtils',
    './JYSWMS_generateToken_API'
], (record, search, log, https, autoLocUtil, tokenModule) => {

    // =========================================================
    // CONSTANTS — NetSuite Location Internal IDs
    // =========================================================
    const LOC_FLEMINGTON = '9';    // L41 — East (NJ)
    const LOC_HARDEE     = '15';   // L60 — South (FL)
    const LOC_74         = '23';   // L74 — West

    const WH_CODE_TO_LOC = {
        L41: LOC_FLEMINGTON,
        L60: LOC_HARDEE,
        L74: LOC_74
    };

    const LOC_LABEL = {
        [LOC_FLEMINGTON]: 'L41 - Flemington',
        [LOC_HARDEE]:     'L60 - Hardee',
        [LOC_74]:         'L74 - West'
    };

    // =========================================================
    // STATE → NEAREST WAREHOUSE
    // Source: closest_WH.csv (primary WH only)
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
    // =========================================================
    const ALLOWED_STATUSES = ['Pending Approval'];  //, 'Pending Fulfillment'

    // =========================================================
    // DATE GATE — only orders on or after May 1, 2026
    // =========================================================
   const GATE_DATE = new Date(2026, 4, 1);

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
    // sendData — mirrors Script 2's sendData() exactly.
    // Calls /update-dropship-lines with Bearer token auth.
    // payload shape: { salesOrderHeaderId, salesOrderItemId[] }
    // =========================================================
    const sendData = (payload) => {

        log.error('BILL SENDER LOC | SEND DATA - START', JSON.stringify(payload));

        const token = tokenModule.generateToken();

        if (!token) {
            log.error('BILL SENDER LOC | SEND DATA - Token Failed', 'Token generation failed');
            return;
        }

        try {
            const response = https.post({
                url: 'https://api.jyswms.com/update-dropship-lines?closed=false',
                headers: {
                    'Authorization': 'Bearer ' + token,
                    'Content-Type':  'application/json'
                },
                body: JSON.stringify(payload)
            });

            log.error('BILL SENDER LOC | SEND DATA - RESPONSE', {
                code: response.code,
                body: response.body
            });

            return {
                success:  response.code === 200,
                response: response.body || ''
            };

        } catch (e) {
            log.error('BILL SENDER LOC | SEND DATA - ERROR', e);
            return { success: false, error: e.message };
        }
    };

    // =========================================================
    // AFTER SUBMIT
    // =========================================================
    const afterSubmit = (context) => {

        if (![
            context.UserEventType.CREATE,
            context.UserEventType.EDIT
        ].includes(context.type)) {
            return;
        }

        try {

            const newRec = context.newRecord;
            const soId   = newRec.id;
            const soType = record.Type.SALES_ORDER;

            if (!soId) {
                log.error('BILL SENDER LOC | EXIT', 'Record ID is null — cannot proceed.');
                return;
            }

            // ---- Guard: skip if already processed by either script ----
            const alreadyUpdated    = newRec.getValue('custbody_bill_sender_order_location_up');
            const locAlreadyUpdated = newRec.getValue('custbody_jyswms_loc_updated');

            if (alreadyUpdated || locAlreadyUpdated) {
                log.debug('BILL SENDER LOC | EXIT', {
                    soId,
                    alreadyUpdated,
                    locAlreadyUpdated,
                    reason: 'Order already processed by Bill Sender or Auto Location script — skipping.'
                });
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
                    tranDate: tranDateRaw,
                    reason: 'Order date is before gate date (2026-04-30) — skipping.'
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
                type:    search.Type.CUSTOMER,
                id:      customerId,
                columns: [
                    'custentity_bill_sender_customer',
                    'custentity_jyswms_auto_loc_change',
                    'custentity_jyswms_auto_routing'
                ]
            });

            const isBillSender = (
                customerFields.custentity_bill_sender_customer   === true ||
                customerFields.custentity_bill_sender_customer   === 'T'
            );

            const isAutoLocEnabled = (
                customerFields.custentity_jyswms_auto_loc_change === true ||
                customerFields.custentity_jyswms_auto_loc_change === 'T'
            );

            const isAutoRoutingEnabled = (
                customerFields.custentity_jyswms_auto_routing    === true ||
                customerFields.custentity_jyswms_auto_routing    === 'T'
            );

            if (!isAutoLocEnabled || (!isBillSender && !isAutoRoutingEnabled)) {
                log.debug('BILL SENDER LOC | EXIT', {
                    soId,
                    isBillSender,
                    isAutoLocEnabled,
                    isAutoRoutingEnabled,
                    reason: 'Auto location flag is false, or neither bill sender nor auto routing flag is true — no location update.'
                });
                return;
            }

            // ---- Resolve nearest warehouse from shipping state ----
            const shipState     = newRec.getValue('shipstate') || '';
            const billState     = newRec.getValue('billstate') || '';
            const resolvedState = shipState || billState;
            const targetLocId   = getNearestLocation(resolvedState);

            log.error('BILL SENDER LOC | RESOLVED', {
                soId,
                resolvedState: resolvedState || '(blank — using default)',
                targetLocId,
                targetLabel:   LOC_LABEL[targetLocId]
            });

            // ---- Load SO and update header + all lines ----
            const so = record.load({
                type:      soType,
                id:        soId,
                isDynamic: false
            });

            const currentHeaderLoc = String(so.getValue('location') || '');

            so.setValue({
                fieldId: 'location',
                value:   targetLocId
            });

            log.error('BILL SENDER LOC | HEADER UPDATED', {
                soId,
                from: LOC_LABEL[currentHeaderLoc] || currentHeaderLoc,
                to:   LOC_LABEL[targetLocId]
            });

            const lineCount = so.getLineCount({ sublistId: 'item' });

            // Collect all item IDs for the API payload
            const allItemIds = new Set();

            for (let i = 0; i < lineCount; i++) {

                // Capture item ID regardless of whether location changes
                const itemId = String(
                    so.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i }) || ''
                );
                if (itemId) allItemIds.add(itemId);

                const currentLineLoc = String(
                    so.getSublistValue({
                        sublistId: 'item',
                        fieldId:   'location',
                        line:      i
                    }) || ''
                );

                // Only update if the line location differs from target
                if (currentLineLoc === targetLocId) continue;

                so.setSublistValue({
                    sublistId: 'item',
                    fieldId:   'location',
                    line:      i,
                    value:     targetLocId
                });

                log.audit('BILL SENDER LOC | LINE ' + i + ' UPDATED', {
                    from: LOC_LABEL[currentLineLoc] || currentLineLoc,
                    to:   LOC_LABEL[targetLocId]
                });
            }

            // ---- Set guard flag so this never re-fires ----
            so.setValue({
                fieldId: 'custbody_bill_sender_order_location_up',
                value:   true
            });

            so.save({
                enableSourcing:        false,
                ignoreMandatoryFields: true
            });

            log.audit('BILL SENDER LOC | COMPLETE', {
                soId,
                linesUpdated: lineCount,
                targetLoc:    LOC_LABEL[targetLocId],
                state:        resolvedState || '(default)'
            });

            // =========================================================
            // External API call — same pattern as Script 2.
            // Build payload via autoLocUtil then POST to /update-dropship-lines.
            // Fires always (even if no lines were moved).
            // =========================================================
            if (allItemIds.size) {

                const dupPayload = {
                    salesOrderHeaderId: soId,
                    salesOrderItemId:   Array.from(allItemIds)
                };

                log.error('BILL SENDER LOC | CALLING DUP API', dupPayload);

                const responseJson = autoLocUtil.getDropShipOrders_helperfunction(dupPayload, 1000, 0);

                log.error('BILL SENDER LOC | DUP API RESPONSE', responseJson);

                if (
                    responseJson &&
                    responseJson.data &&
                    Object.keys(responseJson.data).length > 0
                ) {
                    log.error('BILL SENDER LOC | VALID DATA — CALLING SEND', responseJson.data);
                    sendData(responseJson);
                } else {
                    log.error('BILL SENDER LOC | NO VALID DATA — SKIPPING SEND', responseJson);
                }
            }

        } catch (e) {
            log.error('BILL SENDER LOC | ERROR', e);
        }
    };

    return { afterSubmit };

});