/**
 * Forbes Travel Guide - Simplified Form System
 * 
 * This system manages a dual-mode form:
 * 1. Partner Early-Access Code Lookup - Auto-populate from 8-character codes
 * 2. Establishment Name Lookup - Search via autocomplete
 */

// No imports needed - Autocomplete will be available globally after loading the script

// Configuration (override via window.FTG_CONFIG without editing this file)
const DEFAULT_CONFIG = {
    AIRTABLE_BASE_ID: 'appC9GXdjmEmFlNk7',
    AIRTABLE_TABLE: 'tbl4YQBCXN4f2WREk', // Updated to match proxy example
    AIRTABLE_PROXY_URL: 'https://ftg-proxy-tq3re.ondigitalocean.app/api/query',
    DEBUG: false,
};
const CFG = { ...DEFAULT_CONFIG, ...(window.FTG_CONFIG || {}) };

// Airtable Proxy Configuration
const AIRTABLE_BASE_ID = CFG.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE = CFG.AIRTABLE_TABLE;
const AIRTABLE_PROXY_URL = CFG.AIRTABLE_PROXY_URL;

// Debug flag (toggle to silence verbose logs in production)
const DEBUG = !!CFG.DEBUG;

// Mode configuration centralized
const MODES = {
    'Partner Early-Access Code Lookup': {
        hide: [],
        prevent: ['establishmentType', 'partnerStatus', 'awardLevel', 'dutiesAndTaxes', 'officialEstablishmentName']
    },
    'Establishment Name Lookup': {
        hide: ['redemptionCode'],
        prevent: ['establishmentType', 'partnerStatus', 'awardLevel', 'dutiesAndTaxes']
    }
};

// Simple in-memory cache for Airtable queries (LRU-lite)
const airtableCache = new Map();
const MAX_CACHE = 50;

function cacheGet(key) {
    if (!airtableCache.has(key)) return null;
    const val = airtableCache.get(key);
    // Refresh recency
    airtableCache.delete(key);
    airtableCache.set(key, val);
    return val;
}
function cacheSet(key, value) {
    if (airtableCache.has(key)) airtableCache.delete(key);
    airtableCache.set(key, value);
    if (airtableCache.size > MAX_CACHE) {
        const first = airtableCache.keys().next().value;
        airtableCache.delete(first);
    }
}

// Debounce utility
function debounce(fn, delay = 300) {
    let t; return function(...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), delay); };
}


// Module-level state
let fields = {};
let currentMode = 'Partner Early-Access Code Lookup';
let autocompleteInstance = null;
// Track last valid selection for establishment name to know when to invalidate
let lastSelectedEstablishment = { id: null, name: null };
// Controllers for canceling in-flight requests
let nameSearchController = null;
let codeLookupController = null;
// Prevent showing duplicate blocking alerts in rapid succession
let mismatchAlertDispatched = false;
// Cached form element for submit gating
let formEl = null;

/**
 * Reset all dependent form fields to defaults while preserving the provided exclusions
 * (typically the currently edited text fields).
 */
function resetDependentFields(exclusions = []) {
    const excludeSet = new Set(exclusions);
    resetFields(exclusions);
    // Ensure Custom Establishment Name is cleared unless explicitly excluded
    if (!excludeSet.has('customEstablishmentName') && fields.customEstablishmentName?.input) {
        fields.customEstablishmentName.input.value = '';
    }
    // Forget last valid selection
    lastSelectedEstablishment.id = null;
    lastSelectedEstablishment.name = null;
    // Update submit gating
    updateFormSubmitState();
}

// Map visible label text -> internal field key
// Keep this minimal; fallback logic below handles minor label variations
const FIELD_LABEL_TO_KEY = {
    'Partner Early-Access Code': 'redemptionCode',
    'Official Establishment Name': 'officialEstablishmentName',
    'Custom Establishment Name': 'customEstablishmentName',
    'Establishment Type': 'establishmentType',
    'Partner Status': 'partnerStatus',
    'Award Level': 'awardLevel',
    'Duties & Taxes': 'dutiesAndTaxes'
};

/**
 * Scan the DOM for `.form-item` wrappers and build the fields map.
 * Idempotent: safe to call on dynamic content updates.
 */
function initializeFields() {
    fields = {}; // reset in case of re-init
    const items = document.querySelectorAll('.form-item');
    items.forEach(item => {
        const label = item.querySelector('label');
        if (!label) return;
        // Capture the visible text minus any required markers / child spans
        let rawText = (label.textContent || '').trim().replace(/\s+/g, ' ');
        // Remove common adornments like '(required)' or trailing colons
        rawText = rawText.replace(/\(required\)/i, '').replace(/:$/, '').trim();

        let key = FIELD_LABEL_TO_KEY[rawText];

        // Fallback 1: partial (startsWith) match for labels that append required markers or other text
        if (!key) {
            for (const [knownLabel, mappedKey] of Object.entries(FIELD_LABEL_TO_KEY)) {
                if (rawText.toLowerCase().startsWith(knownLabel.toLowerCase())) {
                    key = mappedKey; break;
                }
            }
        }

        // Derive from select[data-name] if still not matched
        const selectEl = item.querySelector('select');
        if (!key && selectEl && selectEl.getAttribute('data-name')) {
            const dataName = selectEl.getAttribute('data-name').trim();
            key = FIELD_LABEL_TO_KEY[dataName] || Object.entries(FIELD_LABEL_TO_KEY).find(([k]) => dataName.toLowerCase() === k.toLowerCase())?.[1];
        }

        if (!key) {
            if (DEBUG) console.warn('Unmapped form-item label text:', rawText, item);
            return; // ignore unrelated form-items
        }
        const input = item.querySelector('input');
    const select = selectEl; // selectEl already queried above
        fields[key] = { label, wrapper: item, input, select };
    });
    if (DEBUG) console.log('Initialized fields (scanned .form-item):', Object.keys(fields));
    setMode(currentMode);
}

// Helper to safely retrieve a field object
function getField(name) {
    return fields[name] || null;
}

// Bulk reset with optional exclusions
function resetFields(exclusions = []) {
    const excludeSet = new Set(exclusions);
    Object.entries(fields).forEach(([name, fieldObj]) => {
        if (excludeSet.has(name)) return;
        resetField(fieldObj);
    });
}

/**
 * Apply a UI mode by hiding/locking fields as configured.
 */
function setMode(mode) {
    currentMode = mode;
    const config = MODES[mode] || { hide: [], prevent: [] };
    hideElements(config.hide);
    preventInteraction(config.prevent);
}

function hideElements(fieldNames) {
    fieldNames.forEach(fieldName => {
        const field = fields[fieldName];
        if (field?.wrapper) {
            field.wrapper.style.display = 'none';
        }
    });
}

function preventInteraction(fieldNames) {
    fieldNames.forEach(fieldName => {
        const field = fields[fieldName];
        if (!field) {
            if (DEBUG) console.warn(`Requested to prevent interaction on unknown field key: ${fieldName}`);
            return;
        }
    logger('debug', 'preventInteraction', `Preventing interaction with field: ${fieldName}`);
        preventEdit(field);
    });
}

/**
 * Wire Bootstrap 5 Autocomplete to the Official Establishment Name input.
 */
function addEstablishmentNameListener() {
    if (autocompleteInstance) return; // avoid duplicate init
    const officialEstablishmentNameField = fields['officialEstablishmentName']?.input;
    if (!officialEstablishmentNameField) {
        console.warn('Establishment name field not found for autocomplete');
        return;
    }
    if (typeof window.Autocomplete === 'undefined') {
        console.warn('Autocomplete class not available yet. Make sure the module wrapper is loaded.');
        return;
    }
    if (DEBUG) console.log('Setting up Bootstrap 5 autocomplete for establishment name field');
    try {
        const parentForSpinner = officialEstablishmentNameField.parentNode;
        autocompleteInstance = new window.Autocomplete(officialEstablishmentNameField, {
            source: debounce((query, callback) => {
                if (DEBUG) console.log('Autocomplete source called with query:', query);
                if (!parentForSpinner) { if (callback) callback([]); return []; }
                // Clear any previous no-results message when typing
                removeNoResultsMessage(parentForSpinner);
                removeInlineErrorMessage(parentForSpinner);
                showInlineSpinner(parentForSpinner, { position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)' });
                if (query.length < 2) {
                    if (DEBUG) console.log('Query too short, returning empty results');
                    removeInlineSpinner(parentForSpinner);
                    removeNoResultsMessage(parentForSpinner);
                    removeInlineErrorMessage(parentForSpinner);
                    if (callback) callback([]);
                    return [];
                }
                // Cancel any in-flight search
                if (nameSearchController) try { nameSearchController.abort(); } catch(e) { /* noop */ }
                nameSearchController = new AbortController();
                const signal = nameSearchController.signal;
                return searchAirtableForAutocomplete(query, signal)
                    .then(results => {
                        if (DEBUG) console.log('Autocomplete results:', results);
                        removeInlineSpinner(parentForSpinner);
                        removeInlineErrorMessage(parentForSpinner);
                        if (!Array.isArray(results) || results.length === 0) {
                            showNoResultsMessage(parentForSpinner, query, 'name');
                        } else {
                            removeNoResultsMessage(parentForSpinner);
                        }
                        if (callback) callback(results);
                        return results;
                    })
                    .catch(error => {
                        // Ignore abort errors (superseded request)
                        if (error && (error.name === 'AbortError' || error.code === 20)) {
                            removeInlineSpinner(parentForSpinner);
                            return [];
                        }
                        console.error('Error in autocomplete source:', error);
                        removeInlineSpinner(parentForSpinner);
                        removeNoResultsMessage(parentForSpinner);
                        const offline = typeof navigator !== 'undefined' && navigator && navigator.onLine === false;
                        const msg = offline ? 'You appear to be offline. Check your connection and try again.' : 'Something went wrong fetching results. Please try again.';
                        showInlineErrorMessage(parentForSpinner, msg);
                        if (callback) callback([]);
                        return [];
                    });
            }, 250),
            onSelectItem: (item) => {
                if (DEBUG) console.log('Selected establishment:', item);
                if (item.data) {
                    removeNoResultsMessage(parentForSpinner);
                    removeInlineErrorMessage(parentForSpinner);
                    handleRedemptionCodeSelection(item.data);
                    // Mark last valid name selection so edits can invalidate
                    lastSelectedEstablishment.id = item.data.id || null;
                    lastSelectedEstablishment.name = item.data.fields?.['Official Establishment Name'] || officialEstablishmentNameField.value || null;
                    updateFormSubmitState();
                } else {
                    console.warn('No data found for selected item');
                }
            },
            minLength: 2,
            maximumItems: 10,
            highlightTyped: true,
            showValue: false,
            showAllSuggestions: false
        });
    if (DEBUG) console.log('Bootstrap 5 Autocomplete instance created successfully');
        // Invalidate previously populated fields if user edits/clears without a valid selection
    officialEstablishmentNameField.addEventListener('input', debounce(() => {
            const current = (officialEstablishmentNameField.value || '').trim();
            if (lastSelectedEstablishment.name && current !== lastSelectedEstablishment.name) {
        // Reset all but the primary text inputs (keep what user typed)
        resetDependentFields(['officialEstablishmentName', 'redemptionCode']);
            }
            if (!current) {
        resetDependentFields(['officialEstablishmentName', 'redemptionCode']);
            }
        }, 250));
        officialEstablishmentNameField.addEventListener('blur', () => {
            const current = (officialEstablishmentNameField.value || '').trim();
            if (!current || (lastSelectedEstablishment.name && current !== lastSelectedEstablishment.name)) {
        resetDependentFields(['officialEstablishmentName', 'redemptionCode']);
            }
        });
    } catch (error) {
        console.error('Error creating autocomplete instance:', error);
    }
}

/**
 * Listen for Partner Early-Access Code input; when exactly 8 chars, query and populate.
 */
function addRedemptionCodeListener() {
    const redemptionCodeField = fields['redemptionCode']?.input;
    if (!redemptionCodeField) return;
    const handleInput = async (event) => {
    const code = event.target.value.trim();
    // Reset all other fields except the code itself
    resetFields(['redemptionCode']);
    // Clear any previous no-results message
    removeNoResultsMessage(redemptionCodeField.parentNode);
        removeInlineErrorMessage(redemptionCodeField.parentNode);
        const existingHelpText = redemptionCodeField.parentNode.querySelector('.help-text');
        if (existingHelpText) {
            existingHelpText.remove();
        }
    // Cancel any in-flight code lookup when input changes
    if (codeLookupController) try { codeLookupController.abort(); } catch(e) { /* noop */ }
    if (code.length !== 8) {
            const helpText = document.createElement('div');
            helpText.className = 'help-text';
            helpText.style.cssText = 'color: red; font-size: 12px; margin-top: 5px;';
            helpText.textContent = 'Please check Partner Early-Access Code length. It must be exactly 8 characters.';
            redemptionCodeField.parentNode.appendChild(helpText);
            // Invalidate prior populated values if any
            resetDependentFields(['redemptionCode', 'officialEstablishmentName']);
        }
        if (code.length === 8) {
            if (DEBUG) console.log('Partner Early-Access Code entered:', code);
            const parentForSpinner = redemptionCodeField.parentNode;
            showInlineSpinner(parentForSpinner, { position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)' });
            try {
        codeLookupController = new AbortController();
                // Note: Airtable column is still named 'Redemption Code' so we query that field; UI label changed to Partner Early-Access Code
                const data = await queryAirtableContains('Redemption Code', code, codeLookupController.signal);
                    if (data.records.length > 0) {
                    removeNoResultsMessage(redemptionCodeField.parentNode);
                    removeInlineErrorMessage(redemptionCodeField.parentNode);
                    handleRedemptionCodeSelection(data.records[0]);
                    // Track last valid name based on redemption selection
                    lastSelectedEstablishment.id = data.records[0].id || null;
                    lastSelectedEstablishment.name = data.records[0].fields?.['Official Establishment Name'] || fields.officialEstablishmentName?.input?.value || null;
                    if (DEBUG) console.log('Partner Early-Access Code found and form populated');
                    updateFormSubmitState();
                } else {
                    showNoResultsMessage(redemptionCodeField.parentNode, code, 'code');
                    console.warn('No matching record found for Partner Early-Access Code:', code);
                    // Keep typed code, clear dependent selects + custom name
                    resetDependentFields(['redemptionCode', 'officialEstablishmentName']);
                }
            } catch (error) {
                // Ignore abort errors quietly
                if (!(error && (error.name === 'AbortError' || error.code === 20))) {
                    console.error('Error looking up Partner Early-Access Code:', error);
                    removeNoResultsMessage(redemptionCodeField.parentNode);
                    const offline = typeof navigator !== 'undefined' && navigator && navigator.onLine === false;
                    const msg = offline ? 'You appear to be offline. Check your connection and try again.' : 'Something went wrong fetching results. Please try again.';
                    showInlineErrorMessage(redemptionCodeField.parentNode, msg);
                    // On error, also clear dependent values
                    resetDependentFields(['redemptionCode', 'officialEstablishmentName']);
                }
            } finally {
                removeInlineSpinner(parentForSpinner);
            }
        }
    };
    redemptionCodeField.addEventListener('input', debounce(handleInput, 300));
    redemptionCodeField.addEventListener('paste', (event) => {
        setTimeout(() => {
            redemptionCodeField.dispatchEvent(new Event('input', { bubbles: true }));
        }, 100);
    });
}

/**
 * Unified Airtable query via proxy server with simple in-memory caching.
 */
async function queryAirtableContains(field, query, signal) {
    const cleanQuery = (query || '').trim();
    if (!cleanQuery) return { records: [] };
    const cacheKey = `${field}::${cleanQuery.toLowerCase()}`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;
    const url = `${AIRTABLE_PROXY_URL}?AIRTABLE_BASE_ID=${encodeURIComponent(AIRTABLE_BASE_ID)}&AIRTABLE_TABLE=${encodeURIComponent(AIRTABLE_TABLE)}&field=${encodeURIComponent(field)}&q=${encodeURIComponent(cleanQuery)}&maxRecords=10`;
    const response = await fetch(url, { signal });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const data = await response.json();
    cacheSet(cacheKey, data);
    return data;
}

/**
 * Data adapter for Autocomplete: returns [{label, value, data}] from Airtable.
 */
async function searchAirtableForAutocomplete(query, signal) {
    const data = await queryAirtableContains('Official Establishment Name', query, signal);
    if (!data.records) return [];
    return data.records
        .filter(r => {
            const n = r.fields['Official Establishment Name'];
            return n && typeof n === 'string' && n.trim();
        })
        .map(r => {
            const name = r.fields['Official Establishment Name'];
            return { label: name, value: name, data: r };
        });
}

// searchAirtable alias removed — use queryAirtableContains directly

/**
 * Populate related fields from a selected Airtable record.
 */
function handleRedemptionCodeSelection(record) {
    const recFields = record.fields;
    if (recFields['Official Establishment Name']) {
        if (fields.officialEstablishmentName?.input) {
            fields.officialEstablishmentName.input.value = recFields['Official Establishment Name'];
        }
        if (fields.customEstablishmentName?.input) {
            fields.customEstablishmentName.input.value = recFields['Official Establishment Name'];
        }
    }
    const dropdownMappings = {
        'Award Level': 'awardLevel',
        'Establishment Type': 'establishmentType',
        'Partner Status': 'partnerStatus',
        'Duties & Taxes': 'dutiesAndTaxes'
    };
    Object.entries(dropdownMappings).forEach(([fieldName, configName]) => {
        if (recFields[fieldName] && fields[configName]?.select) {
            setSelectValue(fields[configName].select, recFields[fieldName]);
        }
    });
    updateSelectElements(
        recFields['Official Establishment Name'] || '',
        recFields['Partner Status'] || '',
        recFields['Award Level'] || '',
        recFields['Duties & Taxes'] || ''
    );
}

/**
 * Set a select's value by matching on text/value/data-name (case-insensitive).
 * Falls back to an inline mismatch hint if no option can be matched.
 */
function setSelectValue(selectElement, targetValue) {
    if (!selectElement || !targetValue) return false;
    const options = Array.from(selectElement.querySelectorAll('option')).map(o => ({
        el: o,
        text: (o.textContent || '').trim(),
        value: o.value || '',
        dataName: (o.getAttribute('data-name') || '').trim()
    }));
    const tv = targetValue.toLowerCase();
    const matched = options.find(o => [o.text, o.value, o.dataName].some(v => v.toLowerCase() === tv || v.toLowerCase().includes(tv)));
    if (matched) {
        selectElement.value = matched.value;
        matched.el.selected = true;
        if (window.jQuery && window.jQuery(selectElement).hasClass('select2-hidden-accessible')) {
            window.jQuery(selectElement).val(matched.value).trigger('change');
        }
    // Emit single change event (input removed to reduce duplicate listeners firing)
    selectElement.dispatchEvent(new Event('change', { bubbles: true }));
        // Clear mismatch UI if any
        try {
            const wrapper = selectElement.closest('.form-item');
            wrapper?.querySelector('.mismatch-text')?.remove();
            selectElement.removeAttribute('data-mismatch-shown');
        } catch(e) { /* noop */ }
        return true;
    }
    // Fallback mismatch messaging (kept from previous dynamic setter)
    try {
        const wrapper = selectElement.closest('.form-item');
        if (wrapper) {
            let messageElement = wrapper.querySelector('.mismatch-text');
            if (!messageElement) {
                messageElement = document.createElement('div');
                messageElement.className = 'mismatch-text';
                messageElement.style.cssText = 'color: #b00020; font-size: 12px; margin-top: 4px; line-height:1.3;';
                wrapper.appendChild(messageElement);
            }
            // Read label text and remove common adornments like '(required)' or trailing colons
            const rawLabelText = wrapper.querySelector('label')?.textContent || 'Field';
            const labelText = rawLabelText.replace(/\(required\)/i, '').replace(/:$/, '').trim() || 'Field';
            // Normalize establishment value for display (arrays -> joined string)
            const establishmentValue = Array.isArray(targetValue) ? targetValue.join(', ') : String(targetValue);
            messageElement.textContent = `This product does not meet your establishment details. This product does not have "${establishmentValue}" for the option "${labelText}".`;
            // Show blocking alert to the user with the requested message, then clear the form after they click OK
            try {
                if (!mismatchAlertDispatched) {
                    mismatchAlertDispatched = true;
                    const alertMsg = `There is no product option for your {feild type} of {establishment value}. Please change the establishment you are shopping for or chose a product that supports your {feild type} of {establishment value}.`;
                    const populated = alertMsg.replace(/{feild type}/g, labelText).replace(/{establishment value}/g, establishmentValue);
                    window.alert(populated);
                    // allow future alerts after a short cooldown
                    setTimeout(() => { mismatchAlertDispatched = false; }, 1200);
                }
            } catch (e) {
                // If alert fails for some reason, log and continue
                console.error('Failed to show mismatch alert:', e);
            }
            // Clear the form after user dismisses the alert
            try { clearAndResetForm(); } catch (e) { console.error('Failed to clear form after mismatch alert:', e); }
        }
    } catch(e) { /* noop */ }
    // Removed blocking alert to streamline UX; inline message above is sufficient
    return false;
}

function clearAndResetForm() {
    resetFields();
    // Clear any inline UI messages (errors, no-results, spinners, mismatch hints) from the form
    try {
        // Clear at the per-field wrapper level
        Object.values(fields || {}).forEach(fieldObj => {
            try {
                const wrapper = fieldObj?.wrapper || (fieldObj?.input && fieldObj.input.parentNode) || (fieldObj?.select && fieldObj.select.parentNode);
                if (wrapper) {
                    removeInlineErrorMessage(wrapper);
                    removeNoResultsMessage(wrapper);
                    removeInlineSpinner(wrapper);
                    const mismatchHint = wrapper.querySelector('.mismatch-text');
                    if (mismatchHint) mismatchHint.remove();
                }
            } catch (e) { /* noop per-field */ }
        });
        // Also clear any inline messages attached to the form itself
        if (formEl) {
            removeInlineErrorMessage(formEl);
            removeNoResultsMessage(formEl);
            removeInlineSpinner(formEl);
        }
    } catch (e) {
        if (DEBUG) console.error('Error clearing inline messages during form reset:', e);
    }
    const preventList = currentMode === 'Partner Early-Access Code Lookup'
        ? ['establishmentType', 'partnerStatus', 'awardLevel', 'dutiesAndTaxes', 'officialEstablishmentName']
        : ['establishmentType', 'partnerStatus', 'awardLevel', 'dutiesAndTaxes'];
    preventInteraction(preventList);
    if (currentMode !== 'Partner Early-Access Code Lookup' && autocompleteInstance && getField('officialEstablishmentName')?.input) {
        getField('officialEstablishmentName').input.value = '';
    }
}

// Inject minimal CSS once
let loaderStylesInjected = false;
function ensureLoaderStyles() {
    if (loaderStylesInjected) return;
    const css = `/* Loader Utilities */\n.loading-inline-spinner{display:inline-flex;align-items:center;font-size:12px;color:#555;font-family:system-ui,Arial,sans-serif;gap:6px;}\n.loading-inline-spinner .dot{width:6px;height:6px;border-radius:50%;background:#888;animation:ftg-bounce 0.9s infinite ease-in-out;}\n.loading-inline-spinner .dot:nth-child(2){animation-delay:0.15s;}\n.loading-inline-spinner .dot:nth-child(3){animation-delay:0.3s;}\n@keyframes ftg-bounce{0%,80%,100%{opacity:.3;transform:translateY(0);}40%{opacity:1;transform:translateY(-4px);}}\n/* Inline messages */\n.ftg-inline-msg{margin-top:6px;font-size:12px;line-height:1.3;color:#6c757d;font-family:system-ui,Arial,sans-serif;}\n.ftg-inline-msg.no-results{color:#b00020;}\n.ftg-inline-msg.error{color:#b00020;}`;
    const styleTag = document.createElement('style');
    styleTag.setAttribute('data-ftg-loader-styles', '');
    styleTag.textContent = css;
    document.head.appendChild(styleTag);
    loaderStylesInjected = true;
}

// Inline spinner helpers
function showInlineSpinner(container, inlineStyleOverrides = {}) {
    if (!container) return;
    ensureLoaderStyles();
    // Avoid duplicates
    if (container.querySelector(':scope > .loading-inline-spinner')) return;
    // If we plan to absolutely position inside the field, ensure the container can anchor it
    const willBeAbsolute = inlineStyleOverrides && String(inlineStyleOverrides.position || '').toLowerCase() === 'absolute';
    if (willBeAbsolute) {
        const cs = window.getComputedStyle(container);
        if (cs && cs.position === 'static') {
            // remember previous position to restore later
            container.dataset.ftgPrevPosition = 'static';
            container.style.position = 'relative';
        }
    }
    const wrap = document.createElement('div');
    wrap.className = 'loading-inline-spinner';
    Object.assign(wrap.style, inlineStyleOverrides);
    // Ensure it doesn't block input interactions when overlayed
    wrap.style.pointerEvents = 'none';
    if (willBeAbsolute) {
        wrap.style.zIndex = '2';
        wrap.style.gap = '4px';
    }
    // 3 animated dots + accessible text (visually hidden or standard?)
    ['dot','dot','dot'].forEach(()=>{ const d=document.createElement('span'); d.className='dot'; wrap.appendChild(d); });
    const text = document.createElement('span');
    text.textContent = 'Loading';
    text.style.fontSize = '11px';
    text.style.textTransform = 'uppercase';
    text.style.letterSpacing = '1px';
    // When inside the input (absolute), hide the text to keep UI compact
    if (willBeAbsolute) {
        text.style.display = 'none';
        text.setAttribute('aria-hidden', 'true');
    }
    wrap.appendChild(text);
    container.appendChild(wrap);

    // If overlaying inside an input field, add right padding so text doesn't overlap
    if (willBeAbsolute) {
        const inputEl = container.querySelector('input');
        if (inputEl) {
            if (!inputEl.dataset.ftgSpinnerPadApplied) {
                inputEl.dataset.ftgSpinnerPadApplied = '1';
                inputEl.dataset.ftgSpinnerPrevPadRight = inputEl.style.paddingRight || '';
                inputEl.style.paddingRight = '2.25rem';
            }
        }
    }
    return wrap;
}
function removeInlineSpinner(container) {
    if (!container) return;
    const el = container.querySelector(':scope > .loading-inline-spinner');
    if (el) el.remove();
    // Restore input padding if we changed it
    const inputEl = container.querySelector('input');
    if (inputEl && inputEl.dataset.ftgSpinnerPadApplied) {
        inputEl.style.paddingRight = inputEl.dataset.ftgSpinnerPrevPadRight || '';
        delete inputEl.dataset.ftgSpinnerPadApplied;
        delete inputEl.dataset.ftgSpinnerPrevPadRight;
    }
    // Restore container position if we modified it
    if (container.dataset.ftgPrevPosition === 'static') {
        container.style.position = '';
        delete container.dataset.ftgPrevPosition;
    }
}

// Inline no-results message helpers
function showNoResultsMessage(container, queryText, searchType = 'generic') {
    if (!container) return;
    ensureLoaderStyles();
    // Remove any existing to avoid duplicates
    removeNoResultsMessage(container);
    const messageElement = document.createElement('div');
    messageElement.className = 'ftg-inline-msg no-results';
    messageElement.setAttribute('role', 'status');
    messageElement.setAttribute('aria-live', 'polite');
    const messages = {
        name: `No Official Establishment Name matches "${queryText}".`,
    code: `No Partner Early-Access Code matches "${queryText}".`,
    };
    messageElement.textContent = messages[searchType] || `No results found for "${queryText}".`;
    container.appendChild(messageElement);
    return messageElement;
}
function removeNoResultsMessage(container) {
    if (!container) return;
    const el = container.querySelector(':scope > .ftg-inline-msg.no-results');
    if (el) el.remove();
}

// Inline error message helpers (network/offline)
function showInlineErrorMessage(container, message) {
    if (!container) return;
    ensureLoaderStyles();
    removeInlineErrorMessage(container);
    const messageElement = document.createElement('div');
    messageElement.className = 'ftg-inline-msg error';
    messageElement.setAttribute('role', 'alert');
    messageElement.setAttribute('aria-live', 'assertive');
    messageElement.textContent = message;
    container.appendChild(messageElement);
    return messageElement;
}
function removeInlineErrorMessage(container) {
    if (!container) return;
    const el = container.querySelector(':scope > .ftg-inline-msg.error');
    if (el) el.remove();
}

// Unified logger (replaces debugLog)
function logger(level, scope, message, meta = null) {
    const ts = new Date().toISOString();
    const globalDebug = (typeof window !== 'undefined' && window.FTG_DEBUG) || DEBUG;
    if (level === 'debug' && !globalDebug) return; // skip debug when disabled
    const line = `[${level.toUpperCase()}] ${ts} :: ${scope} -> ${message}`;
    if (level === 'info') return console.info(line, meta || '');
    if (level === 'warn') return console.warn(line, meta || '');
    if (level === 'error') return console.error(line, meta || '');
    return console.log(line, meta || '');
}

/**
 * Update select elements based on provided data
 * 
 * @param {string} officialEstablishmentName - Name of the establishment
 * @param {string} partnerStatus - Partner status of the establishment
 * @param {string} awardLevel - Award level of the establishment
 */
/**
 * Update all select inputs based on the chosen establishment record fields.
 */
const updateSelectElements = (officialEstablishmentName, partnerStatus, awardLevel, dutiesAndTaxes) => {
    const functionName = 'updateSelectElements';
    try {
    logger('info', functionName, 'Updating Select Elements', { officialEstablishmentName, partnerStatus, awardLevel, dutiesAndTaxes });

        // Update Custom Establishment Name field
        const customEstablishmentNameField = fields.customEstablishmentName?.input;
        if (customEstablishmentNameField) {
            customEstablishmentNameField.value = officialEstablishmentName;
        }

        // Update partner status select dynamically
    const partnerStatusSelectField = fields.partnerStatus?.select;
    if (partnerStatusSelectField) setSelectValue(partnerStatusSelectField, partnerStatus);

        // Update award level dynamically
    const awardLevelSelectField = fields.awardLevel?.select;
    if (awardLevelSelectField) setSelectValue(awardLevelSelectField, awardLevel);

        // Update duties and taxes dynamically
    const dutiesAndTaxesSelectField = fields.dutiesAndTaxes?.select;
    if (dutiesAndTaxesSelectField) setSelectValue(dutiesAndTaxesSelectField, dutiesAndTaxes);
    } catch (error) {
        logger('error', functionName, 'Failed updating select elements', { error: error?.message, officialEstablishmentName, partnerStatus, awardLevel, dutiesAndTaxes });
        throw error; // Re-throw for caller to handle
    }
};

// Enable/disable submit buttons based on whether a valid selection exists
function updateFormSubmitState() {
    if (!formEl) return;
    const enabled = !!(lastSelectedEstablishment && lastSelectedEstablishment.id);
    const submits = formEl.querySelectorAll('button[type="submit"], input[type="submit"]');
    submits.forEach(btn => {
        btn.disabled = !enabled;
        btn.setAttribute('aria-disabled', String(!enabled));
    });
}

// Updated form submission logic
function handleFormSubmission(form) {
    form.addEventListener('submit', function(event) {
        try {
            event.preventDefault();
            const submittedData = {};
            Object.keys(fields).forEach(fieldName => {
                const field = fields[fieldName];
                if (field?.input) {
                    submittedData[fieldName] = field.input.value;
                } else if (field?.select) {
                    submittedData[fieldName] = field.select.value;
                } else {
                    console.warn(`Field ${fieldName} is missing input or select element.`);
                }
            });
            console.log('Form submission data:', submittedData);
            Object.entries(submittedData).forEach(([key, value]) => {
                if (!value || value.trim() === '') {
                    console.warn(`Field ${key} has an empty or invalid value:`, value);
                }
            });
        } catch (error) {
            console.error('Error during form submission:', error);
        }
    });
}

// Updated initialization logic
$(document).ready(function() {
    function initializeSystem() {
        initializeFields();
        addRedemptionCodeListener();
        addEstablishmentNameListener();

        const form = document.querySelector('form');
        if (form) {
            formEl = form;
            updateFormSubmitState();
            handleFormSubmission(form);
        }

    }

    if (typeof window.Autocomplete !== 'undefined') {
        initializeSystem();
    } else {
        window.addEventListener('autocompleteReady', initializeSystem);
        setTimeout(() => {
            if (typeof window.Autocomplete !== 'undefined') {
                initializeSystem();
            } else {
                console.error('Autocomplete class still not available after timeout.');
            }
        }, 1000);
    }
});

/**
 * Minimal public API for optional external control
 */
window.FTGForm = window.FTGForm || {
    reinitialize: () => {
        try { initializeFields(); } catch (e) { console.error('FTGForm.reinitialize error:', e); }
    },
    reset: () => {
        try { clearAndResetForm(); } catch (e) { console.error('FTGForm.reset error:', e); }
    },
    setMode: (mode) => {
        try { setMode(mode); } catch (e) { console.error('FTGForm.setMode error:', e); }
    },
    get config() { return { ...CFG }; },
};

// Simplified resetField function
function resetField(field) {
    if (!field) return;

    try {
        const element = field.input || field.select;
        if (element) {
            logger('debug', 'resetField', 'Reset field', { name: element.name, previous: element.value });
            element.value = '';
            if (field.select) {
                field.select.selectedIndex = 0;
                field.select.dispatchEvent(new Event('change', { bubbles: true }));
            }
        } else {
            console.warn('Field does not have input or select element:', field);
        }
    } catch (error) {
        console.error('Error resetting field:', error, field);
    }
}

// Simplified preventEdit function
function preventEdit(field) {
    if (!field) return;
    const el = field.select || field.input;
    if (!el) return;

    // For Select2 selects, use jQuery event-based disabling and styling
    if (field.select && window.jQuery && window.jQuery(field.select).hasClass('select2-hidden-accessible')) {
        const $select = window.jQuery(field.select);
        $select.on('select2:opening select2:unselecting', function(e) {
            e.preventDefault();
        });
        $select.on('keydown', function(e) {
            e.preventDefault();
        });
        $select.next('.select2-container').css({
            'pointer-events': 'none',
            'opacity': '0.5',
        });
        // Also set aria-disabled for accessibility
        $select.attr('aria-disabled', 'true');
        return;
    }

    // Fallback for non-Select2 elements
    el.setAttribute('aria-disabled', 'true');
    el.style.pointerEvents = 'none';
    el.style.opacity = '0.5';
    el.style.backgroundColor = '#e9ecef';
    el.style.color = '#6c757d';

}