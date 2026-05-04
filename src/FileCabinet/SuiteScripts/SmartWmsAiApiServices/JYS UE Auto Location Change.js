/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 *
 * JYS UE Auto Location Change (v2.0 — Merged)
 * --------------------------------------------
 * Merged from two scripts:
 *   - JYS UE Auto Location Change       (script ID 2006) — JYS priority-walk logic
 *   - JYS Change Order to Nearest WH    (script ID 736)  — Bill Sender nearest-WH logic
 *
 * The old "JYS chane order to nearest warehosue.js" (ID 736) can be retired.
 * All its logic now lives in BLOCK A of afterSubmit below.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * BLOCK A — Bill Sender: Nearest WH Assignment  (afterSubmit, CREATE + EDIT)
 * ─────────────────────────────────────────────────────────────────────────────
 *   Eligibility:
 *     - Customer has custentity_bill_sender_customer    = T
 *     - Customer has custentity_jyswms_auto_loc_change  = T
 *     - Order status is "Pending Approval"
 *     - Order trandate >= BILL_SENDER_GATE_DATE (2026-05-04)
 *   Guard:   custbody_bill_sender_order_location_up
 *            Once TRUE, this block never re-fires on the order.
 *   Logic:
 *     Resolves the nearest warehouse from the shipping state.
 *     For each InvtPart line, moves the line to the nearest WH ONLY IF
 *     inventory is available there. Lines with no stock at the nearest WH
 *     are left untouched. NO fallback to 2nd or 3rd warehouse.
 *     Guard flag is set regardless of whether any lines were moved,
 *     so this block never re-evaluates the same order.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * BLOCK B — JYS Auto Location Change: Priority Walk  (afterSubmit, EDIT only)
 * ─────────────────────────────────────────────────────────────────────────────
 *   Eligibility:
 *     - custbody_jyswms_enable_auto_loc_chng = T  (order-level flag)
 *     - Customer has custentity_jyswms_enable = T
 *     - Status is NOT Closed / Cancelled / Billed
 *   Guard:   custbody_jyswms_loc_updated
 *            Once TRUE, this block never re-fires on the order.
 *   Logic:
 *     For each InvtPart line, walks the state-based WH priority list
 *     (nearest → 2nd → 3rd) and moves the line to the first location
 *     that has sufficient stock to fill the ordered quantity.
 *     On change, calls the dropship-update API.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * BEFORE SUBMIT  (EDIT only — unchanged from v1.0)
 * ─────────────────────────────────────────────────────────────────────────────
 *   - Syncs newly-closed lines to WMS via close-order-line API
 *   - Sets custbody_jys_wms_sync_completed based on picked status
 *   - Sets custcol_jyswms_issue (inventory issue reason) on each line
 *
 * Warehouses:
 *   L41 → Flemington  (NetSuite internal ID: 9)   East
 *   L60 → Hardee      (NetSuite internal ID: 15)  South / Central
 *   L74 → West        (NetSuite internal ID: 23)  West
 *
 * Script Deployment:
 *   - Record Type: salesorder
 *   - Events:      beforeSubmit, afterSubmit
 *   - Triggers:    CREATE, EDIT
 *   - Status:      Released
 *
 * Governance Notes:
 *   - search.lookupFields        :  1 unit
 *   - search.create (inventory)  : 10 units
 *   - record.load                : 10 units
 *   - record.save / submitFields : 20 units
 *
 * Change Log:
 *   v1.0.0 - Original JYS UE Auto Location Change
 *   v2.0.0 - Merged Bill Sender nearest-WH logic (formerly script ID 736)
 *            into BLOCK A of afterSubmit; retired the standalone script.
 */
define([
    'N/record',
    'N/search',
    'N/log',
    'N/runtime',
    'N/https',
    './Orders/orderUtils',
    './JYSWMS_generateToken_API'
], (record, search, log, runtime, https, autoLocUtil, tokenModule) => {

    // =========================================================
    // CONSTANTS — NetSuite Location Internal IDs
    // Verify: Setup > Company > Locations
    // =========================================================
    const LOC_FLEMINGTON = '9';    // L41 — East (Flemington, NJ)
    const LOC_HARDEE     = '15';   // L60 — South (Hardee, FL)
    const LOC_74         = '23';   // L74 — West

    const LOCATIONS = [LOC_FLEMINGTON, LOC_HARDEE, LOC_74];

    // Warehouse code → NetSuite location ID
    const WH_CODE_TO_LOC = {
        L41: LOC_FLEMINGTON,
        L60: LOC_HARDEE,
        L74: LOC_74
    };

    // NetSuite location ID → warehouse code (for logging)
    const LOC_TO_WH_CODE = {
        [LOC_FLEMINGTON]: 'L41',
        [LOC_HARDEE]:     'L60',
        [LOC_74]:         'L74'
    };

    // Human-readable label for logging (used by Block A)
    const LOC_LABEL = {
        [LOC_FLEMINGTON]: 'L41 - Flemington',
        [LOC_HARDEE]:     'L60 - Hardee',
        [LOC_74]:         'L74 - West'
    };

    // =========================================================
    // ISSUE REASON IDs — Verify: Customization > Lists > [reason list]
    // =========================================================
    const REASON_NA                 = 1;
    const REASON_BULK               = 2;
    const REASON_RECEIVING          = 3;
    const REASON_BOTH               = 4;
    const REASON_OTHER_LOCATION     = 5;
    const REASON_OTHER_LOC_BULK_REC = 6;

    // =========================================================
    // STATE → WAREHOUSE PRIORITY MAP
    // Priority array = [nearest/primary, secondary, tertiary]
    // Shared by both Block A (index [0] only) and Block B (full walk).
    // =========================================================
    const STATE_TO_WH_PRIORITY = {
        // L41-primary states (East)
        CT: ['L41', 'L60', 'L74'], DE: ['L41', 'L60', 'L74'],
        ME: ['L41', 'L60', 'L74'], MD: ['L41', 'L60', 'L74'],
        MA: ['L41', 'L60', 'L74'], MI: ['L41', 'L60', 'L74'],
        MN: ['L41', 'L60', 'L74'], NH: ['L41', 'L60', 'L74'],
        NJ: ['L41', 'L60', 'L74'], NY: ['L41', 'L60', 'L74'],
        OH: ['L41', 'L60', 'L74'], PA: ['L41', 'L60', 'L74'],
        RI: ['L41', 'L60', 'L74'], VT: ['L41', 'L60', 'L74'],
        VA: ['L41', 'L60', 'L74'], WV: ['L41', 'L60', 'L74'],
        WI: ['L41', 'L60', 'L74'],

        // L60-primary states (South / Central)
        AL: ['L60', 'L41', 'L74'], AR: ['L60', 'L74', 'L41'],
        FL: ['L60', 'L41', 'L74'], GA: ['L60', 'L41', 'L74'],
        IL: ['L60', 'L41', 'L74'], IN: ['L60', 'L41', 'L74'],
        IA: ['L60', 'L41', 'L74'], KS: ['L60', 'L74', 'L41'],
        KY: ['L60', 'L41', 'L74'], LA: ['L60', 'L74', 'L41'],
        MS: ['L60', 'L41', 'L74'], MO: ['L60', 'L74', 'L41'],
        NE: ['L60', 'L74', 'L41'], NC: ['L60', 'L41', 'L74'],
        OK: ['L60', 'L74', 'L41'], SC: ['L60', 'L41', 'L74'],
        TN: ['L60', 'L41', 'L74'], TX: ['L60', 'L74', 'L41'],

        // L74-primary states (West)
        AZ: ['L74', 'L60', 'L41'], CA: ['L74', 'L60', 'L41'],
        CO: ['L74', 'L60', 'L41'], ID: ['L74', 'L60', 'L41'],
        MT: ['L74', 'L60', 'L41'], NV: ['L74', 'L60', 'L41'],
        NM: ['L74', 'L60', 'L41'], ND: ['L74', 'L60', 'L41'],
        OR: ['L74', 'L60', 'L41'], SD: ['L74', 'L60', 'L41'],
        UT: ['L74', 'L60', 'L41'], WA: ['L74', 'L60', 'L41'],
        WY: ['L74', 'L60', 'L41']
    };

    // Default fallback priority when state is unknown or blank
    const DEFAULT_WH_PRIORITY = ['L60', 'L41', 'L74'];

    // =========================================================
    // BLOCK A — SPECIFIC CONSTANTS
    // =========================================================
    // Only these statuses are processed by Block A
    const BILL_SENDER_ALLOWED_STATUSES = ['Pending Approval'];   // 'Pending Fulfillment' intentionally excluded

    // Block A date gate: ignore orders older than this date
    // Month is 0-indexed: 4 = May
    const BILL_SENDER_GATE_DATE = new Date(2026, 4, 4);  // May 4 2026

    // =========================================================
    // HELPER — getLocationPriority
    // Returns ordered array of NetSuite location IDs for a state.
    // Index [0] = nearest warehouse.
    // Example: getLocationPriority('FL') → ['15', '9', '23']
    // =========================================================
    const getLocationPriority = (stateAbbr) => {
        const upper    = (stateAbbr || '').toString().trim().toUpperCase();
        const priority = STATE_TO_WH_PRIORITY[upper] || DEFAULT_WH_PRIORITY;
        return priority.map(code => WH_CODE_TO_LOC[code]);
    };

    // =========================================================
    // HELPER — getNearestLocation
    // Returns the single nearest warehouse location ID for a state.
    // Derived from getLocationPriority — always index [0].
    // =========================================================
    const getNearestLocation = (stateAbbr) => getLocationPriority(stateAbbr)[0];

    // =========================================================
    // SEND DATA — Dropship update API  (Block B afterSubmit)
    // =========================================================
    const sendData = (payload) => {

        log.error('SEND DATA - START', JSON.stringify(payload));

        const token = tokenModule.generateToken();
        log.error('SEND DATA - Token Generated', token ? 'Success' : 'Failed');
        if (!token) {
            log.error('SEND DATA - Token Failed', 'Token generation failed');
            return;
        }

        try {
            const response = https.post({
                url: 'https://api.jyswms.com/update-dropship-lines?closed=false',
                headers: {
                    'Authorization': 'Bearer ' + token,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            log.error('SEND DATA - RESPONSE', { code: response.code, body: response.body });
            return { success: response.code === 200, response: response.body || '' };

        } catch (e) {
            log.error('SEND DATA - ERROR', e);
            return { success: false, error: e.message };
        }
    };

    // =========================================================
    // SEND CLOSED DATA — WMS closed-line sync  (beforeSubmit)
    // =========================================================
    const sendClosedData = (payload) => {

        const token = tokenModule.generateToken();
        if (!token) return;

        try {
            const response = https.post({
                url: 'https://api.jyswms.com/close-order-line?unique_id=' + payload.lineUniqueKey,
                headers: {
                    'Authorization': 'Bearer ' + token,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            return { success: response.code === 200, response: response.body || '' };

        } catch (e) {
            log.error('SEND CLOSED DATA - ERROR', e);
            return { success: false, error: e.message };
        }
    };

    // =========================================================
    // MARK COMPLETE — Sets JYS loc-updated guard via submitFields
    // (Block B — used when no lines changed but still need to mark done)
    // =========================================================
    const markComplete = (type, id) => {
        record.submitFields({
            type:    type,
            id:      id,
            values:  { custbody_jyswms_loc_updated: true },
            options: { enableSourcing: false, ignoreMandatoryFields: true }
        });
    };

    // =========================================================
    // INVENTORY HELPERS — used by beforeSubmit reason-code logic
    // =========================================================
    const hasInventory = (binData) =>
        Array.isArray(binData) && binData.some(b => (b.available || 0) > 0);

    const determineBinReason = (binData) => {
        if (!binData || !binData.length) return REASON_NA;

        let hasBulk      = false;
        let hasReceiving = false;
        let hasOther     = false;

        binData.forEach(entry => {
            const binName = (entry.bin || '').toLowerCase();
            if (binName.includes('bulk')) {
                hasBulk = true;
            } else if (
                binName.includes('receiving') ||
                binName.includes('rt')        ||
                binName.includes('studio')
            ) {
                hasReceiving = true;
            } else {
                hasOther = true;
            }
        });

        if (hasOther)              return '';
        if (hasBulk && hasReceiving) return REASON_BOTH;
        if (hasBulk)               return REASON_BULK;
        if (hasReceiving)          return REASON_RECEIVING;
        return REASON_NA;
    };

    const hasOnlyBulkOrReceiving = (bins) => {
        if (!bins || !bins.length) return false;
        return bins.every(b =>
            b.available > 0 && (
                b.bin.toLowerCase().includes('bulk')      ||
                b.bin.toLowerCase().includes('receiving') ||
                b.bin.toLowerCase().includes('studio')
            )
        );
    };

    // =========================================================
    // BLOCK A — Bill Sender: Nearest WH Assignment
    //
    // Moves each InvtPart line to the nearest warehouse based on
    // the shipping state — but ONLY if inventory is available at
    // that warehouse. No fallback to 2nd or 3rd warehouse.
    //
    // Guard flag custbody_bill_sender_order_location_up is set
    // after the first run so this block never fires again on
    // the same order — regardless of whether lines were moved.
    //
    // Runs: afterSubmit → CREATE + EDIT
    // =========================================================
    const runBillSenderLocationUpdate = (context) => {

        try {
            const newRec = context.newRecord;
            const soId   = newRec.id;

            if (!soId) {
                log.error('BILL SENDER LOC | EXIT', 'Record ID is null — cannot proceed.');
                return;
            }

            // ---- Guard: never re-fire on an already-processed order ----
            const alreadyUpdated = newRec.getValue('custbody_bill_sender_order_location_up');
            if (alreadyUpdated) {
                log.error('BILL SENDER LOC | EXIT', 'Order ' + soId + ' — guard already set, skipping Block A.');
                return;
            }

            // ---- Status guard: Pending Approval only ----
            const status = newRec.getValue('status');
            if (!BILL_SENDER_ALLOWED_STATUSES.includes(status)) {
                log.error('BILL SENDER LOC | EXIT', {
                    soId,
                    status,
                    reason: 'Status not in allowed list (Pending Approval) — skipping Block A.'
                });
                return;
            }

            // ---- Date gate: only orders on or after May 4 2026 ----
            const tranDateRaw = newRec.getValue('trandate');
            const tranDate    = tranDateRaw ? new Date(tranDateRaw) : null;

            if (!tranDate || tranDate < BILL_SENDER_GATE_DATE) {
                log.error('BILL SENDER LOC | EXIT', {
                    soId,
                    tranDate : tranDateRaw,
                    reason   : 'Order date is before gate date (2026-05-04) — skipping Block A.'
                });
                return;
            }

            // ---- Customer eligibility: both flags must be TRUE ----
            const customerId = newRec.getValue({ fieldId: 'entity' });
            if (!customerId) {
                log.error('BILL SENDER LOC | EXIT', 'No customer on order ' + soId + ' — skipping Block A.');
                return;
            }

            const customerFields = search.lookupFields({
                type:    search.Type.CUSTOMER,
                id:      customerId,
                columns: [
                    'custentity_bill_sender_customer',      // Bill Sender customer flag
                    'custentity_jyswms_auto_loc_change'    // Auto location change flag
                ]
            });

            const isBillSender     = customerFields.custentity_bill_sender_customer    === true || customerFields.custentity_bill_sender_customer    === 'T';
            const isAutoLocEnabled = customerFields.custentity_jyswms_auto_loc_change  === true || customerFields.custentity_jyswms_auto_loc_change  === 'T';

            if (!isBillSender || !isAutoLocEnabled) {
                log.error('BILL SENDER LOC | EXIT', {
                    soId,
                    isBillSender,
                    isAutoLocEnabled,
                    reason: 'One or both customer flags are false — skipping Block A.'
                });
                return;
            }

            // ---- Resolve nearest warehouse from shipping state ----
            // Prefer ship-to state; fall back to bill-to state
            const shipState     = newRec.getValue('shipstate') || '';
            const billState     = newRec.getValue('billstate') || '';
            const resolvedState = shipState || billState;
            const targetLocId   = getNearestLocation(resolvedState);

            log.error('BILL SENDER LOC | RESOLVED', {
                soId,
                resolvedState : resolvedState || '(blank — using default)',
                targetLocId,
                targetLabel   : LOC_LABEL[targetLocId]
            });

            // ---- Load SO for line-level updates ----
            const so = record.load({
                type:      record.Type.SALES_ORDER,
                id:        soId,
                isDynamic: false
            });

            const lineCount = so.getLineCount({ sublistId: 'item' });
            if (!lineCount) return;

            // ---- Collect all InvtPart item IDs for inventory check ----
            // Only include lines where custcol_jyswms_picked_qty is 0 or empty.
            // Lines with any picked qty (even partial) are left untouched.
            const itemSet = new Set();

            for (let i = 0; i < lineCount; i++) {
                const itemType = so.getSublistValue({ sublistId: 'item', fieldId: 'itemtype', line: i });
                if (itemType !== 'InvtPart') continue;

                const pickedRaw = so.getSublistValue({ sublistId: 'item', fieldId: 'custcol_jyswms_picked_qty', line: i });
                const pickedQty = (pickedRaw === null || pickedRaw === '' || pickedRaw === undefined) ? 0 : Number(pickedRaw);

                if (pickedQty > 0) {
                    log.error('BILL SENDER LOC | LINE ' + i + ' SKIPPED — already picked', { pickedQty });
                    continue;
                }

                const itemId = String(so.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i }) || '');
                if (itemId) itemSet.add(itemId);
            }

            // ---- Check inventory at nearest WH only — no fallback ----
            // Uses OR on the exclude flag so bins where the field is null are
            // not dropped from the result set (avoids false "no stock" reads).
            const inventoryAtTarget = {};  // { itemId: totalAvailableQty }

            if (itemSet.size) {
                search.create({
                    type: 'inventorybalance',
                    filters: [
                        ['item',      'anyof',       [...itemSet]],
                        'AND',
                        ['location',  'anyof',       [targetLocId]],
                        'AND',
                        ['available', 'greaterthan', '0'],
                        'AND',
                        [
                            ['binnumber.custrecord_jyswms_exclude_from_inventory', 'is',      'F'],
                            'OR',
                            ['binnumber.custrecord_jyswms_exclude_from_inventory', 'isempty', '']
                        ],
                        'AND',
                        ['binnumber.inactive',  'is',         'F'],
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

            // ---- Per-line: move to nearest WH only when inventory is available ----
            const currentHeaderLoc = String(so.getValue('location') || '');
            let anyLineUpdated     = false;

            for (let i = 0; i < lineCount; i++) {

                const itemType = so.getSublistValue({ sublistId: 'item', fieldId: 'itemtype', line: i });
                const itemId   = String(so.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i }) || '');

                // InvtPart: skip if anything has been picked, or if no stock at nearest WH
                if (itemType === 'InvtPart') {
                    const pickedRaw = so.getSublistValue({ sublistId: 'item', fieldId: 'custcol_jyswms_picked_qty', line: i });
                    const pickedQty = (pickedRaw === null || pickedRaw === '' || pickedRaw === undefined) ? 0 : Number(pickedRaw);

                    if (pickedQty > 0) {
                        log.error('BILL SENDER LOC | LINE ' + i + ' SKIPPED — already picked', { itemId, pickedQty });
                        continue;
                    }

                    const availableAtTarget = inventoryAtTarget[itemId] || 0;
                    if (availableAtTarget <= 0) {
                        log.error('BILL SENDER LOC | LINE ' + i + ' SKIPPED — no stock at nearest WH', {
                            itemId,
                            targetLocId,
                            targetLabel: LOC_LABEL[targetLocId]
                        });
                        continue;  // Leave this line at its current location
                    }
                }

                const currentLineLoc = String(so.getSublistValue({ sublistId: 'item', fieldId: 'location', line: i }) || '');
                if (currentLineLoc === targetLocId) continue;  // Already at nearest WH

                so.setSublistValue({ sublistId: 'item', fieldId: 'location',                    line: i, value: targetLocId });
                so.setSublistValue({ sublistId: 'item', fieldId: 'custcol_jyswms_line_location', line: i, value: targetLocId });

                log.debug('BILL SENDER LOC | LINE ' + i + ' UPDATED', {
                    itemId,
                    from: LOC_LABEL[currentLineLoc] || currentLineLoc,
                    to:   LOC_LABEL[targetLocId]
                });

                anyLineUpdated = true;
            }

            // Update header location only when at least one line was moved
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

            // ---- Always set guard flag — never re-evaluate this order ----
            so.setValue({ fieldId: 'custbody_bill_sender_order_location_up', value: true });

            so.save({ enableSourcing: false, ignoreMandatoryFields: true });

            log.error('BILL SENDER LOC | COMPLETE', {
                soId,
                anyLineUpdated,
                targetLoc : LOC_LABEL[targetLocId],
                state     : resolvedState || '(default)'
            });

            // Return true only when lines were actually moved so the caller
            // (afterSubmit) can decide whether Block B should still run.
            return anyLineUpdated;

        } catch (e) {
            log.error('BILL SENDER LOC | ERROR', e);
            return false;
        }
    };

    // =========================================================
    // BLOCK B — JYS Auto Location Change: Priority Walk
    //
    // For each InvtPart line that lacks sufficient stock at its
    // current location, walks the state-based WH priority list
    // (nearest → 2nd → 3rd) and moves the line to the first
    // location that has enough stock to cover the ordered qty.
    // On any location change, calls the dropship-update API.
    //
    // Guard flag custbody_jyswms_loc_updated is set after the
    // first run so this block never fires again on the same order.
    //
    // Runs: afterSubmit → EDIT only
    // =========================================================
    const runJysAutoLocationChange = (context) => {

        try {
            const newRec = context.newRecord;
            const soId   = newRec.id;
            const soType = newRec.type;

            if (soType !== record.Type.SALES_ORDER) {
                log.error('JYS AUTO LOC | EXIT', 'Not Sales Order');
                return;
            }

            const autoLocEnabled = newRec.getValue('custbody_jyswms_enable_auto_loc_chng');
            const alreadyUpdated = newRec.getValue('custbody_jyswms_loc_updated');
            const status         = newRec.getValue('status');

            if (['Closed', 'Cancelled', 'Billed'].includes(status)) return;
            if (!autoLocEnabled || alreadyUpdated)                    return;

            const customerId = newRec.getValue({ fieldId: 'entity' });
            if (!customerId) return;

            const customerLookup = search.lookupFields({
                type:    search.Type.CUSTOMER,
                id:      customerId,
                columns: ['custentity_jyswms_enable', 'custentity_single_if']
            });

            const isJysEnabled =
                customerLookup.custentity_jyswms_enable === true ||
                customerLookup.custentity_jyswms_enable === 'T';

            if (!isJysEnabled) return;

            // ---- Resolve shipping state for closest-WH priority logic ----
            // Prefer ship-to address state; fall back to bill-to
            const so = record.load({ type: soType, id: soId, isDynamic: false });

            const shipState   = so.getValue('shipstate') || so.getValue('billstate') || '';
            const locPriority = getLocationPriority(shipState);

            log.error('JYS AUTO LOC | PRIORITY for SOID: ' + soId, {
                shipState,
                locPriority: locPriority.map(l => LOC_TO_WH_CODE[l] + '(' + l + ')')
            });

            const lineCount = so.getLineCount({ sublistId: 'item' });
            if (!lineCount) return;

            // ---- Build set of items still needing evaluation ----
            const itemSet = new Set();

            for (let i = 0; i < lineCount; i++) {

                const itemType  = so.getSublistValue({ sublistId: 'item', fieldId: 'itemtype',                   line: i });
                if (itemType !== 'InvtPart') continue;

                const quantity  = parseFloat(so.getSublistValue({ sublistId: 'item', fieldId: 'quantity',                   line: i })) || 0;
                const pickedQty = Number   (so.getSublistValue({ sublistId: 'item', fieldId: 'custcol_jyswms_picked_qty', line: i })) || 0;
                const itemId    = String   (so.getSublistValue({ sublistId: 'item', fieldId: 'item',                      line: i }));

                if (pickedQty <= 0 || pickedQty < quantity) {
                    itemSet.add(itemId);
                }
            }

            if (!itemSet.size) {
                markComplete(soType, soId);
                return;
            }

            // ---- Build inventory map across all 3 locations ----
            // NOTE: We use OR on the exclude flag to handle bins where the field
            // is null/unset — avoids dropping entire rows from the result set.
            const inventoryMap = {};  // { itemId: { locId: totalAvailableQty } }

            search.create({
                type: 'inventorybalance',
                filters: [
                    ['item',      'anyof',       [...itemSet]],
                    'AND',
                    ['location',  'anyof',       LOCATIONS],
                    'AND',
                    ['available', 'greaterthan', '0'],
                    'AND',
                    [
                        ['binnumber.custrecord_jyswms_exclude_from_inventory', 'is',      'F'],
                        'OR',
                        ['binnumber.custrecord_jyswms_exclude_from_inventory', 'isempty', '']
                    ],
                    'AND',
                    ['binnumber.inactive',  'is',         'F'],
                    'AND',
                    ['binnumber.binnumber', 'isnotempty', '']
                ],
                columns: ['item', 'location', 'available']
            }).run().each(result => {

                const itemId = String(result.getValue('item'));
                const locId  = String(result.getValue('location'));
                const qty    = parseFloat(result.getValue('available')) || 0;

                if (!inventoryMap[itemId])        inventoryMap[itemId] = {};
                if (!inventoryMap[itemId][locId]) inventoryMap[itemId][locId] = 0;

                inventoryMap[itemId][locId] += qty;
                return true;
            });

            log.error('JYS AUTO LOC | INVENTORY MAP for SOID: ' + soId, JSON.stringify(inventoryMap));

            let anyLineUpdated    = false;
            let newHeaderLocation = null;
            const updatedItemIds  = new Set();

            for (let i = 0; i < lineCount; i++) {

                const itemType = so.getSublistValue({ sublistId: 'item', fieldId: 'itemtype', line: i });
                if (itemType !== 'InvtPart') continue;

                const itemId = String(so.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i }));
                if (!inventoryMap[itemId]) continue;

                const qtyRequired      = parseFloat(so.getSublistValue({ sublistId: 'item', fieldId: 'quantity', line: i })) || 0;
                const currentLoc       = String(so.getSublistValue({ sublistId: 'item', fieldId: 'location', line: i }));
                const currentAvailable = inventoryMap[itemId][currentLoc] || 0;

                // Current location already satisfies the ordered quantity — no change needed
                if (currentAvailable >= qtyRequired) {
                    log.debug('JYS AUTO LOC | SUFFICIENT at ' + LOC_TO_WH_CODE[currentLoc] + ' for SOID: ' + soId, { line: i, itemId, qtyRequired, currentAvailable });
                    continue;
                }

                // Walk the state-based priority list to find a location with enough stock.
                // Skip the current location (already confirmed insufficient above).
                let bestLoc = null;

                for (const candidateLoc of locPriority) {
                    if (candidateLoc === currentLoc) continue;
                    const candidateQty = inventoryMap[itemId][candidateLoc] || 0;
                    if (candidateQty >= qtyRequired) {
                        bestLoc = candidateLoc;
                        break;
                    }
                }

                if (!bestLoc) {
                    log.error('JYS AUTO LOC | NO SUITABLE LOCATION for SOID: ' + soId, {
                        line:         i,
                        itemId,
                        qtyRequired,
                        inventoryMap: inventoryMap[itemId]
                    });
                    continue;
                }

                log.error('JYS AUTO LOC | LOCATION SWITCH for SOID: ' + soId, {
                    line:   i,
                    itemId,
                    from:   LOC_TO_WH_CODE[currentLoc] + '(' + currentLoc + ')',
                    to:     LOC_TO_WH_CODE[bestLoc]    + '(' + bestLoc    + ')',
                    reason: 'Closest WH with sufficient stock for state: ' + shipState
                });

                so.setSublistValue({ sublistId: 'item', fieldId: 'location',                    line: i, value: bestLoc });
                so.setSublistValue({ sublistId: 'item', fieldId: 'custcol_jyswms_line_location', line: i, value: bestLoc });
                so.setSublistValue({ sublistId: 'item', fieldId: 'custcol_jyswms_issue',         line: i, value: '' });

                anyLineUpdated = true;
                updatedItemIds.add(itemId);

                if (lineCount === 1) newHeaderLocation = bestLoc;
            }

            if (anyLineUpdated) {

                if (lineCount === 1 && newHeaderLocation) {
                    so.setValue({ fieldId: 'location', value: newHeaderLocation });
                }

                so.setValue({ fieldId: 'custbody_jyswms_loc_updated', value: true });

                log.error('JYS AUTO LOC | SAVING SO for SOID: ' + soId, soId);

                so.save({ enableSourcing: false, ignoreMandatoryFields: true });

            } else {
                markComplete(soType, soId);
            }

            if (updatedItemIds.size) {

                const payload = {
                    salesOrderHeaderId: soId,
                    salesOrderItemId:   Array.from(updatedItemIds)
                };

                log.error('JYS AUTO LOC | CALLING DUP API for SOID: ' + soId, payload);

                const responseJson = autoLocUtil.getDropShipOrders_helperfunction(payload, 1000, 0);
                log.error('JYS AUTO LOC | DUP API RESPONSE for SOID: ' + soId, responseJson);

                if (
                    responseJson &&
                    responseJson.data &&
                    Object.keys(responseJson.data).length > 0
                ) {
                    log.error('JYS AUTO LOC | VALID DATA — CALLING API', responseJson.data);
                    sendData(responseJson);
                } else {
                    log.error('JYS AUTO LOC | NO VALID DATA — SKIPPING API', responseJson);
                }
            }

        } catch (error) {
            log.error('JYS AUTO LOC | ERROR', error);
        }
    };

    // =========================================================
    // AFTER SUBMIT — Entry point
    //
    // Runs Block A first (Bill Sender, CREATE + EDIT), then
    // Block B (JYS priority-walk, EDIT only).
    //
    // Guard logic between blocks:
    //   - If Block A actually moved at least one line to the nearest WH,
    //     Block B is SKIPPED — location is already correct, no override.
    //   - If Block A ran but found no stock at the nearest WH (no lines
    //     moved), Block B is still allowed to run its priority walk so it
    //     can find any warehouse with sufficient stock.
    //   - If Block A did not qualify at all (wrong customer type, wrong
    //     status, already processed, etc.), Block B runs normally.
    //
    //   Block A guard field: custbody_bill_sender_order_location_up
    //   Block B guard field: custbody_jyswms_loc_updated
    // =========================================================
    const afterSubmit = (context) => {

        const isCreate = context.type === context.UserEventType.CREATE;
        const isEdit   = context.type === context.UserEventType.EDIT;

        if (!isCreate && !isEdit) return;

        const newRec = context.newRecord;
        const soId   = newRec.id;

        // Read Block A's guard BEFORE Block A runs.
        // If already TRUE, Block A ran on a previous save — location is locked.
        const billSenderAlreadyProcessed = !!newRec.getValue('custbody_bill_sender_order_location_up');

        log.error('AFTER SUBMIT | START', {
            soId,
            eventType               : context.type,
            billSenderAlreadyProcessed
        });

        // BLOCK A: Bill Sender nearest-WH update (CREATE + EDIT).
        // Returns true  → moved at least one line this run.
        // Returns false → ran but no stock at nearest WH; no lines moved.
        // Returns undefined (falsy) → early exit (guard already set, wrong
        //   status/customer/date). Use billSenderAlreadyProcessed to gate Block B.
        const blockAMovedLines = runBillSenderLocationUpdate(context);

        log.error('AFTER SUBMIT | BLOCK A RESULT', {
            soId,
            blockAMovedLines            : !!blockAMovedLines,
            billSenderAlreadyProcessed
        });

        // BLOCK B: JYS priority-walk location change (EDIT only).
        //
        // Skip if ANY of the following is true:
        //   1. blockAMovedLines = true        → Block A just moved lines; do not override.
        //   2. billSenderAlreadyProcessed = true → Block A ran on a PREVIOUS save and
        //                                          already locked the location.
        //
        // Allow Block B only when both are false — Block A either didn't qualify
        // this run OR ran and found no stock, so the priority walk can still help.
        const blockBShouldRun = isEdit && !blockAMovedLines && !billSenderAlreadyProcessed;

        log.error('AFTER SUBMIT | BLOCK B DECISION', {
            soId,
            isEdit,
            blockAMovedLines           : !!blockAMovedLines,
            billSenderAlreadyProcessed,
            blockBShouldRun
        });

        if (blockBShouldRun) {
            runJysAutoLocationChange(context);
        }
    };

    // =========================================================
    // BEFORE SUBMIT — Closed-line sync + inventory issue reasons
    //
    // Unchanged from v1.0. Fires on EDIT only.
    // =========================================================
    const beforeSubmit = (context) => {

        if (![context.UserEventType.EDIT].includes(context.type)) return;

        try {

            const soRec     = context.newRecord;
            const isEnabled = soRec.getValue('custbody_jys_enabled_customer');
            if (!isEnabled) return;

            const shipvia = soRec.getValue('shipmethod');
            if (shipvia == 57733) {
                log.error('EXIT', 'Order is marked as P/U, skipping auto location change and closed line sync');
                return;
            }

            const excludeCustomer = soRec.getText('entity');
            if (excludeCustomer && excludeCustomer.toLowerCase().includes('amazon')) {
                log.error('EXIT', 'Customer is Amazon, skipping auto location change and closed line sync');
                return;
            }

            const status      = soRec.getValue('status');
            const lowerStatus = status ? String(status).toLowerCase() : '';

            if (['closed', 'cancelled', 'billed'].includes(lowerStatus)) {
                soRec.setValue({ fieldId: 'custbody_jyswms_fufilment_error', value: '' });
            }

            const lineCount = soRec.getLineCount({ sublistId: 'item' });
            if (!lineCount) return;

            const CLOSED_SYNC_START_DATE = new Date(2026, 0, 1);  // Jan 1 2026

            const closedItemIds = new Set();
            const itemSet       = new Set();

            // allLinesPicked must start true and only ever be set to false —
            // never reset back to true inside the loop (bug fix from v1.0).
            let allLinesPicked = true;

            for (let i = 0; i < lineCount; i++) {

                const pickedRaw   = soRec.getSublistValue({ sublistId: 'item', fieldId: 'custcol_jyswms_picked_qty', line: i });
                const jypickedQty = parseFloat(pickedRaw);

                // Only set to false — never flip back to true mid-loop
                if ((pickedRaw == null || pickedRaw === '' || pickedRaw === undefined) && jypickedQty !== 0) {
                    allLinesPicked = false;
                } else if (!isNaN(jypickedQty) && jypickedQty < 0) {
                    allLinesPicked = false;
                }

                const itemId       = String(soRec.getSublistValue({ sublistId: 'item', fieldId: 'item',               line: i }) || '');
                const quantity     = parseFloat(soRec.getSublistValue({ sublistId: 'item', fieldId: 'quantity',          line: i })) || 0;
                const fulfilledQty = parseFloat(soRec.getSublistValue({ sublistId: 'item', fieldId: 'quantityfulfilled', line: i })) || 0;
                const pickedQty    = parseFloat(soRec.getSublistValue({ sublistId: 'item', fieldId: 'quantitypicked',    line: i })) || 0;

                // Add all unfulfilled, unpicked items for issue-reason evaluation
                if (itemId && fulfilledQty < quantity && pickedQty <= 0) itemSet.add(itemId);

                // ---- Closed-line detection ----
                const isClosed   = soRec.getSublistValue({ sublistId: 'item', fieldId: 'isclosed',             line: i });
                const closedSent = soRec.getSublistValue({ sublistId: 'item', fieldId: 'custcol_jys_close_sent', line: i });

                if ((isClosed === true || isClosed === 'T') && !closedSent) {
                    const lineUniqueKey = soRec.getSublistValue({ sublistId: 'item', fieldId: 'lineuniquekey', line: i });
                    if (lineUniqueKey) {
                        log.error('CLOSED ITEM FOUND', String(lineUniqueKey));
                        closedItemIds.add(String(lineUniqueKey));
                    }
                    soRec.setSublistValue({ sublistId: 'item', fieldId: 'custcol_jys_close_sent', line: i, value: true });
                }
            }

            // ---- Closed-line API call ----
            if (closedItemIds.size > 0) {
                const tranDate = soRec.getValue({ fieldId: 'trandate' });
                if (tranDate && new Date(tranDate) > CLOSED_SYNC_START_DATE) {
                    const payload = {
                        salesOrderId:  soRec.id,
                        lineUniqueKey: Array.from(closedItemIds)
                    };
                    log.error('SENDING CLOSED DATA', payload);
                    sendClosedData(payload);
                }
            }

            // ---- WMS sync flag ----
            soRec.setValue({ fieldId: 'custbody_jys_wms_sync_completed', value: allLinesPicked });

            if (!itemSet.size) return;

            // ---- Build availability map (all 3 locations, with bin details) ----
            // Uses OR on the exclude flag so bins where field is null/unset are
            // not dropped from the result — consistent with afterSubmit behavior.
            const availabilityMap = {};

            search.create({
                type: 'inventorybalance',
                filters: [
                    ['item',      'anyof',       [...itemSet]],
                    'AND',
                    ['location',  'anyof',       LOCATIONS],
                    'AND',
                    ['available', 'greaterthan', '0'],
                    'AND',
                    ['binnumber.inactive',  'is',         'F'],
                    'AND',
                    ['binnumber.binnumber', 'isnotempty', '']
                ],
                columns: ['item', 'location', 'available', 'binnumber']
            }).run().each(result => {

                const item      = String(result.getValue('item')     || '');
                const location  = String(result.getValue('location') || '');
                const available = parseFloat(result.getValue('available')) || 0;
                const binText   = result.getText('binnumber') || '';

                if (!item || !location) return true;

                if (!availabilityMap[item])           availabilityMap[item] = {};
                if (!availabilityMap[item][location]) availabilityMap[item][location] = [];

                availabilityMap[item][location].push({ bin: binText, available });
                return true;
            });

            // ---- Resolve shipping state for priority ordering ----
            const shipState   = soRec.getValue('shipstate') || soRec.getValue('billstate') || '';
            const locPriority = getLocationPriority(shipState);

            // ---- Set issue reason on each line ----
            for (let d = 0; d < lineCount; d++) {

                // String() all keys consistently — getSublistValue can return
                // numbers or raw IDs depending on the field and NetSuite version
                const itemId       = String(soRec.getSublistValue({ sublistId: 'item', fieldId: 'item',     line: d }) || '');
                const lineLocation = String(soRec.getSublistValue({ sublistId: 'item', fieldId: 'location', line: d }) || '');
                const quantity     = parseFloat(soRec.getSublistValue({ sublistId: 'item', fieldId: 'quantity',          line: d })) || 0;
                const pickedQty    = parseFloat(soRec.getSublistValue({ sublistId: 'item', fieldId: 'quantitypicked',    line: d })) || 0;
                const fulfilledQty = parseFloat(soRec.getSublistValue({ sublistId: 'item', fieldId: 'quantityfulfilled', line: d })) || 0;

                let reasonId = '';

                // Only clear reason when FULLY fulfilled — partial picks with
                // no fulfillment still need a reason code (bug fix from v1.0)
                if (fulfilledQty >= quantity) {
                    reasonId = '';
                } else if (pickedQty >= quantity) {
                    // Fully picked but not yet fulfilled — no issue to flag
                    reasonId = '';
                } else if (itemId && lineLocation) {

                    const itemData       = availabilityMap[itemId] || {};
                    const currentLocBins = itemData[lineLocation] || [];

                    // Collect bins from all OTHER locations in priority order
                    const otherLocsBins = locPriority
                        .filter(loc => String(loc) !== lineLocation)
                        .flatMap(loc => itemData[String(loc)] || []);

                    const currentHasInventory = hasInventory(currentLocBins);
                    const otherHasInventory   = hasInventory(otherLocsBins);

                    if (!currentHasInventory && otherHasInventory) {
                        reasonId = hasOnlyBulkOrReceiving(otherLocsBins)
                            ? REASON_OTHER_LOC_BULK_REC
                            : REASON_OTHER_LOCATION;
                    } else if (!currentHasInventory && !otherHasInventory) {
                        reasonId = REASON_NA;
                    } else {
                        // Current location has inventory but possibly only in bulk/receiving
                        reasonId = determineBinReason(currentLocBins);
                    }
                }

                soRec.setSublistValue({
                    sublistId: 'item',
                    fieldId:   'custcol_jyswms_issue',
                    line:      d,
                    value:     reasonId || ''
                });
            }

        } catch (e) {
            log.error('Inventory Script Error', e);
        }
    };

    return { afterSubmit, beforeSubmit };

});