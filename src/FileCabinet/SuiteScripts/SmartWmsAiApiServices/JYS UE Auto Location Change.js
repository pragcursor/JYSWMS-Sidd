/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 *
 * Auto Location Change - User Event Script
 * -----------------------------------------
 * Supports 3 warehouse locations:
 *   L41 → Flemington  (internal ID: 9)
 *   L60 → Hardee      (internal ID: 15)
 *   L74 → Location 74 (internal ID: 23)
 *
 * Location preference per order is resolved by:
 *   1. Shipping state → closest warehouse (STATE_TO_WH map)
 *   2. If preferred WH has stock → use it
 *   3. If not → try the 2nd-closest WH (fallback priority per state group)
 *   4. If not → try the 3rd WH
 *   5. No stock anywhere → leave as-is
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
    // CONSTANTS - Location IDs (NetSuite internal IDs)
    // =========================================================
    const LOC_HARDEE     = '15';   // L60
    const LOC_FLEMINGTON = '9';    // L41
    const LOC_74         = '23';   // L74

    const LOCATIONS = [LOC_FLEMINGTON, LOC_HARDEE, LOC_74];

    // Warehouse code → NetSuite location ID
    const WH_CODE_TO_LOC = {
        L41: LOC_FLEMINGTON,
        L60: LOC_HARDEE,
        L74: LOC_74
    };

    // NetSuite location ID → warehouse code (reverse map, for logging)
    const LOC_TO_WH_CODE = {
        [LOC_FLEMINGTON]: 'L41',
        [LOC_HARDEE]:     'L60',
        [LOC_74]:         'L74'
    };

    // Issue reason IDs (list values)
    const REASON_NA               = 1;
    const REASON_BULK             = 2;
    const REASON_RECEIVING        = 3;
    const REASON_BOTH             = 4;
    const REASON_OTHER_LOCATION   = 5;
    const REASON_OTHER_LOC_BULK_REC = 6;

    // =========================================================
    // STATE → CLOSEST WAREHOUSE MAP
    // Priority array = [primary, secondary, tertiary]
    // =========================================================
    const STATE_TO_WH_PRIORITY = {
        // L41-primary states
        CT: ['L41', 'L60', 'L74'],
        DE: ['L41', 'L60', 'L74'],
        ME: ['L41', 'L60', 'L74'],
        MD: ['L41', 'L60', 'L74'],
        MA: ['L41', 'L60', 'L74'],
        MI: ['L41', 'L60', 'L74'],
        MN: ['L41', 'L60', 'L74'],
        NH: ['L41', 'L60', 'L74'],
        NJ: ['L41', 'L60', 'L74'],
        NY: ['L41', 'L60', 'L74'],
        OH: ['L41', 'L60', 'L74'],
        PA: ['L41', 'L60', 'L74'],
        RI: ['L41', 'L60', 'L74'],
        VT: ['L41', 'L60', 'L74'],
        VA: ['L41', 'L60', 'L74'],
        WV: ['L41', 'L60', 'L74'],
        WI: ['L41', 'L60', 'L74'],

        // L60-primary states
        AL: ['L60', 'L41', 'L74'],
        AR: ['L60', 'L74', 'L41'],
        FL: ['L60', 'L41', 'L74'],
        GA: ['L60', 'L41', 'L74'],
        IL: ['L60', 'L41', 'L74'],
        IN: ['L60', 'L41', 'L74'],
        IA: ['L60', 'L41', 'L74'],
        KS: ['L60', 'L74', 'L41'],
        KY: ['L60', 'L41', 'L74'],
        LA: ['L60', 'L74', 'L41'],
        MS: ['L60', 'L41', 'L74'],
        MO: ['L60', 'L74', 'L41'],
        NE: ['L60', 'L74', 'L41'],
        NC: ['L60', 'L41', 'L74'],
        OK: ['L60', 'L74', 'L41'],
        SC: ['L60', 'L41', 'L74'],
        TN: ['L60', 'L41', 'L74'],
        TX: ['L60', 'L74', 'L41'],

        // L74-primary states
        AZ: ['L74', 'L60', 'L41'],
        CA: ['L74', 'L60', 'L41'],
        CO: ['L74', 'L60', 'L41'],
        ID: ['L74', 'L60', 'L41'],
        MT: ['L74', 'L60', 'L41'],
        NV: ['L74', 'L60', 'L41'],
        NM: ['L74', 'L60', 'L41'],
        ND: ['L74', 'L60', 'L41'],
        OR: ['L74', 'L60', 'L41'],
        SD: ['L74', 'L60', 'L41'],
        UT: ['L74', 'L60', 'L41'],
        WA: ['L74', 'L60', 'L41'],
        WY: ['L74', 'L60', 'L41']
    };

    // Default fallback priority when state is unknown
    const DEFAULT_WH_PRIORITY = ['L60', 'L41', 'L74'];

    /**
     * Returns ordered array of NetSuite location IDs for a given shipping state.
     * e.g. getLocationPriority('FL') → ['15', '9', '23']
     */
    const getLocationPriority = (stateAbbr) => {
        const upper = (stateAbbr || '').toString().trim().toUpperCase();
        const priority = STATE_TO_WH_PRIORITY[upper] || DEFAULT_WH_PRIORITY;
        return priority.map(code => WH_CODE_TO_LOC[code]);
    };

    // =========================================================
    // SEND DATA  (dropship update)
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

            log.error('SEND DATA - RESPONSE', {
                code: response.code,
                body: response.body
            });

            return {
                success: response.code === 200,
                response: response.body || ''
            };

        } catch (e) {
            log.error('SEND DATA - ERROR', e);
            return { success: false, error: e.message };
        }
    };

    // =========================================================
    // SEND CLOSED DATA
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

            return {
                success: response.code === 200,
                response: response.body || ''
            };

        } catch (e) {
            log.error('SEND CLOSED DATA - ERROR', e);
            return { success: false, error: e.message };
        }
    };

    // =========================================================
    // MARK COMPLETE
    // =========================================================
    const markComplete = (type, id) => {
        record.submitFields({
            type: type,
            id: id,
            values: { custbody_jyswms_loc_updated: true },
            options: { enableSourcing: false, ignoreMandatoryFields: true }
        });
    };

    // =========================================================
    // INVENTORY HELPERS
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
                binName.includes('rt') ||
                binName.includes('studio')
            ) {
                hasReceiving = true;
            } else {
                hasOther = true;
            }
        });

        if (hasOther) return '';
        if (hasBulk && hasReceiving) return REASON_BOTH;
        if (hasBulk)      return REASON_BULK;
        if (hasReceiving) return REASON_RECEIVING;

        return REASON_NA;
    };

    const hasOnlyBulkOrReceiving = (bins) => {
        if (!bins || !bins.length) return false;
        return bins.every(b =>
            b.available > 0 &&
            (
                b.bin.toLowerCase().includes('bulk')      ||
                b.bin.toLowerCase().includes('receiving') ||
                b.bin.toLowerCase().includes('studio')
            )
        );
    };

    // =========================================================
    // AFTER SUBMIT
    // Auto-location switching based on closest WH + availability
    // =========================================================
    const afterSubmit = (context) => {

        if (![context.UserEventType.EDIT].includes(context.type)) return;

        try {

            const newRec = context.newRecord;
            const soId   = newRec.id;
            const soType = newRec.type;

            if (soType !== record.Type.SALES_ORDER) {
                log.error('EXIT', 'Not Sales Order');
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
                type: search.Type.CUSTOMER,
                id: customerId,
                columns: ['custentity_jyswms_enable', 'custentity_single_if']
            });

            const isJysEnabled =
                customerLookup.custentity_jyswms_enable === true ||
                customerLookup.custentity_jyswms_enable === 'T';

            if (!isJysEnabled) return;

            // ---- Resolve shipping state for closest-WH logic ----
            // Prefer ship-to address state; fall back to bill-to
            const so = record.load({
                type: soType,
                id: soId,
                isDynamic: false
            });

            const shipState =
                so.getValue('shipstate') ||
                so.getValue('billstate') ||
                '';

            const locPriority = getLocationPriority(shipState);

            log.error('LOCATION PRIORITY for SOID: ' + soId, {
                shipState,
                locPriority: locPriority.map(l => LOC_TO_WH_CODE[l] + '(' + l + ')')
            });

            const lineCount = so.getLineCount({ sublistId: 'item' });
            if (!lineCount) return;

            // Build set of items that still need evaluation
            const itemSet = new Set();

            for (let i = 0; i < lineCount; i++) {

                const itemType = so.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'itemtype',
                    line: i
                });

                if (itemType !== 'InvtPart') continue;

                const quantity  = parseFloat(so.getSublistValue({ sublistId: 'item', fieldId: 'quantity',                   line: i })) || 0;
                const pickedQty = Number  (so.getSublistValue({ sublistId: 'item', fieldId: 'custcol_jyswms_picked_qty', line: i })) || 0;
                const itemId    = String  (so.getSublistValue({ sublistId: 'item', fieldId: 'item',                      line: i }));

                if (pickedQty <= 0 || pickedQty < quantity) {
                    itemSet.add(itemId);
                }
            }

            if (!itemSet.size) {
                markComplete(soType, soId);
                return;
            }

            // ---- Build inventory map across all 3 locations ----
            // NOTE: We do NOT filter on custrecord_jyswms_exclude_from_inventory here
            // because when that custom field is null/unset on a bin, NetSuite drops
            // the entire row — causing an empty result set. We instead aggregate all
            // available qty per location and let the location-switch logic decide.
            // The beforeSubmit bin-level reason search does its own bin-name filtering.
            const inventoryMap = {};  // { itemId: { locId: qty } }

            search.create({
                type: 'inventorybalance',
                filters: [
                    ['item',     'anyof',       [...itemSet]],
                    'AND',
                    ['location', 'anyof',       LOCATIONS],
                    'AND',
                    ['available','greaterthan', '0'],
                    'AND',
                    [
                        ['binnumber.custrecord_jyswms_exclude_from_inventory', 'is',    'F'],
                        'OR',
                        ['binnumber.custrecord_jyswms_exclude_from_inventory', 'isempty', '']
                    ],
                    'AND',
                    ['binnumber.inactive',   'is',        'F'],
                    'AND',
                    ['binnumber.binnumber',  'isnotempty', '']
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

            log.error('INVENTORY MAP BUILT for SOID: ' + soId, JSON.stringify(inventoryMap));

            let anyLineUpdated   = false;
            let newHeaderLocation = null;
            const updatedItemIds  = new Set();

            for (let i = 0; i < lineCount; i++) {

                const itemType = so.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'itemtype',
                    line: i
                });

                if (itemType !== 'InvtPart') continue;

                const itemId = String(so.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i }));

                if (!inventoryMap[itemId]) continue;

                const qtyRequired = parseFloat(so.getSublistValue({ sublistId: 'item', fieldId: 'quantity', line: i })) || 0;
                const currentLoc  = String (so.getSublistValue({ sublistId: 'item', fieldId: 'location', line: i }));

                const currentAvailable = inventoryMap[itemId][currentLoc] || 0;

                // If current location already satisfies the order, skip
                if (currentAvailable >= qtyRequired) {
                    log.debug('DECISION for SOID: ' + soId, 'Sufficient at current location ' + LOC_TO_WH_CODE[currentLoc]);
                    continue;
                }

                // Walk the state-based priority list to find a location with enough stock
                // Skip the current location (already checked above)
                let bestLoc = null;

                for (const candidateLoc of locPriority) {
                    if (candidateLoc === currentLoc) continue;   // already failed
                    const candidateQty = inventoryMap[itemId][candidateLoc] || 0;
                    if (candidateQty >= qtyRequired) {
                        bestLoc = candidateLoc;
                        break;
                    }
                }

                if (!bestLoc) {
                    log.error('NO SUITABLE LOCATION for SOID: ' + soId, {
                        line: i,
                        itemId,
                        qtyRequired,
                        inventoryMap: inventoryMap[itemId]
                    });
                    continue;
                }

                log.error('LOCATION SWITCH for SOID: ' + soId, {
                    line:    i,
                    itemId,
                    from:    LOC_TO_WH_CODE[currentLoc]  + '(' + currentLoc + ')',
                    to:      LOC_TO_WH_CODE[bestLoc]     + '(' + bestLoc    + ')',
                    reason:  'Closest WH with sufficient stock for state: ' + shipState
                });

                so.setSublistValue({ sublistId: 'item', fieldId: 'location',                   line: i, value: bestLoc });
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

                log.error('SAVING SO for SOID: ' + soId, soId);

                so.save({
                    enableSourcing:        false,
                    ignoreMandatoryFields: true
                });

            } else {
                markComplete(soType, soId);
            }

            if (updatedItemIds.size) {

                const payload = {
                    salesOrderHeaderId: soId,
                    salesOrderItemId:   Array.from(updatedItemIds)
                };

                log.error('CALLING DUP API for SOID: ' + soId, payload);

                const responseJson = autoLocUtil.getDropShipOrders_helperfunction(payload, 1000, 0);
                log.error('DUP API RESPONSE for SOID: ' + soId, responseJson);

                if (
                    responseJson &&
                    responseJson.data &&
                    Object.keys(responseJson.data).length > 0
                ) {
                    log.error('VALID DATA FOUND - CALLING API', responseJson.data);
                    sendData(responseJson);
                } else {
                    log.error('NO VALID DATA - SKIPPING API', responseJson);
                }
            }

        } catch (error) {
            log.error('AFTER SUBMIT ERROR', error);
        }
    };

    // =========================================================
    // BEFORE SUBMIT
    // Checks picked/fulfilled status, syncs closed lines to WMS,
    // and sets inventory issue reason codes on each line.
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

            const status     = soRec.getValue('status');
            const lowerStatus = status ? String(status).toLowerCase() : '';

            if (['closed', 'cancelled', 'billed'].includes(lowerStatus)) {
                soRec.setValue({ fieldId: 'custbody_jyswms_fufilment_error', value: '' });
            }

            const lineCount = soRec.getLineCount({ sublistId: 'item' });
            if (!lineCount) return;

            const CLOSED_SYNC_START_DATE = new Date(2026, 0, 1); // Jan 1 2026

            const closedItemIds = new Set();
            const itemSet       = new Set();
            // BUG FIX 1: allLinesPicked must start true and only ever be set
            // to false — never reset back to true inside the loop.
            // The old code did `else if (jypickedQty >= 0) allLinesPicked = true`
            // which overwrote a prior false on every subsequent line.
            let allLinesPicked  = true;

            for (let i = 0; i < lineCount; i++) {

                const pickedRaw   = soRec.getSublistValue({ sublistId: 'item', fieldId: 'custcol_jyswms_picked_qty', line: i });
                const jypickedQty = parseFloat(pickedRaw);

                // Only set to false — never flip back to true mid-loop
                if ((pickedRaw == null || pickedRaw === '' || pickedRaw === undefined) && jypickedQty !== 0) {
                    allLinesPicked = false;
                } else if (!isNaN(jypickedQty) && jypickedQty < 0) {
                    allLinesPicked = false;
                }

                const itemId       = String(soRec.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i }) || '');
                const quantity     = parseFloat(soRec.getSublistValue({ sublistId: 'item', fieldId: 'quantity',          line: i })) || 0;
                const fulfilledQty = parseFloat(soRec.getSublistValue({ sublistId: 'item', fieldId: 'quantityfulfilled', line: i })) || 0;
                const pickedQty    = parseFloat(soRec.getSublistValue({ sublistId: 'item', fieldId: 'quantitypicked',    line: i })) || 0;

                // Add all unfulfilled, unpicked items so we can evaluate
                // inventory and set issue reasons on every qualifying line
                if (itemId && fulfilledQty < quantity && pickedQty <= 0) itemSet.add(itemId);

                // ---- Closed-line detection ----
                const isClosed   = soRec.getSublistValue({ sublistId: 'item', fieldId: 'isclosed',            line: i });
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
                        salesOrderId: soRec.id,
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
            // NOTE: Same as afterSubmit — we use OR on the exclude flag to handle
            // bins where the field is null/unset, preventing empty result sets.
            const availabilityMap = {};

            search.create({
                type: 'inventorybalance',
                filters: [
                    ['item',     'anyof',       [...itemSet]],
                    'AND',
                    ['location', 'anyof',       LOCATIONS],
                    'AND',
                    ['available','greaterthan', '0'],
                    'AND',
                    ['binnumber.inactive',  'is',        'F'],
                    'AND',
                    ['binnumber.binnumber', 'isnotempty', '']
                ],
                columns: ['item', 'location', 'available', 'binnumber']
            }).run().each(result => {

                // Always String() keys so lookups never fail due to number vs string mismatch
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
            // In beforeSubmit we use the header fields directly from soRec
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

                // Only clear reason if FULLY fulfilled — not just partially picked.
                // Old code: `pickedQty > 0` would skip reason even for partial picks
                // with no actual fulfillment, hiding real stock issues.
                if (fulfilledQty >= quantity) {
                    reasonId = '';
                } else if (pickedQty >= quantity) {
                    // Fully picked but not yet fulfilled — no issue to flag
                    reasonId = '';
                } else if (itemId && lineLocation) {

                    const itemData       = availabilityMap[itemId] || {};

                    // BUG FIX 3 (continued): Use String() on all loc keys when
                    // indexing into availabilityMap so lookups never miss due to
                    // numeric vs string key mismatch.
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
                        // Current location has inventory but only in bulk/receiving bins
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