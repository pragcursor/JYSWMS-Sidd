/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 *
 * Inventory status logic (per item line location):
 *   - In Stock                              → normal bin qty >= SO qty required
 *   - Inventory Not Sufficient              → normal bin qty > 0 but < SO qty required
 *   - In Bulk / Receiving Bin              → normal bin qty = 0, but excluded bins have stock at this location
 *   - Not In Stock                          → zero qty in ALL bins (normal + excluded) at this location
 *
 * SO status handling:
 *   - Billed / Closed / no open lines      → returned cleanly as soStatus, no error thrown
 */
define(['N/query', 'N/search', 'N/log'], (query, search, log) => {

    // ─── Generic paged N/search runner ────────────────────────────────────────
    const runPagedSearch = (searchObj) => {
        const results = [];
        const paged = searchObj.runPaged({ pageSize: 1000 });
        paged.pageRanges.forEach((range) => {
            paged.fetch({ index: range.index }).data.forEach((r) => results.push(r));
        });
        return results;
    };

    // ─── STEP 1: SO Header via SuiteQL ────────────────────────────────────────
    const fetchSOHeader = (soId) => {
        const rows = query.runSuiteQL({
            query: `
                SELECT
                    T.id                    AS soInternalId,
                    T.tranid                AS soNumber,
                    BUILTIN.DF(T.entity)    AS customerName,
                    BUILTIN.DF(T.status)    AS soStatus
                FROM Transaction T
                WHERE T.id   = ?
                AND   T.type = 'SalesOrd'
            `,
            params: [soId]
        }).asMappedResults();

        if (!rows.length) throw new Error(`No Sales Order found with internal ID ${soId}`);
        return rows[0];
    };

    // ─── STEP 2: Unfulfilled SO lines via N/search ─────────────────────────────
    // Uses N/search because quantitybilled (fulfilled qty) is NOT exposed in SuiteQL TransactionLine
    const fetchUnfulfilledLines = (soId) => {
        const skipTypes = ['Subtotal', 'Description', 'Discount', 'Markup', 'Payment'];

        const results = runPagedSearch(search.create({
            type: search.Type.TRANSACTION,
            filters: [
                ['internalid', 'anyof', soId], 'AND',
                ['mainline', 'is', 'F'], 'AND',
                ['taxline', 'is', 'F'], 'AND',
                ['shipping', 'is', 'F'], 'AND',
                ['type', 'anyof', 'SalesOrd']
            ],
            columns: [
                search.createColumn({ name: 'line' }),
                search.createColumn({ name: 'item' }),
                search.createColumn({ name: 'itemtype' }),
                search.createColumn({ name: 'quantity' }),
                search.createColumn({ name: 'quantitybilled' }),  // fulfilled/shipped qty on SO
                search.createColumn({ name: 'quantitycommitted' }),
                search.createColumn({ name: 'location' })
            ]
        }));

        const lines = [];
        results.forEach((result) => {
            const itemType = result.getText({ name: 'itemtype' }) || '';
            if (skipTypes.includes(itemType)) return;

            const itemId = result.getValue({ name: 'item' });
            if (!itemId) return;

            const qtyOrdered = parseFloat(result.getValue({ name: 'quantity' }) || 0);
            const qtyFulfilled = parseFloat(result.getValue({ name: 'quantitybilled' }) || 0);
            const qtyRemaining = qtyOrdered - qtyFulfilled;

            if (qtyRemaining <= 0) return; // fully fulfilled line — skip

            lines.push({
                itemId: String(itemId),
                itemName: result.getText({ name: 'item' }),
                locationId: String(result.getValue({ name: 'location' }) || ''),
                locationName: result.getText({ name: 'location' }) || 'No Location',
                qtyOrdered,
                qtyFulfilled,
                qtyRemaining
            });
        });

        return lines;
    };

    // ─── STEP 3: Custom SO checkbox via search.lookupFields ───────────────────
    const fetchAutoLocFlag = (soId) => {
        try {
            const fields = search.lookupFields({
                type: search.Type.SALES_ORDER,
                id: soId,
                columns: ['custbody_jyswms_enable_auto_loc_chng']
            });
            return fields.custbody_jyswms_enable_auto_loc_chng === true;
        } catch (e) {
            log.error('fetchAutoLocFlag', e.message);
            return false;
        }
    };

    // ─── STEP 4: Inventory balance — N/search runPaged ────────────────────────
    // Builds Map: itemId → locationId → { normalAvailable, excludedQty, excludedBins[] }
    // normalAvailable = qty in bins where excludeFromInventory = No (false)
    // excludedQty     = qty in bins where excludeFromInventory = Yes (true) — Bulk/Stage bins
    const fetchInventoryMap = (itemIds) => {
        const inventoryMap = new Map();
        if (!itemIds.length) return inventoryMap;

        const results = runPagedSearch(search.create({
            type: 'inventorybalance',
            filters: [['item', 'anyof', itemIds]],
            columns: [
                search.createColumn({ name: 'item' }),
                search.createColumn({ name: 'location' }),
                search.createColumn({ name: 'available' }),
                search.createColumn({ name: 'binnumber' }),
                search.createColumn({
                    name: 'custrecord_jyswms_exclude_from_inventory',
                    join: 'binNumber'
                })
            ]
        }));

        results.forEach((result) => {
            const itemId = result.getValue({ name: 'item' });
            const locationId = result.getValue({ name: 'location' });
            const available = parseFloat(result.getValue({ name: 'available' }) || 0);
            const binNumber = result.getText({ name: 'binnumber' });
            const binId = result.getValue({ name: 'binnumber' });

            // Get BOTH value and text — NetSuite can return different types
            // for checkbox fields on joined records
            const excludeVal = result.getValue({
                name: 'custrecord_jyswms_exclude_from_inventory',
                join: 'binNumber'
            });
            const excludeText = result.getText({
                name: 'custrecord_jyswms_exclude_from_inventory',
                join: 'binNumber'
            });

            // Handle all possible return formats NetSuite might use:
            // boolean true, string 'T', string 'true', text 'Yes'
            const isExcluded = excludeVal === true
                || excludeVal === 'T'
                || excludeVal === 'true'
                || excludeText === 'Yes'
                || excludeText === 'yes';

            log.debug('BIN', JSON.stringify({
                binNumber, available, excludeVal, excludeText, isExcluded
            }));

            if (!inventoryMap.has(itemId)) inventoryMap.set(itemId, new Map());
            const locMap = inventoryMap.get(itemId);
            if (!locMap.has(locationId)) locMap.set(locationId, {
                normalAvailable: 0,
                excludedQty: 0,
                excludedBins: []
            });
            const locData = locMap.get(locationId);

            if (isExcluded) {
                locData.excludedQty += available;
                if (binId && available > 0) {
                    locData.excludedBins.push({ binNumber, available });
                }
            } else {
                locData.normalAvailable += available;
            }
        });

        return inventoryMap;
    };

    // ─── STEP 5: Resolve inventory status per SO line ─────────────────────────
    // All checks are scoped to the SO line's assigned location only
    const resolveInventoryStatus = (line, inventoryMap) => {
        const locData = inventoryMap.get(line.itemId)?.get(line.locationId);

        // Case 1: No inventory record at all for this item at this location
        if (!locData) {
            return {
                inventoryStatus: 'Not In Stock',
                qtyAvailable: 0
            };
        }

        const { normalAvailable, excludedQty, excludedBins } = locData;

        // Case 2: Pickable stock exists in normal bins at this location
        if (normalAvailable > 0) {
            return {
                inventoryStatus: normalAvailable >= line.qtyRemaining
                    ? 'In Stock'
                    : 'Inventory Not Sufficient for Sales Order Qty',
                qtyAvailable: normalAvailable
            };
        }

        // Case 3: Zero pickable stock, but stock exists in excluded (Bulk/Stage) bins
        // → Item is physically present at the location but not yet in a pickable bin
        if (excludedQty > 0) {
            return {
                inventoryStatus: 'In Bulk / Receiving Bin',
                qtyAvailable: 0,
                excludedBins             // show which bins so warehouse knows where to look
            };
        }

        // Case 4: Truly zero stock at this location in any bin
        return {
            inventoryStatus: 'Not In Stock',
            qtyAvailable: 0
        };
    };

    // ─── Suitelet entry point ─────────────────────────────────────────────────
    const onRequest = (context) => {
        context.response.setHeader({ name: 'Content-Type', value: 'application/json' });

        try {
            const soId = context.request.parameters.record_id;
            if (!soId) throw new Error('Missing required parameter: record_id');

            // 1. Get SO header — always return it regardless of status
            const header = fetchSOHeader(soId);

            // 2. Get unfulfilled lines — if none, return clean response (not an error)
            const lines = fetchUnfulfilledLines(soId);

            if (!lines.length) {
                // SO is Billed / Closed / fully fulfilled — return clean JSON, no error
                context.response.write(JSON.stringify({
                    soNumber: header.sonumber,
                    internalId: String(header.sointernalid),
                    customerName: header.customername,
                    soStatus: header.sostatus,
                    items: [],
                    autoLocationChange: false,
                    note: 'No open unfulfilled lines found on this Sales Order'
                }, null, 2));
                return;
            }

            // 3. Fetch custom checkbox
            const autoLocChange = fetchAutoLocFlag(soId);

            // 4. Fetch inventory for all unique items on this SO
            const uniqueItemIds = [...new Set(lines.map((l) => l.itemId))];
            const inventoryMap = fetchInventoryMap(uniqueItemIds);

            // 5. Build item results
            const items = lines.map((line) => {
                const statusResult = resolveInventoryStatus(line, inventoryMap);
                const row = {
                    item: line.itemName,
                    location: line.locationName,
                    qtyRequired: line.qtyRemaining,
                    qtyAvailable: statusResult.qtyAvailable,
                    inventoryStatus: statusResult.inventoryStatus
                };
                // Only include excludedBins when status is 'In Bulk / Receiving Bin'
                if (statusResult.excludedBins?.length) {
                    row.excludedBins = statusResult.excludedBins;
                }
                return row;
            });

            context.response.write(JSON.stringify({
                soNumber: header.sonumber,
                internalId: String(header.sointernalid),
                customerName: header.customername,
                soStatus: header.sostatus,
                items,
                autoLocationChange: autoLocChange
            }, null, 2));

        } catch (e) {
            log.error('Suitelet Error', `${e.message} | ${e.stack}`);
            context.response.write(JSON.stringify({ error: e.message }));
        }
    };

    return { onRequest };
});