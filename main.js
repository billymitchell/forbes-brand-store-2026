/**
 * Forbes Travel Guide - Simplified Form System
 * 
 * This system manages a dual-mode form:
 * 1. Redemption Code Lookup - Auto-populate from 8-character codes
 * 2. Establishment Name Lookup - Search via autocomplete
 */

// No imports needed - Autocomplete will be available globally after loading the script

// Airtable Proxy Configuration
const AIRTABLE_BASE_ID = 'appC9GXdjmEmFlNk7';
const AIRTABLE_TABLE = 'tblSsW6kAWQd3LZVa'; // Updated to match proxy example
const AIRTABLE_PROXY_URL = 'https://ftg-proxy-tq3re.ondigitalocean.app/api/query';

// Debug flag (toggle to silence verbose logs in production)
const DEBUG = false;

// Mode configuration centralized
const MODES = {
    'Redemption Code Lookup': {
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
let currentMode = 'Establishment Name Lookup';
let autocompleteInstance = null;

// Map visible label text -> internal field key
const FIELD_LABEL_TO_KEY = {
    'Redemption Code': 'redemptionCode',
    'Official Establishment Name': 'officialEstablishmentName',
    'Custom Establishment Name': 'customEstablishmentName',
    'Establishment Type': 'establishmentType',
    'Partner Status': 'partnerStatus',
    'Award Level': 'awardLevel',
    'Duties & Taxes': 'dutiesAndTaxes'
};

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
        const select = selectEl || item.querySelector('select');
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

function setMode(mode) {
    currentMode = mode;
    const config = MODES[mode] || { hide: [], prevent: [] };
    hideElements(config.hide);
    preventInteraction(config.prevent);
    if (mode === 'Establishment Name Lookup') addEstablishmentNameListener();
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
        console.log(`Preventing interaction with field: ${fieldName}`, field);
        preventEdit(field);
    });
}

function addEstablishmentNameListener() {
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
                showInlineSpinner(parentForSpinner, { position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)' });
                if (query.length < 2) {
                    if (DEBUG) console.log('Query too short, returning empty results');
                    removeInlineSpinner(parentForSpinner);
                    if (callback) callback([]);
                    return [];
                }
                return searchAirtableForAutocomplete(query)
                    .then(results => {
                        if (DEBUG) console.log('Autocomplete results:', results);
                        removeInlineSpinner(parentForSpinner);
                        if (callback) callback(results);
                        return results;
                    })
                    .catch(error => {
                        console.error('Error in autocomplete source:', error);
                        removeInlineSpinner(parentForSpinner);
                        if (callback) callback([]);
                        return [];
                    });
            }, 250),
            onSelectItem: (item) => {
                if (DEBUG) console.log('Selected establishment:', item);
                if (item.data) {
                    handleRedemptionCodeSelection(item.data);
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
        // Manual input listener no longer triggers duplicate fetches (autocomplete handles source)
        officialEstablishmentNameField.addEventListener('focus', () => {
            if (DEBUG) console.log('Field focused, ensuring lookup is ready');
        });
    } catch (error) {
        console.error('Error creating autocomplete instance:', error);
    }
}

function addRedemptionCodeListener() {
    const redemptionCodeField = fields['redemptionCode']?.input;
    if (!redemptionCodeField) return;
    const handleInput = async (event) => {
    const code = event.target.value.trim();
    // Reset all other fields except the code itself
    resetFields(['redemptionCode']);
        const existingHelpText = redemptionCodeField.parentNode.querySelector('.help-text');
        if (existingHelpText) {
            existingHelpText.remove();
        }
        if (code.length < 8 || code.length > 8) {
            const helpText = document.createElement('div');
            helpText.className = 'help-text';
            helpText.style.cssText = 'color: red; font-size: 12px; margin-top: 5px;';
            helpText.textContent = 'Please check redemption code length. It must be exactly 8 characters.';
            redemptionCodeField.parentNode.appendChild(helpText);
        }
        if (code.length === 8) {
            if (DEBUG) console.log('Redemption code entered:', code);
            showFullscreenLoader('Loading...');
            try {
                const data = await searchAirtable(code, 'Redemption Code');
                if (data.records.length > 0) {
                    handleRedemptionCodeSelection(data.records[0]);
                    if (DEBUG) console.log('Redemption code found and form populated');
                } else {
                    alert('Sorry, this redemption code is not valid. Please note that redemption codes are case-sensitive.');
                    console.warn('No matching record found for redemption code:', code);
                }
            } catch (error) {
                console.error('Error looking up redemption code:', error);
                alert('Error looking up redemption code. Please try again.');
            } finally {
                hideFullscreenLoader();
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

// Unified Airtable query via proxy server
async function queryAirtableContains(field, query) {
    const cleanQuery = (query || '').trim();
    if (!cleanQuery) return { records: [] };
    const cacheKey = `${field}::${cleanQuery.toLowerCase()}`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;
    const url = `${AIRTABLE_PROXY_URL}?AIRTABLE_BASE_ID=${encodeURIComponent(AIRTABLE_BASE_ID)}&AIRTABLE_TABLE=${encodeURIComponent(AIRTABLE_TABLE)}&field=${encodeURIComponent(field)}&q=${encodeURIComponent(cleanQuery)}&maxRecords=10`;
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const data = await response.json();
    cacheSet(cacheKey, data);
    return data;
}

async function searchAirtableForAutocomplete(query) {
    const data = await queryAirtableContains('Official Establishment Name', query);
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

async function searchAirtable(query, field) {
    return queryAirtableContains(field, query);
}

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

// Unified select value setter (combines previous setSelectValue & setDynamicSelectValue logic)
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
            let msgEl = wrapper.querySelector('.mismatch-text');
            if (!msgEl) {
                msgEl = document.createElement('div');
                msgEl.className = 'mismatch-text';
                msgEl.style.cssText = 'color: #b00020; font-size: 12px; margin-top: 4px; line-height:1.3;';
                wrapper.appendChild(msgEl);
            }
            const labelText = wrapper.querySelector('label')?.textContent?.trim() || 'Field';
            msgEl.textContent = `This product does not meet your establishment details. This product does not have "${targetValue}" for the option "${labelText}".`;
        }
    } catch(e) { /* noop */ }
    try {
        const stamp = `mismatch::${targetValue}`;
        const already = selectElement.getAttribute('data-mismatch-shown');
        if (already !== stamp) {
            selectElement.setAttribute('data-mismatch-shown', stamp);
            alert(`This product does not meet your establishment details.\n\nMissing option: ${targetValue}`);
        }
    } catch(e) { /* noop */ }
    return false;
}

function clearAndResetForm() {
    resetFields();
    const preventList = currentMode === 'Redemption Code Lookup'
        ? ['establishmentType', 'partnerStatus', 'awardLevel', 'dutiesAndTaxes', 'officialEstablishmentName']
        : ['establishmentType', 'partnerStatus', 'awardLevel', 'dutiesAndTaxes'];
    preventInteraction(preventList);
    if (currentMode !== 'Redemption Code Lookup' && autocompleteInstance && getField('officialEstablishmentName')?.input) {
        getField('officialEstablishmentName').input.value = '';
    }
}

// Removed unused createSpinner()

// Inject minimal CSS once
let loaderStylesInjected = false;
function ensureLoaderStyles() {
    if (loaderStylesInjected) return;
    const css = `/* Loader Utilities */\n.loading-inline-spinner{display:inline-flex;align-items:center;font-size:12px;color:#555;font-family:system-ui,Arial,sans-serif;gap:6px;}\n.loading-inline-spinner .dot{width:6px;height:6px;border-radius:50%;background:#888;animation:ftg-bounce 0.9s infinite ease-in-out;}\n.loading-inline-spinner .dot:nth-child(2){animation-delay:0.15s;}\n.loading-inline-spinner .dot:nth-child(3){animation-delay:0.3s;}\n@keyframes ftg-bounce{0%,80%,100%{opacity:.3;transform:translateY(0);}40%{opacity:1;transform:translateY(-4px);}}\n.ftg-fullscreen-loader{position:fixed;inset:0;display:flex;flex-direction:column;justify-content:center;align-items:center;background:rgba(0,0,0,.72);color:#fff;z-index:9999;font-family:system-ui,Arial,sans-serif;backdrop-filter:saturate(140%) blur(2px);}\n.ftg-fullscreen-loader.hidden{opacity:0;pointer-events:none;transition:opacity .25s ease;}\n.ftg-fullscreen-loader .message{margin-top:12px;font-size:16px;letter-spacing:.5px;}\n.ftg-spinner-ring{width:46px;height:46px;border:4px solid rgba(255,255,255,.25);border-top-color:#fff;border-radius:50%;animation:ftg-spin 0.9s linear infinite;}\n@keyframes ftg-spin{to{transform:rotate(360deg);}}`;
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
    const wrap = document.createElement('div');
    wrap.className = 'loading-inline-spinner';
    Object.assign(wrap.style, inlineStyleOverrides);
    // 3 animated dots + accessible text (visually hidden or standard?)
    ['dot','dot','dot'].forEach(()=>{ const d=document.createElement('span'); d.className='dot'; wrap.appendChild(d); });
    const text = document.createElement('span');
    text.textContent = 'Loading';
    text.style.fontSize = '11px';
    text.style.textTransform = 'uppercase';
    text.style.letterSpacing = '1px';
    wrap.appendChild(text);
    container.appendChild(wrap);
    return wrap;
}
function removeInlineSpinner(container) {
    if (!container) return;
    const el = container.querySelector(':scope > .loading-inline-spinner');
    if (el) el.remove();
}

// Fullscreen loader helpers
let fullscreenLoaderRef = null;
function showFullscreenLoader(message = 'Loading...') {
    ensureLoaderStyles();
    if (!fullscreenLoaderRef) {
        const root = document.createElement('div');
        root.className = 'ftg-fullscreen-loader';
        const spinner = document.createElement('div');
        spinner.className = 'ftg-spinner-ring';
        const msg = document.createElement('div');
        msg.className = 'message';
        msg.textContent = message;
        root.appendChild(spinner); root.appendChild(msg);
        document.body.appendChild(root);
        fullscreenLoaderRef = root;
    } else {
        const msg = fullscreenLoaderRef.querySelector('.message');
        if (msg) msg.textContent = message;
        fullscreenLoaderRef.classList.remove('hidden');
    }
}
function hideFullscreenLoader() {
    if (fullscreenLoaderRef) {
        fullscreenLoaderRef.classList.add('hidden');
        // Optional: remove after transition
        setTimeout(()=>{ if (fullscreenLoaderRef && fullscreenLoaderRef.classList.contains('hidden')) { fullscreenLoaderRef.remove(); fullscreenLoaderRef = null; } }, 350);
    }
}

/**
 * Utility function to log errors with context and timestamp
 * @param {string} functionName - Name of the function where error occurred
 * @param {Error|string} error - The error object or message
 * @param {Object} context - Additional context data
 */
function logError(functionName, error, context = {}) {
    const errorEntry = {
        timestamp: new Date().toISOString(),
        function: functionName,
        error: error.message || error,
        stack: error.stack || 'No stack trace available',
        context: context
    };

    console.error(`[ERROR] ${functionName}:`, error, context);
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
        logError(functionName, error, { officialEstablishmentName, partnerStatus, awardLevel, dutiesAndTaxes });
        throw error; // Re-throw for caller to handle
    }
};

// Refactored utility functions for better modularity
function logSelectOptions(selectElement) {
    const options = selectElement.querySelectorAll('option');
    return Array.from(options).map(option => ({
        text: option.textContent?.trim() || '',
        value: option.value || '',
        dataName: option.getAttribute('data-name') || ''
    }));
}

// Removed setDynamicSelectValue in favor of unified setSelectValue

// Removed logOptionsAndDatabaseValues (debug utility)

// Refactored initialization logic

// Removed setSelectValues (debug inspector)

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
            handleFormSubmission(form);
        }

    // Removed debug select value logging
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

// Simplified resetField function
function resetField(field) {
    if (!field) return;

    try {
        const element = field.input || field.select;
        if (element) {
            console.log(`Resetting field: ${element.name}, previous value: ${element.value}`);
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