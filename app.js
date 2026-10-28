/**
 * Multi-PSP Checkout Demo Playground
 *
 * Supported PSP Registry Architecture:
 * Each PSP is defined declaratively in `SUPPORTED_PSPS` with its metadata,
 * supported features, UI labels, SDK validation, cleanup, and mounting logic.
 *
 * To add a new PSP:
 * 1. Add a new key and configuration object to `SUPPORTED_PSPS`.
 * 2. The UI dropdown, badges, controls, cleanup, and mount flows will automatically adapt.
 */

// State variables for active SDK instances
let littlePayInstance = null;
let monerisCheckoutInstance = null;

// DOM Elements
const configForm = document.getElementById('sdk-config-form');
const pspProviderSelect = document.getElementById('pspProvider');
const checkoutMethodSelect = document.getElementById('checkoutMethod');
const autoTokenFields = document.getElementById('auto-token-fields');
const littlepaySettingsContainer = document.getElementById('littlepay-settings-container');
const monerisVaultSettingsContainer = document.getElementById('moneris-vault-settings-container');
const mitTypeGroup = document.getElementById('mit-type-group');

// Moneris Vault (Saved Data Key) Settings Inputs
const monerisSavedTokensSelect = document.getElementById('monerisSavedTokensSelect');
const monerisVaultDataKeyInput = document.getElementById('monerisVaultDataKey');
const monerisVaultActionTypeSelect = document.getElementById('monerisVaultActionType');
const monerisVaultCryptTypeSelect = document.getElementById('monerisVaultCryptType');
const monerisVaultExpDateInput = document.getElementById('monerisVaultExpDate');
const btnClearSavedTokens = document.getElementById('btn-clear-saved-tokens');

// Mode Inputs
const customerRefInput = document.getElementById('customerRef');
const orderAmountInput = document.getElementById('orderAmount');
const orderCurrencyInput = document.getElementById('orderCurrency');
const mitTypeSelect = document.getElementById('mitType');

// Theme Elements
const primaryColorInput = document.getElementById('primaryColor');
const bgColorInput = document.getElementById('bgColor');
const buttonBgInput = document.getElementById('buttonBg');
const buttonColorInput = document.getElementById('buttonColor');
const borderRadiusInput = document.getElementById('borderRadius');
const fontFamilySelect = document.getElementById('fontFamily');

// UI Controls
const submitBtn = document.getElementById('btn-submit');
const unmountBtn = document.getElementById('btn-unmount');
const clearLogsBtn = document.getElementById('btn-clear-logs');
const copyAllLogsBtn = document.getElementById('btn-copy-all-logs');
const expandLogsBtn = document.getElementById('btn-expand-logs');
const fullscreenLogsBtn = document.getElementById('btn-fullscreen-logs');
const logsCard = document.getElementById('logs-card');
const logsCountBadge = document.getElementById('logs-count-badge');
const logsContainer = document.getElementById('logs-container');
const sdkPlaceholder = document.getElementById('sdk-placeholder');
const sdkContainer = document.getElementById('littlepay-dropin-ui');
const monerisContainer = document.getElementById('moneris-checkout-ui');
const monerisVaultContainer = document.getElementById('moneris-vault-ui');

// Settings
const localeSelect = document.getElementById('locale');
const labelPositionSelect = document.getElementById('labelPosition');
const cardholderDetailSelect = document.getElementById('cardholderDetailFields');
const disableSavedSelect = document.getElementById('disableSavedCards');

// =============================================================================
// STRUCTURED LOGGING & PAYMENT ATTEMPT GROUPING SYSTEM
// =============================================================================
let logAttemptCounter = 0;
let activeLogGroup = null;
const allLogGroups = [];

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Compacts long unbroken token strings (e.g. JWTs, access_token, client_token) for visual log display
 * while preserving full values when copying to clipboard.
 */
function compactTokenString(str, maxTokenLen = 68) {
    if (typeof str !== 'string' || str.length <= maxTokenLen) {
        return { value: str, compacted: false };
    }
    let didCompact = false;
    const replaced = str.replace(/\S{68,}/g, (token) => {
        didCompact = true;
        return `${token.slice(0, 28)}…[${token.length} chars]…${token.slice(-14)}`;
    });
    return { value: replaced, compacted: didCompact };
}

function compactPayloadForDisplay(value, maxTokenLen = 68) {
    if (typeof value === 'string') {
        return compactTokenString(value, maxTokenLen);
    }
    if (Array.isArray(value)) {
        let anyCompacted = false;
        const arr = value.map((item) => {
            const res = compactPayloadForDisplay(item, maxTokenLen);
            if (res.compacted) anyCompacted = true;
            return res.value;
        });
        return { value: arr, compacted: anyCompacted };
    }
    if (value && typeof value === 'object') {
        let anyCompacted = false;
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            const res = compactPayloadForDisplay(v, maxTokenLen);
            if (res.compacted) anyCompacted = true;
            out[k] = res.value;
        }
        return { value: out, compacted: anyCompacted };
    }
    return { value, compacted: false };
}

/**
 * Syntax highlights a formatted JSON string for dark console display
 */
function syntaxHighlightJson(jsonStr) {
    const escaped = escapeHtml(jsonStr);
    return escaped.replace(
        /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
        (match) => {
            let cls = 'json-number';
            if (/^"/.test(match)) {
                if (/:$/.test(match)) {
                    cls = 'json-key';
                } else {
                    cls = 'json-string';
                }
            } else if (/true|false/.test(match)) {
                cls = 'json-boolean';
            } else if (/null/.test(match)) {
                cls = 'json-null';
            }
            return `<span class="${cls}">${match}</span>`;
        }
    );
}

/**
 * Extracts a category tag and clean text + optional JSON payload from raw log message
 */
function parseLogContent(rawMessage, explicitData = null, type = 'system') {
    let category = 'SYSTEM';
    let catClass = 'cat-system';
    let cleanText = String(rawMessage || '');

    const bracketMatch = cleanText.match(/^\[([^\]]+)\]\s*(.*)$/s);
    if (bracketMatch) {
        category = bracketMatch[1];
        cleanText = bracketMatch[2];
    }

    const upperCat = category.toUpperCase();
    if (upperCat.includes('ERROR') || type === 'error') {
        catClass = 'cat-error';
    } else if (upperCat.includes('CALLBACK') || type === 'callback') {
        catClass = 'cat-callback';
    } else if (upperCat.includes('VAULT')) {
        catClass = 'cat-vault';
    } else if (upperCat.includes('PROXY') || upperCat.includes('API')) {
        catClass = 'cat-api';
    } else if (type === 'success') {
        catClass = 'cat-success';
    }

    let extractedPayload = explicitData;

    if (extractedPayload === null || extractedPayload === undefined) {
        // Detect trailing JSON object or array in the message string
        const firstBrace = cleanText.search(/[\{\[]/);
        if (firstBrace !== -1) {
            const candidate = cleanText.slice(firstBrace).trim();
            if ((candidate.startsWith('{') && candidate.endsWith('}')) ||
                (candidate.startsWith('[') && candidate.endsWith(']'))) {
                try {
                    extractedPayload = JSON.parse(candidate);
                    cleanText = cleanText.slice(0, firstBrace).replace(/[:\s-]+$/, '').trim();
                } catch (e) {
                    // Not valid standalone JSON at the end; leave inline
                }
            }
        }
    } else if (typeof extractedPayload === 'string') {
        const trimmed = extractedPayload.trim();
        if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
            (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
            try {
                extractedPayload = JSON.parse(trimmed);
            } catch (e) {
                // Keep as string
            }
        }
    }

    return {
        category,
        catClass,
        cleanText: cleanText || category,
        payload: extractedPayload
    };
}

/**
 * Copies text to clipboard and flashes button visual state
 */
async function copyTextWithFeedback(text, btnElement, defaultLabel = '📋 Copy', copiedLabel = '✅ Copied!') {
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
        } else {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
        }
        if (btnElement) {
            btnElement.classList.add('copied');
            btnElement.textContent = copiedLabel;
            setTimeout(() => {
                btnElement.classList.remove('copied');
                btnElement.textContent = defaultLabel;
            }, 1800);
        }
    } catch (err) {
        console.error('Clipboard copy failed:', err);
    }
}

/**
 * Updates the attempts counter badge in the logs header
 */
function updateLogsCountBadge() {
    if (!logsCountBadge) return;
    const paymentAttempts = allLogGroups.filter(g => !g.isSystemGroup).length;
    logsCountBadge.textContent = `${paymentAttempts} attempt${paymentAttempts === 1 ? '' : 's'}`;
}

/**
 * Formats an entire log group as clean plain text for sharing / debugging
 */
function formatGroupForClipboard(group) {
    const headerLine = `=== [${group.title}] (${group.metaText || 'Session'}) - Status: ${group.status.toUpperCase()} ===`;
    const lines = group.entries.map(item => {
        let entryLine = `[${item.timestamp}] [${item.category}] ${item.cleanText}`;
        if (item.payload !== null && item.payload !== undefined) {
            const formattedPayload = typeof item.payload === 'object'
                ? JSON.stringify(item.payload, null, 2)
                : String(item.payload);
            entryLine += `\n${formattedPayload}`;
        }
        return entryLine;
    });
    return `${headerLine}\n${lines.join('\n\n')}`;
}

/**
 * Creates a new visual group block in the logs window (either a Payment Attempt or System group)
 */
function createLogGroup({ isSystemGroup = false, pspId = 'system', pspName = 'System', method = '', amountDisplay = '', customerRef = '' } = {}) {
    // Remove active highlight from previous group
    allLogGroups.forEach(g => g.element.classList.remove('active-attempt'));

    let title = 'System & Initialization';
    let metaText = new Date().toLocaleTimeString();
    let status = isSystemGroup ? 'system' : 'pending';

    if (!isSystemGroup) {
        logAttemptCounter += 1;
        title = `Attempt #${logAttemptCounter} — ${pspName}`;
        const parts = [];
        if (method) parts.push(method.toUpperCase());
        if (amountDisplay) parts.push(amountDisplay);
        if (customerRef) parts.push(`Cust: ${customerRef}`);
        parts.push(new Date().toLocaleTimeString());
        metaText = parts.join(' • ');
    }

    const groupEl = document.createElement('div');
    groupEl.className = `log-attempt-group status-${status} ${!isSystemGroup ? 'active-attempt' : ''}`;

    const headerEl = document.createElement('div');
    headerEl.className = 'log-attempt-header';

    const infoEl = document.createElement('div');
    infoEl.className = 'log-attempt-info';

    const toggleSpan = document.createElement('span');
    toggleSpan.className = 'log-attempt-toggle';
    toggleSpan.textContent = '▼';

    const badgeSpan = document.createElement('span');
    badgeSpan.className = `log-attempt-badge psp-${pspId}`;
    badgeSpan.textContent = isSystemGroup ? 'SYS' : pspName;

    const titleSpan = document.createElement('span');
    titleSpan.className = 'log-attempt-title';
    titleSpan.textContent = title;

    const metaSpan = document.createElement('span');
    metaSpan.className = 'log-attempt-meta';
    metaSpan.textContent = metaText;

    const statusPill = document.createElement('span');
    statusPill.className = `log-attempt-status-pill ${status}`;
    statusPill.textContent = isSystemGroup ? 'INFO' : 'IN PROGRESS';
    if (isSystemGroup) statusPill.style.display = 'none';

    infoEl.appendChild(toggleSpan);
    infoEl.appendChild(badgeSpan);
    infoEl.appendChild(titleSpan);
    infoEl.appendChild(metaSpan);
    infoEl.appendChild(statusPill);

    const actionsEl = document.createElement('div');
    actionsEl.className = 'log-attempt-actions';

    const copyAttemptBtn = document.createElement('button');
    copyAttemptBtn.type = 'button';
    copyAttemptBtn.className = 'btn-copy-attempt';
    copyAttemptBtn.textContent = isSystemGroup ? '📋 Copy System Logs' : '📋 Copy Attempt Logs';

    actionsEl.appendChild(copyAttemptBtn);
    headerEl.appendChild(infoEl);
    headerEl.appendChild(actionsEl);

    const bodyEl = document.createElement('div');
    bodyEl.className = 'log-attempt-body';

    groupEl.appendChild(headerEl);
    groupEl.appendChild(bodyEl);

    const groupObj = {
        id: isSystemGroup ? 'sys' : `attempt-${logAttemptCounter}`,
        isSystemGroup,
        pspId,
        pspName,
        title,
        metaText,
        status,
        element: groupEl,
        bodyEl,
        statusPill,
        metaSpan,
        entries: []
    };

    // Toggle collapse when clicking header (except on copy button)
    headerEl.addEventListener('click', (e) => {
        if (e.target.closest('.btn-copy-attempt')) return;
        groupEl.classList.toggle('collapsed');
    });

    copyAttemptBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const textToCopy = formatGroupForClipboard(groupObj);
        copyTextWithFeedback(
            textToCopy,
            copyAttemptBtn,
            isSystemGroup ? '📋 Copy System Logs' : '📋 Copy Attempt Logs'
        );
    });

    if (logsContainer) {
        logsContainer.appendChild(groupEl);
    }

    allLogGroups.push(groupObj);
    activeLogGroup = groupObj;
    updateLogsCountBadge();
    return groupObj;
}

/**
 * Starts a new dedicated Payment Attempt section in the logs panel
 */
function startPaymentAttemptLog({ pspId, pspName, method, amount, currency, customerRef }) {
    const formattedAmount = amount !== undefined && amount !== null
        ? `${(Number(amount) / 100).toFixed(2)} ${currency || ''}`.trim()
        : '';
    return createLogGroup({
        isSystemGroup: false,
        pspId: pspId || 'system',
        pspName: pspName || 'PSP',
        method: method || 'sdk',
        amountDisplay: formattedAmount,
        customerRef: customerRef || '1'
    });
}

/**
 * Updates the status pill and border color of the current payment attempt
 */
function updateActiveAttemptStatus(newStatus, extraMeta = '') {
    if (!activeLogGroup || activeLogGroup.isSystemGroup) return;
    activeLogGroup.status = newStatus;
    activeLogGroup.element.classList.remove('status-pending', 'status-success', 'status-error');
    activeLogGroup.element.classList.add(`status-${newStatus}`);

    if (activeLogGroup.statusPill) {
        activeLogGroup.statusPill.style.display = 'inline-block';
        activeLogGroup.statusPill.className = `log-attempt-status-pill ${newStatus}`;
        activeLogGroup.statusPill.textContent = newStatus === 'success'
            ? 'SUCCESS'
            : (newStatus === 'error' ? 'FAILED / DECLINED' : 'IN PROGRESS');
    }

    if (extraMeta && activeLogGroup.metaSpan && !activeLogGroup.metaText.includes(extraMeta)) {
        activeLogGroup.metaText += ` • ${extraMeta}`;
        activeLogGroup.metaSpan.textContent = activeLogGroup.metaText;
    }
}

/**
 * Utility to log messages into our structured console log view
 */
function log(message, type = 'system', explicitData = null) {
    const timestamp = new Date().toLocaleTimeString();

    if (!activeLogGroup) {
        createLogGroup({ isSystemGroup: true });
    }

    const { category, catClass, cleanText, payload } = parseLogContent(message, explicitData, type);

    // Auto-update attempt status on error or final callback
    if (!activeLogGroup.isSystemGroup) {
        if (type === 'error') {
            updateActiveAttemptStatus('error');
        } else if (type === 'success' && (
            category.toUpperCase().includes('CALLBACK') ||
            cleanText.includes('registered successfully') ||
            cleanText.includes('Receipt Status') ||
            cleanText.includes('Final Link') ||
            category.toUpperCase().includes('RESPONSE')
        )) {
            updateActiveAttemptStatus('success');
        }
    }

    const entryRecord = {
        timestamp,
        type,
        category,
        cleanText,
        payload
    };
    activeLogGroup.entries.push(entryRecord);

    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;

    const topRow = document.createElement('div');
    topRow.className = 'log-entry-top';

    const mainCol = document.createElement('div');
    mainCol.className = 'log-entry-main';

    const timeSpan = document.createElement('span');
    timeSpan.className = 'log-timestamp';
    timeSpan.textContent = timestamp;

    const catSpan = document.createElement('span');
    catSpan.className = `log-category-tag ${catClass}`;
    catSpan.textContent = category;

    const msgSpan = document.createElement('span');
    msgSpan.className = 'log-message-text';
    const compactedMsg = compactTokenString(cleanText, 68);
    msgSpan.textContent = compactedMsg.value;
    if (compactedMsg.compacted) {
        msgSpan.title = cleanText;
    }

    mainCol.appendChild(timeSpan);
    mainCol.appendChild(catSpan);
    mainCol.appendChild(msgSpan);
    topRow.appendChild(mainCol);

    // Individual copy button if entry is a callback, error, response, or has payload
    const isImportantEntry = payload !== null && payload !== undefined ||
        type === 'callback' ||
        type === 'error' ||
        category.toUpperCase().includes('CALLBACK') ||
        category.toUpperCase().includes('RESPONSE');

    if (isImportantEntry && payload === null) {
        const copyEntryBtn = document.createElement('button');
        copyEntryBtn.type = 'button';
        copyEntryBtn.className = 'btn-copy-entry';
        copyEntryBtn.textContent = '📋 Copy';
        copyEntryBtn.addEventListener('click', () => {
            const rawText = `[${timestamp}] [${category}] ${cleanText}`;
            copyTextWithFeedback(rawText, copyEntryBtn, '📋 Copy');
        });
        topRow.appendChild(copyEntryBtn);
    }

    entry.appendChild(topRow);

    // Render pretty JSON / structured payload block if present
    if (payload !== null && payload !== undefined) {
        const payloadWrapper = document.createElement('div');
        payloadWrapper.className = 'log-payload-wrapper';

        const toolbar = document.createElement('div');
        toolbar.className = 'log-payload-toolbar';

        const labelSpan = document.createElement('span');
        const isJsonObj = typeof payload === 'object';

        const formattedString = isJsonObj
            ? JSON.stringify(payload, null, 2)
            : String(payload);

        const compactedPayloadRes = compactPayloadForDisplay(payload, 68);
        const compactedFormattedString = isJsonObj
            ? JSON.stringify(compactedPayloadRes.value, null, 2)
            : String(compactedPayloadRes.value);

        labelSpan.textContent = isJsonObj
            ? (compactedPayloadRes.compacted ? 'JSON Payload (tokens compacted)' : 'JSON Payload')
            : 'Payload Data';

        const toolbarActions = document.createElement('div');
        toolbarActions.className = 'log-payload-toolbar-actions';

        const pre = document.createElement('pre');
        pre.className = 'log-payload-pre';

        const renderPreContent = (strToRender) => {
            if (isJsonObj) {
                pre.innerHTML = syntaxHighlightJson(strToRender);
            } else {
                pre.textContent = strToRender;
            }
        };

        renderPreContent(compactedFormattedString);

        if (compactedPayloadRes.compacted) {
            let isExpanded = false;
            const toggleTokensBtn = document.createElement('button');
            toggleTokensBtn.type = 'button';
            toggleTokensBtn.className = 'btn-copy-entry';
            toggleTokensBtn.textContent = '🔍 Expand Tokens';
            toggleTokensBtn.addEventListener('click', () => {
                isExpanded = !isExpanded;
                renderPreContent(isExpanded ? formattedString : compactedFormattedString);
                toggleTokensBtn.textContent = isExpanded ? '🔽 Compact Tokens' : '🔍 Expand Tokens';
                labelSpan.textContent = isJsonObj
                    ? (isExpanded ? 'JSON Payload (full tokens)' : 'JSON Payload (tokens compacted)')
                    : 'Payload Data';
            });
            toolbarActions.appendChild(toggleTokensBtn);
        }

        const copyPayloadBtn = document.createElement('button');
        copyPayloadBtn.type = 'button';
        copyPayloadBtn.className = 'btn-copy-entry';
        copyPayloadBtn.textContent = '📋 Copy Payload';

        copyPayloadBtn.addEventListener('click', () => {
            copyTextWithFeedback(formattedString, copyPayloadBtn, '📋 Copy Payload');
        });

        toolbarActions.appendChild(copyPayloadBtn);
        toolbar.appendChild(labelSpan);
        toolbar.appendChild(toolbarActions);

        payloadWrapper.appendChild(toolbar);
        payloadWrapper.appendChild(pre);
        entry.appendChild(payloadWrapper);
    }

    if (activeLogGroup && activeLogGroup.bodyEl) {
        activeLogGroup.bodyEl.appendChild(entry);
    } else if (logsContainer) {
        logsContainer.appendChild(entry);
    }

    if (logsContainer) {
        logsContainer.scrollTop = logsContainer.scrollHeight;
    }
}

// =============================================================================
// MONERIS VAULT DATA KEY STORAGE HELPERS
// =============================================================================
const STORAGE_KEY_MONERIS_TOKENS = 'moneris_saved_data_keys';

function getSavedMonerisDataKeys() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY_MONERIS_TOKENS);
        return raw ? JSON.parse(raw) : [];
    } catch (e) {
        return [];
    }
}

function saveMonerisDataKey(tokenData) {
    if (!tokenData || !tokenData.dataKey) return;
    try {
        const keys = getSavedMonerisDataKeys();
        const existingIdx = keys.findIndex(k => k.dataKey === tokenData.dataKey);
        const item = {
            dataKey: tokenData.dataKey,
            cardMasked: tokenData.cardMasked || '•••• •••• •••• ••••',
            source: tokenData.source || 'Moneris Checkout',
            date: new Date().toLocaleDateString() + ' ' + new Date().toLocaleTimeString(),
            ...tokenData
        };
        if (existingIdx >= 0) {
            keys[existingIdx] = item;
        } else {
            keys.unshift(item);
        }
        localStorage.setItem(STORAGE_KEY_MONERIS_TOKENS, JSON.stringify(keys));
        populateSavedDataKeysDropdown();
        log(`[Moneris Vault] Token '${tokenData.dataKey}' (${item.cardMasked}) saved to local storage for future Vault payments.`, 'success');
    } catch (e) {
        console.warn('Failed to save Moneris token to localStorage:', e);
    }
}

function populateSavedDataKeysDropdown() {
    if (!monerisSavedTokensSelect) return;
    const keys = getSavedMonerisDataKeys();
    monerisSavedTokensSelect.innerHTML = '';

    if (keys.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '-- No saved tokens available --';
        monerisSavedTokensSelect.appendChild(opt);
        if (monerisVaultDataKeyInput) monerisVaultDataKeyInput.value = '';
        return;
    }

    keys.forEach((k, idx) => {
        const opt = document.createElement('option');
        opt.value = k.dataKey;
        opt.textContent = `${k.cardMasked || 'Card'} (${k.dataKey.substring(0, 10)}...) - ${k.source || 'Moneris'} [${k.date || ''}]`;
        if (idx === 0) opt.selected = true;
        monerisSavedTokensSelect.appendChild(opt);
    });

    const customOpt = document.createElement('option');
    customOpt.value = 'custom';
    customOpt.textContent = '✏️ Enter custom data_key manually...';
    monerisSavedTokensSelect.appendChild(customOpt);

    if (keys[0] && monerisVaultDataKeyInput && !monerisVaultDataKeyInput.value) {
        monerisVaultDataKeyInput.value = keys[0].dataKey;
    }
}

function selectMonerisSavedTokenForPayment(tokenKey) {
    if (!tokenKey) return;
    log(`[Moneris Vault] Selected saved token: ${tokenKey}. Switching to 'Pay with Saved Data Key'...`, 'system');
    
    // Switch checkout method to vault
    if (checkoutMethodSelect) {
        checkoutMethodSelect.value = 'vault';
    }
    updateCheckoutMethodUI();

    populateSavedDataKeysDropdown();
    if (monerisSavedTokensSelect) {
        monerisSavedTokensSelect.value = tokenKey;
    }
    if (monerisVaultDataKeyInput) {
        monerisVaultDataKeyInput.value = tokenKey;
    }

    // Scroll config form into view
    if (configForm) {
        configForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
}

/**
 * Synchronizes color pickers text displays
 */
function setupColorPickers() {
    const colorPickers = [
        primaryColorInput,
        bgColorInput,
        buttonBgInput,
        buttonColorInput
    ];
    
    colorPickers.forEach(picker => {
        if (!picker) return;
        picker.addEventListener('input', (e) => {
            const valSpan = picker.nextElementSibling;
            if (valSpan && valSpan.classList.contains('color-value')) {
                valSpan.textContent = e.target.value.toUpperCase();
            }
        });
    });
}

/**
 * Reads all key-value metadata fields from the DOM
 */
function getMetadataMap() {
    const metadata = {};
    const metadataContainer = document.getElementById('metadata-rows-container');
    if (metadataContainer) {
        const keyInputs = metadataContainer.querySelectorAll('.metadata-key');
        const valueInputs = metadataContainer.querySelectorAll('.metadata-value');
        keyInputs.forEach((keyInput, index) => {
            const key = keyInput.value.trim();
            const val = valueInputs[index] ? valueInputs[index].value.trim() : '';
            if (key) {
                metadata[key] = val;
            }
        });
    }
    return metadata;
}

/**
 * Installs once-per-page interceptors for Littlepay SDK browser fetch requests & iframe postMessages
 * so all internal SDK network calls and card-collection events appear in the real-time logs panel.
 */
let littlepayInterceptorsInstalled = false;
function ensureLittlepaySdkInterceptors() {
    if (littlepayInterceptorsInstalled) return;
    littlepayInterceptorsInstalled = true;

    // 1. Intercept window.fetch for *.littlepay.com calls made by Littlepay SDK v2
    const originalFetch = window.fetch.bind(window);
    window.fetch = async function (...args) {
        const [resource, init] = args;
        const urlStr = typeof resource === 'string' ? resource : (resource && resource.url) || '';
        const isLittlepayCall = urlStr.includes('littlepay.com');

        if (!isLittlepayCall) {
            return originalFetch(...args);
        }

        const method = (init && init.method) || (resource && resource.method) || 'GET';
        let shortPath = urlStr;
        try {
            const parsedUrl = new URL(urlStr);
            shortPath = parsedUrl.pathname + parsedUrl.search;
        } catch (e) {}

        let reqPayload = null;
        if (init && init.body) {
            try {
                reqPayload = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
            } catch (e) {
                reqPayload = init.body;
            }
        }

        log(`[Littlepay SDK -> API] ${method} ${shortPath}`, 'system', reqPayload || { method, url: urlStr });

        try {
            const response = await originalFetch(...args);
            const cloned = response.clone();
            cloned.text().then((bodyText) => {
                let parsedBody = null;
                try {
                    parsedBody = bodyText ? JSON.parse(bodyText) : { status: response.status, statusText: response.statusText };
                } catch (e) {
                    parsedBody = { raw: bodyText };
                }
                const logType = response.ok ? 'callback' : 'error';
                log(`[Littlepay SDK <- API] HTTP ${response.status} (${method} ${shortPath})`, logType, parsedBody);
            }).catch(() => {});
            return response;
        } catch (fetchErr) {
            log(`[Littlepay SDK Network Error] ${method} ${shortPath}: ${fetchErr.message}`, 'error');
            throw fetchErr;
        }
    };

    // 2. Listen for postMessage events from Littlepay card-collection / 3DS iframes
    window.addEventListener('message', (event) => {
        if (!event.origin || !event.origin.includes('littlepay.com')) return;
        let payload = event.data;
        if (typeof payload === 'string') {
            try { payload = JSON.parse(payload); } catch (e) {}
        }
        log(`[Littlepay Iframe Event] postMessage from ${event.origin}`, 'callback', payload);
    });
}

/**
 * Queries /api/littlepay-receipt on the local proxy to inspect PaymentIntent & Stored Payment Methods
 */
async function fetchAndRenderLittlepayReceipt(sessionData, paymentIntentIdOverride, isError = false, sdkError = null) {
    const metadata = getMetadataMap();
    const rawAmount = parseInt(orderAmountInput ? orderAmountInput.value.trim() : '0', 10);
    const amount = Number.isInteger(rawAmount) ? rawAmount : 0;
    const currency = (orderCurrencyInput && orderCurrencyInput.value.trim()) || 'EUR';
    const customerRef = sessionData.customer_ref || (customerRefInput && customerRefInput.value.trim()) || '';
    const paymentIntentId = paymentIntentIdOverride || sessionData.payment_intent_id;

    const inspectPayload = {
        client_token: sessionData.client_token,
        order_id: sessionData.id,
        payment_intent_id: paymentIntentId,
        customer_ref: customerRef,
        amount: amount,
        currency: currency,
        metadata: metadata
    };

    log('[Proxy Littlepay] Inspecting PaymentIntent & Stored Payment Methods (/api/littlepay-receipt)...', 'system', inspectPayload);

    try {
        const res = await fetch('/api/littlepay-receipt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(inspectPayload)
        });
        const receiptData = await res.json();

        if (receiptData.paymentIntent) {
            log('[Littlepay API] GET /customer/v1/payment-intents/{id}', isError ? 'error' : 'success', receiptData.paymentIntent);
        }
        if (receiptData.storedPaymentMethods) {
            log(`[Littlepay API] GET /customer/v1/stored-payment-methods (${receiptData.storedPaymentMethods.length} card(s) found)`, 'success', receiptData.storedPaymentMethods);
        }
        if (receiptData.latestStoredPaymentMethodDetail) {
            log(`[Littlepay API] GET /customer/v1/stored-payment-methods/${receiptData.latestStoredPaymentMethod?.id} (Full Card Mask & Vault ID)`, 'success', receiptData.latestStoredPaymentMethodDetail);
        }

        const pi = receiptData.paymentIntent || {};
        const latestSpm = receiptData.latestStoredPaymentMethod || {};
        const latestDetail = receiptData.latestStoredPaymentMethodDetail || {};
        const statusStr = pi.status || (isError ? 'FAILED' : 'SUCCEEDED');
        const isApproved = !isError && (statusStr === 'SUCCEEDED' || statusStr === 'REQUIRES_CAPTURE');

        const cardMask16 = latestDetail.card_mask || 'N/A';
        const cardMask4 = latestSpm.card_mask || 'N/A';
        const formattedMaskedPan = receiptData.formattedMaskedPan || 'SAVED_CARD';
        const cardType = latestDetail.card_type || latestSpm.card_type || 'N/A';
        const cardExpiry = latestDetail.card_expiry || latestSpm.card_expiry || 'N/A';
        const fundingSourceId = latestSpm.funding_source_id || latestDetail.vault_id || 'N/A';
        const spmId = latestSpm.id || 'N/A';

        let detailsHtml = `
            <strong>Order ID:</strong> ${receiptData.order_id || sessionData.id || 'N/A'}<br>
            <strong>Payment Intent ID:</strong> ${receiptData.payment_intent_id || paymentIntentId || 'N/A'}<br>
            <strong>Customer Ref:</strong> ${receiptData.customer_ref || customerRef || 'N/A'}<br>
            <strong>Amount:</strong> ${(amount / 100).toFixed(2)} ${currency}<br>
            <strong>Intent Status:</strong> <span style="font-weight: 700; color: ${isApproved ? 'var(--success)' : 'var(--error)'};">${statusStr}</span><br>
            <strong>Capture Method:</strong> ${pi.capture_method || 'AUTO'}<br>
            <strong>MIT / CoF Type:</strong> ${pi.payment_method_options?.cof_type || latestSpm.cof_type || sessionData.mit_type || 'NONE'}<br>
            <hr style="border: none; border-top: 1px dashed rgba(0,0,0,0.12); margin: 8px 0;">
            <strong>Stored Payment Method ID:</strong> <code>${spmId}</code><br>
            <strong>Funding Source ID (Token):</strong> <span style="color: #2b6cb0; font-weight: 600;">${fundingSourceId}</span><br>
            <strong>Card Type:</strong> ${cardType}<br>
            <strong>Card Expiry:</strong> ${cardExpiry}<br>
            <strong>Card Mask (List / 4-digit):</strong> <code>${cardMask4}</code><br>
            <strong>Card Mask (Detail / 16-char):</strong> <code>${cardMask16}</code><br>
            <strong>Formatted Label (wfwp-platform):</strong> <code style="font-weight: 700; color: var(--success);">${formattedMaskedPan}</code>
        `;

        if (pi.error || sdkError) {
            detailsHtml += `<br><strong>Error Detail:</strong> <span style="color: var(--error);">${escapeHtml(JSON.stringify(pi.error || sdkError))}</span>`;
        }

        if (sdkContainer) {
            sdkContainer.classList.remove('hidden');
            sdkContainer.innerHTML = `
                <div class="card-success-message" style="text-align: center; padding: 32px 20px; animation: fadeIn 0.4s ease-out;">
                    <div style="font-size: 3rem; margin-bottom: 12px;">${isApproved ? '✅' : '❌'}</div>
                    <h3 style="color: ${isApproved ? 'var(--success)' : 'var(--error)'}; font-weight: 700; margin-bottom: 6px;">
                        ${isApproved ? 'Littlepay Checkout Complete!' : 'Littlepay Checkout Error / Incomplete'}
                    </h3>
                    <p style="font-size: 0.85rem; color: var(--text-main); margin-bottom: 16px;">
                        ${isApproved ? 'Payment intent and stored payment method details retrieved from Littlepay.' : 'See detailed gateway and SDK response below.'}
                    </p>
                    <div style="background-color: ${isApproved ? 'var(--success-light)' : 'var(--error-light)'}; color: var(--text-main); border: 1px solid ${isApproved ? 'rgba(56, 161, 105, 0.2)' : 'rgba(229, 62, 62, 0.2)'}; font-family: var(--font-mono); font-size: 0.75rem; padding: 14px; border-radius: var(--radius-md); word-break: break-all; text-align: left; line-height: 1.65;">
                        ${detailsHtml}
                    </div>
                </div>
            `;
        }
    } catch (err) {
        log(`[Proxy Littlepay Error] Failed to inspect Littlepay receipt: ${err.message}`, 'error');
    }
}

/**
 * Builds the theme and layout parameters for Littlepay SDK mode
 */
function buildSdkConfig(clientToken) {
    const primaryColor = primaryColorInput ? primaryColorInput.value : '#2d3748';
    const bgColor = bgColorInput ? bgColorInput.value : '#ffffff';
    const buttonBg = buttonBgInput ? buttonBgInput.value : '#ed7625';
    const buttonColor = buttonColorInput ? buttonColorInput.value : '#ffffff';
    const borderRadius = (borderRadiusInput && borderRadiusInput.value) || '4px';
    const fontFamily = fontFamilySelect ? fontFamilySelect.value : 'Rubik, sans-serif';
    const locale = localeSelect ? localeSelect.value : 'en-GB';
    const labelPosition = labelPositionSelect ? labelPositionSelect.value : 'floating';
    const cardholderDetailFields = cardholderDetailSelect ? cardholderDetailSelect.value : 'HIDE';
    const disableSavedCards = disableSavedSelect ? disableSavedSelect.value === 'true' : false;

    return {
        clientToken: clientToken.trim(),
        targetElementId: 'littlepay-dropin-ui',
        locale: locale,
        options: {
            disableSavedCards: disableSavedCards,
            cardholderDetailFields: cardholderDetailFields,
            theme: {
                color: primaryColor,
                backgroundColor: bgColor,
                fontFamily: fontFamily,
                labelPosition: labelPosition,
                loadingScreen: {
                    color: buttonBg,
                    backgroundColor: bgColor,
                },
                button: {
                    color: buttonColor,
                    backgroundColor: buttonBg,
                    borderRadius: borderRadius,
                },
                errorMessage: {
                    color: '#ffffff',
                    backgroundColor: '#e53e3e',
                },
                navigationBar: {
                    color: primaryColor,
                    backgroundColor: bgColor,
                },
                input: {
                    borderRadius: '6px',
                    borderWidth: '1px',
                    color: primaryColor,
                    backgroundColor: bgColor
                }
            }
        }
    };
}

// =============================================================================
// SUPPORTED PSP REGISTRY
// =============================================================================
/**
 * Master Registry of Supported Payment Service Providers (PSPs).
 *
 * Each PSP configuration defines:
 * - id: Unique identifier matching backend route expectations
 * - name: Human-readable display label for dropdown and logs
 * - badge: Label shown in the header badge
 * - defaultCurrency: Default ISO 4217 currency code
 * - defaultMethod: Default checkout method ('sdk', 'link', etc.)
 * - supportedMethods: Array of selectable checkout methods [{ id, label }]
 * - features: Toggles for UI feature panels:
 *     - checkoutMethod: Show/hide checkout method dropdown
 *     - mitType: Show/hide MIT registration type dropdown
 *     - customSettings: Show/hide locale, layout, and theme settings
 * - containerId: ID of container element rendered for drop-in
 * - buttonText: Mapping of method -> button label
 * - previewTexts: Mapping of method -> { title, subtitle, placeholderTitle, placeholderText }
 * - checkSdkAvailable: Function verifying whether external SDK is ready
 * - sdkMissingMessage: User-facing warning when SDK CDN script is absent
 * - cleanup: Teardown logic for previously running instances
 * - mount: Handler to render the drop-in UI or redirect link
 */
const SUPPORTED_PSPS = {
    littlepay: {
        id: 'littlepay',
        name: 'Littlepay',
        badge: 'Littlepay SDK',
        defaultCurrency: 'EUR',
        defaultMethod: 'sdk',
        supportedMethods: [
            { id: 'sdk', label: 'Inline Drop-in SDK' },
            { id: 'link', label: 'Payment Link / Hosted Redirection' }
        ],
        features: {
            checkoutMethod: true,
            mitType: true,
            customSettings: true
        },
        containerId: 'littlepay-dropin-ui',
        buttonText: {
            sdk: 'Generate Token & Register Card',
            link: 'Generate Payment Link'
        },
        previewTexts: {
            sdk: {
                title: '2. Checkout Drop-in UI',
                subtitle: 'Secure interactive elements rendered by Littlepay SDK.',
                placeholderTitle: 'Ready to Initialize SDK',
                placeholderText: 'Configure parameters and click "Generate Token & Register Card" to load the secure inline drop-in.'
            },
            link: {
                title: '2. Hosted Checkout Link',
                subtitle: 'Secure redirect options generated by Littlepay Sandbox.',
                placeholderTitle: 'Ready to Generate Link',
                placeholderText: 'Configure parameters and click "Generate Payment Link" to construct your hosted checkout redirect.'
            }
        },
        checkSdkAvailable: () => typeof window.LittlePay === 'function',
        sdkMissingMessage: 'Littlepay Checkout SDK script failed to load from CDN. Direct connection testing requires internet access.',
        cleanup: () => {
            if (littlePayInstance) {
                log('[System] Cleaning up previous Littlepay SDK instance...', 'system');
                try {
                    littlePayInstance.unmount();
                    log('[System] Previous Littlepay SDK instance successfully unmounted.', 'success');
                } catch (err) {
                    log(`[System] Warning on Littlepay unmount: ${err.message}`, 'error');
                }
                littlePayInstance = null;
            }
        },
        mount: async (sessionData, context) => {
            ensureLittlepaySdkInterceptors();

            if (Array.isArray(sessionData.apiSteps)) {
                sessionData.apiSteps.forEach((stepObj) => {
                    log(`[Proxy Littlepay Step ${stepObj.step}] ${stepObj.name} -> HTTP ${stepObj.statusCode}`, 'success', stepObj);
                });
            }

            if (sdkContainer) {
                sdkContainer.classList.remove('hidden');
                sdkContainer.innerHTML = '';
            }

            // ROUTE A: PAYMENT LINK (Hosted Redirection)
            if (sessionData.checkoutMethod === 'link') {
                log(`[System] Payment Link checkout flow initiated. Rendering redirection view.`, 'system');
                log(`[System] Final Link: ${sessionData.url}`, 'success', sessionData.linkData || { url: sessionData.url });

                sdkContainer.innerHTML = `
                    <div class="payment-link-card" style="text-align: center; padding: 40px 20px; animation: fadeIn 0.4s ease-out; font-family: var(--font-sans);">
                        <div style="font-size: 3.5rem; margin-bottom: 16px; color: var(--primary);">🔗</div>
                        <h3 style="color: var(--text-main); font-weight: 700; margin-bottom: 8px;">Payment Link Generated!</h3>
                        <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 24px;">Your hosted checkout payment link is ready for secure card registration.</p>
                        
                        <div style="display: flex; gap: 8px; margin-bottom: 20px;">
                            <input type="text" id="pl-url-input" value="${sessionData.url}" readonly style="flex-grow: 1; padding: 10px 12px; border: 1px solid var(--border-color); border-radius: var(--radius-md); font-family: var(--font-mono); font-size: 0.75rem; background-color: #f8fafc; color: var(--text-main);">
                            <button id="btn-pl-copy" class="btn btn-secondary btn-sm" style="width: auto; padding: 10px 16px; font-size: 0.85rem; border-radius: var(--radius-md);">Copy</button>
                        </div>

                        <div style="display: flex; flex-direction: column; gap: 10px;">
                            <button id="btn-pl-open" class="btn btn-primary" style="width: 100%; padding: 14px; font-size: 0.95rem; border-radius: var(--radius-md); background-color: var(--primary); font-weight: 700; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px;">
                                <span>Open Hosted Checkout</span>
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
                            </button>
                            <button id="btn-pl-inspect" class="btn btn-secondary" style="width: 100%; padding: 12px; font-size: 0.85rem; border-radius: var(--radius-md); font-weight: 600; cursor: pointer;">
                                🔍 Inspect Payment Intent & Stored Cards (Receipt)
                            </button>
                        </div>
                    </div>
                `;

                const copyBtn = document.getElementById('btn-pl-copy');
                if (copyBtn) {
                    copyBtn.addEventListener('click', () => {
                        const urlInput = document.getElementById('pl-url-input');
                        if (urlInput) {
                            urlInput.select();
                            document.execCommand('copy');
                            log('[System] Payment link URL copied to clipboard.', 'success');
                            copyBtn.textContent = 'Copied!';
                            setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000);
                        }
                    });
                }

                const openBtn = document.getElementById('btn-pl-open');
                if (openBtn) {
                    openBtn.addEventListener('click', () => {
                        log('[System] Redirecting customer to hosted payment page in a new tab...', 'system');
                        window.open(sessionData.url, '_blank');
                    });
                }

                const inspectBtn = document.getElementById('btn-pl-inspect');
                if (inspectBtn) {
                    inspectBtn.addEventListener('click', async () => {
                        inspectBtn.disabled = true;
                        inspectBtn.textContent = 'Inspecting Littlepay APIs...';
                        await fetchAndRenderLittlepayReceipt(sessionData, sessionData.payment_intent_id, false, null);
                    });
                }
                return;
            }

            // ROUTE B: INLINE SDK (Direct Mount Form)
            const config = buildSdkConfig(sessionData.client_token);
            log('[Littlepay SDK] Initializing window.LittlePay() with configuration', 'system', {
                targetElementId: config.targetElementId,
                locale: config.locale,
                options: config.options,
                payment_intent_id: sessionData.payment_intent_id,
                order_id: sessionData.id
            });

            littlePayInstance = window.LittlePay(config);
            log('[Littlepay SDK] Littlepay SDK Instance created successfully.', 'success');
            if (unmountBtn) unmountBtn.disabled = false;
            
            const errorCallback = async (error) => {
                log(`[Littlepay Callback] errorCallback fired (Raw SDK Payload)`, 'error', error);
                updateActiveAttemptStatus('error');
                console.error('Littlepay SDK Error callback:', error);
                await fetchAndRenderLittlepayReceipt(sessionData, sessionData.payment_intent_id, true, error);
            };
            
            const successCallback = async (paymentIntentId) => {
                log(`[Littlepay Callback] successCallback fired (Raw SDK Payload)`, 'success', {
                    payment_intent_id: paymentIntentId,
                    order_id: sessionData.id
                });
                updateActiveAttemptStatus('success', sessionData.id);
                
                cleanupExistingSession();
                if (unmountBtn) unmountBtn.disabled = true;

                await fetchAndRenderLittlepayReceipt(sessionData, paymentIntentId, false, null);
            };

            const sdkMethod = sessionData.mit_type ? 'registerCard' : 'makePayment';
            log(`[Littlepay SDK] Launching ${sdkMethod}() flow...`, 'system', {
                method: sdkMethod,
                mit_type: sessionData.mit_type || null
            });
            if (sdkMethod === 'registerCard' || typeof littlePayInstance.makePayment !== 'function') {
                littlePayInstance.registerCard(errorCallback, successCallback);
            } else {
                littlePayInstance.makePayment(errorCallback, successCallback);
            }
            log(`[Littlepay SDK] ${sdkMethod}() form rendering within target container.`, 'system');
        }
    },

    moneris: {
        id: 'moneris',
        name: 'Moneris',
        badge: 'Moneris Gateway',
        defaultCurrency: 'CAD',
        defaultMethod: 'sdk',
        supportedMethods: [
            { id: 'sdk', label: 'Moneris Checkout (MCO Drop-in)' },
            { id: 'vault', label: 'Pay with Saved Data Key (Vault)' }
        ],
        features: {
            checkoutMethod: true,
            mitType: true,
            customSettings: false
        },
        containerId: 'moneris-checkout-ui',
        buttonText: {
            sdk: 'Initialize Moneris Checkout (MCO)',
            vault: 'Pay with Saved Data Key'
        },
        previewTexts: {
            sdk: {
                title: '2. Moneris Checkout Drop-in UI',
                subtitle: 'Secure interactive iframe rendered by Moneris Checkout JS SDK.',
                placeholderTitle: 'Ready to Initialize Moneris Checkout',
                placeholderText: 'Configure parameters and click "Initialize Moneris Checkout (MCO)" to load the secure inline drop-in.'
            },
            vault: {
                title: '2. Moneris Vault Payment UI',
                subtitle: 'Process subsequent card-on-file or recurring payments using a saved token (data_key).',
                placeholderTitle: 'Ready to Pay with Saved Data Key',
                placeholderText: 'Select a saved token from Moneris Checkout and click "Pay with Saved Data Key" to process a server-side Vault transaction.'
            }
        },
        checkSdkAvailable: () => {
            const method = checkoutMethodSelect ? checkoutMethodSelect.value : 'sdk';
            if (method === 'vault') return true;
            return typeof window.monerisCheckout === 'function';
        },
        sdkMissingMessage: 'Moneris Checkout SDK script failed to load from CDN. Direct connection testing requires internet access.',
        cleanup: () => {
            if (monerisCheckoutInstance) {
                log('[System] Cleaning up previous Moneris Checkout instance...', 'system');
                try {
                    if (typeof monerisCheckoutInstance.closeCheckout === 'function') {
                        monerisCheckoutInstance.closeCheckout();
                    }
                    log('[System] Previous Moneris Checkout instance successfully closed.', 'success');
                } catch (err) {
                    log(`[System] Warning on Moneris close: ${err.message}`, 'error');
                }
                monerisCheckoutInstance = null;
            }
            if (monerisVaultContainer) {
                monerisVaultContainer.innerHTML = '';
                monerisVaultContainer.classList.add('hidden');
            }
        },
        mount: async (sessionData, context) => {
            // FLOW A: MONERIS VAULT (Pay with Saved data_key)
            if (sessionData.checkoutMethod === 'vault') {
                log(`[Moneris Vault] Preparing Vault payment for DataKey: ${sessionData.dataKey}...`, 'system');
                if (monerisVaultContainer) {
                    monerisVaultContainer.classList.remove('hidden');
                    monerisVaultContainer.innerHTML = '';
                }
                if (monerisContainer) monerisContainer.classList.add('hidden');
                if (sdkContainer) sdkContainer.classList.add('hidden');

                const actionType = sessionData.action || 'purchase';
                const submitBtnLabel = `Confirm & Pay $${sessionData.amount} ${sessionData.currency} with Data Key`;

                // Retrieve token info if saved
                const allSaved = getSavedMonerisDataKeys();
                const matchedToken = allSaved.find(k => k.dataKey === sessionData.dataKey);
                const cardLabel = matchedToken ? matchedToken.cardMasked : 'Saved Card Profile';

                if (monerisVaultContainer) {
                    monerisVaultContainer.innerHTML = `
                        <div class="vault-container">
                            <div class="vault-header">
                                <div class="vault-title">
                                    <span>🔐 Moneris Vault (Card on File)</span>
                                </div>
                                <span class="vault-security-badge">
                                    <span>🔒</span> Zero-PCI Vault Token
                                </span>
                            </div>

                            <div class="vault-token-card">
                                <div class="vault-token-chip">💳</div>
                                <div>
                                    <div class="vault-token-meta">SAVED MONERIS TOKEN</div>
                                    <div class="vault-token-number">${sessionData.dataKey}</div>
                                </div>
                                <div class="vault-token-meta">
                                    <span>${cardLabel}</span>
                                    <span>${sessionData.expDate ? `EXP: ${sessionData.expDate}` : 'VAULT PROFILE'}</span>
                                </div>
                            </div>

                            <div class="vault-details-list">
                                <strong>Order ID:</strong> ${sessionData.order_no}<br>
                                <strong>Amount:</strong> $${sessionData.amount} ${sessionData.currency}<br>
                                <strong>Customer ID:</strong> ${(customerRefInput && customerRefInput.value.trim()) || '1'}<br>
                                <strong>Crypt Type:</strong> ${sessionData.cryptType || '7'}<br>
                                <strong>Transaction Type:</strong> ${actionType === 'purchase' ? 'Vault Purchase (res_purchase_cc)' : 'Card Verification (res_cardverification_cc)'}
                            </div>

                            <button type="button" id="btn-vault-confirm-pay" class="vault-submit-btn">
                                <span>${submitBtnLabel}</span>
                            </button>
                        </div>
                    `;
                }

                const vaultConfirmBtn = document.getElementById('btn-vault-confirm-pay');
                const executeVaultPayment = async () => {
                    if (vaultConfirmBtn) {
                        vaultConfirmBtn.disabled = true;
                        vaultConfirmBtn.textContent = 'Processing Vault Transaction...';
                    }
                    log(`[Moneris Vault] Submitting ${actionType} transaction for data_key '${sessionData.dataKey}' to backend...`, 'system');

                    try {
                        const processRes = await fetch('/api/moneris-process-token', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                dataKey: sessionData.dataKey,
                                orderNo: sessionData.order_no,
                                amount: sessionData.amount,
                                custId: (customerRefInput && customerRefInput.value.trim()) || '1',
                                action: actionType,
                                cryptType: sessionData.cryptType || '7',
                                mitType: (mitTypeSelect && mitTypeSelect.value) || null,
                                expDate: sessionData.expDate || undefined
                            })
                        });

                        const resultData = await processRes.json();
                        log(`[Moneris Vault Response] Status: ${processRes.status}`, resultData.success ? 'success' : 'error', resultData);
                        updateActiveAttemptStatus(resultData.success ? 'success' : 'error', sessionData.order_no);

                        if (!processRes.ok && !resultData.receipt) {
                            throw new Error(resultData.error || `HTTP ${processRes.status}`);
                        }

                        const receipt = resultData.receipt || {};
                        const isApproved = resultData.success;
                        const authCode = receipt.AuthCode || 'N/A';
                        const refNum = receipt.ReferenceNum || 'N/A';
                        const txnNum = receipt.TxnNumber || receipt.TransID || 'N/A';
                        const receiptId = receipt.ReceiptId || sessionData.order_no;
                        const message = receipt.Message || (isApproved ? 'APPROVED' : 'DECLINED');

                        let title = isApproved ? 'Moneris Vault Payment Complete!' : 'Moneris Payment Declined';
                        let subtitle = isApproved
                            ? `Payment of $${sessionData.amount} ${sessionData.currency} was successfully charged to saved token.`
                            : `Gateway response: ${message}`;

                        cleanupExistingSession();
                        if (sdkContainer) {
                            sdkContainer.classList.remove('hidden');
                            sdkContainer.innerHTML = `
                                <div class="card-success-message" style="text-align: center; padding: 40px 20px; animation: fadeIn 0.4s ease-out;">
                                    <div style="font-size: 3rem; margin-bottom: 16px;">${isApproved ? '✅' : '❌'}</div>
                                    <h3 style="color: ${isApproved ? 'var(--success)' : 'var(--error)'}; font-weight: 700; margin-bottom: 8px;">${title}</h3>
                                    <p style="font-size: 0.85rem; color: var(--text-main); margin-bottom: 16px;">${subtitle}</p>
                                    <div style="background-color: ${isApproved ? 'var(--success-light)' : 'var(--error-light)'}; color: var(--text-main); border: 1px solid ${isApproved ? 'rgba(56, 161, 105, 0.2)' : 'rgba(229, 62, 62, 0.2)'}; font-family: var(--font-mono); font-size: 0.75rem; padding: 16px; border-radius: var(--radius-md); text-align: left; line-height: 1.7; word-break: break-all;">
                                        <strong>Order ID:</strong> ${receiptId}<br>
                                        <strong>Transaction Type:</strong> Vault Purchase (res_purchase_cc)<br>
                                        <strong>Amount:</strong> $${sessionData.amount} ${sessionData.currency}<br>
                                        <strong>Status:</strong> <span style="font-weight: 700; color: ${isApproved ? 'var(--success)' : 'var(--error)'};">${isApproved ? 'APPROVED' : 'DECLINED'}</span><br>
                                        <strong>Gateway Message:</strong> <span style="font-weight: 600; color: ${isApproved ? 'var(--success)' : 'var(--error)'};">${message}</span><br>
                                        <strong>Response Code:</strong> ${receipt.ResponseCode || 'N/A'}<br>
                                        <strong>Auth Code:</strong> ${authCode}<br>
                                        <strong>Reference Num:</strong> ${refNum}<br>
                                        <strong>Txn Number:</strong> ${txnNum}<br>
                                        <strong>Charged Data Key:</strong> <span style="color: #2b6cb0; font-weight: 600;">${sessionData.dataKey}</span>
                                    </div>
                                </div>
                            `;
                        }
                    } catch (vErr) {
                        log(`[Moneris Vault Error] Payment execution failed: ${vErr.message}`, 'error');
                        alert(`Vault payment error: ${vErr.message}`);
                        if (vaultConfirmBtn) {
                            vaultConfirmBtn.disabled = false;
                            vaultConfirmBtn.textContent = submitBtnLabel;
                        }
                    }
                };

                if (vaultConfirmBtn) {
                    vaultConfirmBtn.addEventListener('click', executeVaultPayment);
                }
                return;
            }

            // FLOW B: MONERIS CHECKOUT MCO (Existing)
            log(`[System] Initializing Moneris Checkout (MCO) with ticket: ${sessionData.ticket}`, 'system');
            if (monerisContainer) monerisContainer.classList.remove('hidden');
            if (sdkContainer) sdkContainer.classList.add('hidden');

            monerisCheckoutInstance = new window.monerisCheckout();
            monerisCheckoutInstance.setMode(sessionData.environment || 'qa');
            monerisCheckoutInstance.setCheckoutDiv('moneris-checkout-ui');

            monerisCheckoutInstance.setCallback('page_loaded', () => {
                log('[Moneris Callback] Checkout page loaded inside iframe.', 'system');
            });

            monerisCheckoutInstance.setCallback('cancel_transaction', () => {
                log('[Moneris Callback] User cancelled transaction.', 'error');
                cleanupExistingSession();
                if (sdkPlaceholder) sdkPlaceholder.classList.remove('hidden');
            });

            monerisCheckoutInstance.setCallback('error_event', (err) => {
                log(`[Moneris Callback] Error event received`, 'error', err);
                updateActiveAttemptStatus('error');
            });

            let receiptHandled = false;
            const handleMonerisSuccess = async (eventName, callbackData) => {
                let parsed = {};
                try {
                    parsed = typeof callbackData === 'string' ? JSON.parse(callbackData) : callbackData;
                } catch (e) {
                    parsed = { raw: callbackData };
                }
                log(`[Moneris Callback] ${eventName}`, 'callback', parsed);
                if (receiptHandled) {
                    return;
                }
                receiptHandled = true;

                // Verify Receipt server-to-server
                const receiptReqBody = {
                    ticket: (parsed.response && parsed.response.ticket) || parsed.ticket || sessionData.ticket
                };
                log('[Proxy Moneris] Verifying transaction receipt via POST /api/moneris-receipt...', 'system');
                try {
                    const ticketToVerify = receiptReqBody.ticket;
                    const receiptRes = await fetch('/api/moneris-receipt', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ ticket: ticketToVerify })
                    });
                    const receiptData = await receiptRes.json();
                    log(`[Proxy Moneris] Receipt Status verified`, 'success', receiptData.response ? receiptData.response.receipt : receiptData);

                    const rawReceipt = receiptData?.response?.receipt || {};
                    const ccReceipt = rawReceipt.cc || rawReceipt;
                    const tokenize = ccReceipt?.tokenize || rawReceipt?.tokenize;
                    const hasToken = tokenize?.success === 'true' && Boolean(tokenize?.datakey);
                    const amount = ccReceipt?.amount || rawReceipt?.amount;
                    const isZeroDollar = amount === '0.00' || amount === '0';

                    // Check approval status according to Moneris Checkout specifications
                    const resultCode = String(rawReceipt.result || ccReceipt.result || '').toLowerCase();
                    const responseCodeStr = String(ccReceipt.response_code || rawReceipt.response_code || '');
                    const responseCodeNum = parseInt(responseCodeStr, 10);
                    const gatewayMessage = ccReceipt.message || rawReceipt.message || '';
                    const approvalCode = ccReceipt.approval_code || rawReceipt.approval_code;
                    const hasValidApprovalCode = Boolean(approvalCode && approvalCode !== 'null' && String(approvalCode).trim() !== '');

                    const isApproved = (resultCode === 'a') || 
                        (!resultCode && !isNaN(responseCodeNum) && responseCodeNum >= 0 && responseCodeNum < 50 && hasValidApprovalCode && !gatewayMessage.toUpperCase().includes('DECLIN'));

                    let title = '';
                    let subtitle = '';

                    if (isApproved) {
                        updateActiveAttemptStatus('success', sessionData.order_no);
                        if (isZeroDollar && hasToken) {
                            title = 'Card Successfully Verified & Saved!';
                            subtitle = 'Zero-dollar authorization approved and card securely tokenized.';
                        } else if (hasToken) {
                            title = 'Payment & Card Registration Complete!';
                            subtitle = amount ? `Payment of $${amount} CAD processed and card tokenized.` : 'Payment processed and card tokenized.';
                        } else {
                            title = 'Moneris Payment Complete!';
                            subtitle = amount ? `Payment of $${amount} CAD was successfully approved.` : 'Payment was successfully approved.';
                        }
                    } else {
                        updateActiveAttemptStatus('error', sessionData.order_no);
                        title = 'Moneris Payment Declined';
                        subtitle = gatewayMessage ? `Gateway response: ${gatewayMessage}` : 'The transaction was declined by Moneris.';
                    }

                    const cardMasked = tokenize?.first4last4 || ccReceipt?.first6last4 || rawReceipt?.first6last4 || null;

                    let detailsHtml = `<strong>Order No:</strong> ${sessionData.order_no}<br><strong>Ticket:</strong> ${sessionData.ticket}`;
                    if (amount !== undefined && amount !== null) {
                        detailsHtml += `<br><strong>Amount:</strong> $${amount} CAD`;
                    }
                    detailsHtml += `<br><strong>Status:</strong> <span style="font-weight: 700; color: ${isApproved ? 'var(--success)' : 'var(--error)'};">${isApproved ? 'APPROVED' : 'DECLINED'}</span>`;
                    if (gatewayMessage) {
                        detailsHtml += `<br><strong>Gateway Message:</strong> <span style="color: ${isApproved ? 'var(--success)' : 'var(--error)'}; font-weight: 600;">${gatewayMessage}</span>`;
                    }
                    if (responseCodeStr) {
                        detailsHtml += `<br><strong>Response Code:</strong> ${responseCodeStr}`;
                    }
                    if (hasValidApprovalCode) {
                        detailsHtml += `<br><strong>Approval Code:</strong> ${approvalCode}`;
                    }
                    if (ccReceipt?.transaction_no || rawReceipt?.transaction_no) {
                        detailsHtml += `<br><strong>Txn No:</strong> ${ccReceipt.transaction_no || rawReceipt.transaction_no}`;
                    }
                    if (cardMasked) {
                        detailsHtml += `<br><strong>Card:</strong> ${cardMasked}`;
                    }
                    if (hasToken) {
                        saveMonerisDataKey({
                            dataKey: tokenize.datakey,
                            cardMasked: cardMasked || '•••• •••• •••• ••••',
                            source: 'Moneris Checkout (MCO)'
                        });
                        detailsHtml += `<br><strong>Vault Token (data_key):</strong> <span style="color: #2b6cb0; font-weight: 600;">${tokenize.datakey}</span><br>`;
                        detailsHtml += `<button type="button" class="btn-use-saved-token" data-token="${tokenize.datakey}">💳 Pay Next Order with This Saved Token</button>`;
                    }

                    cleanupExistingSession();
                    if (sdkContainer) {
                        sdkContainer.classList.remove('hidden');
                        sdkContainer.innerHTML = `
                            <div class="card-success-message" style="text-align: center; padding: 40px 20px; animation: fadeIn 0.4s ease-out;">
                                <div style="font-size: 3rem; margin-bottom: 16px;">${isApproved ? '✅' : '❌'}</div>
                                <h3 style="color: ${isApproved ? 'var(--success)' : 'var(--error)'}; font-weight: 700; margin-bottom: 8px;">${title}</h3>
                                <p style="font-size: 0.85rem; color: var(--text-main); margin-bottom: 16px;">${subtitle}</p>
                                <div style="background-color: ${isApproved ? 'var(--success-light)' : 'var(--error-light)'}; color: var(--text-main); border: 1px solid ${isApproved ? 'rgba(56, 161, 105, 0.2)' : 'rgba(229, 62, 62, 0.2)'}; font-family: var(--font-mono); font-size: 0.75rem; padding: 12px; border-radius: var(--radius-md); word-break: break-all; text-align: left; line-height: 1.6;">
                                    ${detailsHtml}
                                </div>
                            </div>
                        `;
                    }
                } catch (rErr) {
                    log(`[Proxy Moneris Error] Receipt verification error: ${rErr.message}`, 'error');
                }
            };

            monerisCheckoutInstance.setCallback('payment_receipt', (data) => handleMonerisSuccess('payment_receipt', data));
            monerisCheckoutInstance.setCallback('payment_complete', (data) => handleMonerisSuccess('payment_complete', data));
            monerisCheckoutInstance.setCallback('payment_submitted', () => {
                log('[Moneris Callback] Payment submitted by user.', 'system');
            });
            monerisCheckoutInstance.setCallback('page_closed', () => {
                log('[Moneris Callback] Checkout page closed.', 'system');
            });

            log('[System] Launching Moneris startCheckout()...', 'system');
            monerisCheckoutInstance.startCheckout(sessionData.ticket);
        }
    }
};

/**
 * Returns the currently selected PSP configuration object
 */
function getSelectedPsp() {
    const pspId = pspProviderSelect ? pspProviderSelect.value : 'littlepay';
    return SUPPORTED_PSPS[pspId] || SUPPORTED_PSPS.littlepay;
}

/**
 * Populates the PSP select element dynamically from the registry
 */
function populatePspSelect() {
    if (!pspProviderSelect) return;
    const currentVal = pspProviderSelect.value;
    pspProviderSelect.innerHTML = '';
    
    Object.values(SUPPORTED_PSPS).forEach((psp, index) => {
        const option = document.createElement('option');
        option.value = psp.id;
        option.textContent = psp.name;
        if (currentVal ? psp.id === currentVal : index === 0) {
            option.selected = true;
        }
        pspProviderSelect.appendChild(option);
    });
}

/**
 * Synchronizes checkout methods dropdown options with current PSP capabilities
 */
function populateCheckoutMethods(pspConfig) {
    if (!checkoutMethodSelect) return;
    const currentVal = checkoutMethodSelect.value;
    checkoutMethodSelect.innerHTML = '';

    pspConfig.supportedMethods.forEach(method => {
        const option = document.createElement('option');
        option.value = method.id;
        option.textContent = method.label;
        if (method.id === currentVal) {
            option.selected = true;
        }
        checkoutMethodSelect.appendChild(option);
    });

    if (!pspConfig.supportedMethods.some(m => m.id === currentVal)) {
        checkoutMethodSelect.value = pspConfig.defaultMethod || pspConfig.supportedMethods[0]?.id || 'sdk';
    }
}

/**
 * Updates UI based on the selected Payment Service Provider (PSP)
 */
function updatePspUI() {
    const psp = getSelectedPsp();
    const pspBadge = document.getElementById('psp-badge');
    const checkoutMethodGroup = document.getElementById('checkout-method-group');

    if (pspBadge) {
        pspBadge.textContent = psp.badge;
    }
    if (littlepaySettingsContainer) {
        littlepaySettingsContainer.style.display = psp.features.customSettings ? 'block' : 'none';
    }
    if (mitTypeGroup) {
        mitTypeGroup.style.display = psp.features.mitType ? 'block' : 'none';
    }
    if (checkoutMethodGroup) {
        checkoutMethodGroup.style.display = psp.features.checkoutMethod ? 'block' : 'none';
    }

    // Populate checkout methods supported by this PSP
    populateCheckoutMethods(psp);

    // Auto-update currency if field is empty or was set to another PSP's default currency
    if (orderCurrencyInput) {
        const otherDefaults = Object.values(SUPPORTED_PSPS)
            .filter(p => p.id !== psp.id)
            .map(p => p.defaultCurrency);

        if (!orderCurrencyInput.value || otherDefaults.includes(orderCurrencyInput.value)) {
            orderCurrencyInput.value = psp.defaultCurrency;
        }
    }

    log(`[System] Switched Payment Service Provider to ${psp.name}.`, 'system');
    updateCheckoutMethodUI();
}

/**
 * Updates UI labels and placeholders based on chosen checkout method & PSP
 */
function updateCheckoutMethodUI() {
    const psp = getSelectedPsp();
    const method = checkoutMethodSelect ? checkoutMethodSelect.value : psp.defaultMethod;
    
    if (monerisVaultSettingsContainer) {
        monerisVaultSettingsContainer.style.display = (psp.id === 'moneris' && method === 'vault') ? 'block' : 'none';
        if (psp.id === 'moneris' && method === 'vault') {
            populateSavedDataKeysDropdown();
        }
    }

    const previewTitle = document.getElementById('preview-section-title');
    const previewSubtitle = document.getElementById('preview-section-subtitle');
    const placeholderTitle = document.getElementById('placeholder-title');
    const placeholderText = document.getElementById('placeholder-text');

    const texts = (psp.previewTexts && (psp.previewTexts[method] || psp.previewTexts.default)) || {};
    const btnText = (psp.buttonText && (psp.buttonText[method] || psp.buttonText.default)) || 'Initialize Checkout';

    if (submitBtn) submitBtn.textContent = btnText;
    if (previewTitle && texts.title) previewTitle.textContent = texts.title;
    if (previewSubtitle && texts.subtitle) previewSubtitle.textContent = texts.subtitle;
    if (placeholderTitle && texts.placeholderTitle) placeholderTitle.textContent = texts.placeholderTitle;
    if (placeholderText && texts.placeholderText) placeholderText.textContent = texts.placeholderText;
}

/**
 * Clears and unmounts any active PSP sessions safely
 */
function cleanupExistingSession() {
    Object.values(SUPPORTED_PSPS).forEach(psp => {
        if (typeof psp.cleanup === 'function') {
            psp.cleanup();
        }
        if (psp.containerId) {
            const container = document.getElementById(psp.containerId);
            if (container) {
                container.innerHTML = '';
                container.classList.add('hidden');
            }
        }
    });

    if (monerisVaultContainer) {
        monerisVaultContainer.innerHTML = '';
        monerisVaultContainer.classList.add('hidden');
    }

    if (sdkContainer) {
        sdkContainer.innerHTML = '';
        sdkContainer.classList.add('hidden');
    }
}

/**
 * Communicates with our zero-dependency backend proxy to construct a secure checkout session
 */
async function createCheckoutSession() {
    const psp = getSelectedPsp();
    const customerRef = customerRefInput.value.trim() || '1';
    const rawAmount = parseInt(orderAmountInput.value.trim(), 10);
    const amount = Number.isInteger(rawAmount) ? rawAmount : 811;
    const currency = orderCurrencyInput.value.trim() || psp.defaultCurrency;
    const mitType = mitTypeSelect.value;
    const checkoutMethod = checkoutMethodSelect ? checkoutMethodSelect.value : psp.defaultMethod;
    const disableSavedCards = disableSavedSelect ? disableSavedSelect.value === 'true' : false;

    log(`[Proxy API] Initializing payload for secure local proxy (/api/create-session) for PSP [${psp.name.toUpperCase()}] in ${checkoutMethod.toUpperCase()} mode...`, 'system');
    
    // Parse custom dynamic metadata fields
    const metadata = {};
    const metadataContainer = document.getElementById('metadata-rows-container');
    if (metadataContainer) {
        const keyInputs = metadataContainer.querySelectorAll('.metadata-key');
        const valueInputs = metadataContainer.querySelectorAll('.metadata-value');
        keyInputs.forEach((keyInput, index) => {
            const key = keyInput.value.trim();
            const val = valueInputs[index].value.trim();
            if (key) {
                metadata[key] = val;
            }
        });
    }

    const payload = {
        psp: psp.id,
        mitType: mitType,
        checkoutMethod: checkoutMethod,
        disableSavedCards: disableSavedCards,
        locale: localeSelect ? localeSelect.value : 'en-GB',
        dataKey: monerisVaultDataKeyInput ? monerisVaultDataKeyInput.value.trim() : undefined,
        monerisVaultDataKey: monerisVaultDataKeyInput ? monerisVaultDataKeyInput.value.trim() : undefined,
        monerisVaultExpDate: monerisVaultExpDateInput ? monerisVaultExpDateInput.value.trim() : undefined,
        monerisVaultCryptType: monerisVaultCryptTypeSelect ? monerisVaultCryptTypeSelect.value : '7',
        monerisActionType: (checkoutMethod === 'vault' && monerisVaultActionTypeSelect) ? monerisVaultActionTypeSelect.value : 'purchase',
        orderPayload: {
            customer_ref: customerRef,
            charge: {
                amount: amount,
                currency: currency
            },
            metadata: metadata
        }
    };

    log(`[Proxy API] POST /api/create-session (${psp.name} - ${checkoutMethod.toUpperCase()})`, 'system', payload);

    try {
        const proxyResponse = await fetch('/api/create-session', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (!proxyResponse.ok) {
            const errText = await proxyResponse.text();
            let parsedErr;
            try {
                parsedErr = JSON.parse(errText).error;
            } catch(e) {
                parsedErr = errText;
            }
            throw new Error(parsedErr || proxyResponse.statusText);
        }

        const sessionData = await proxyResponse.json();
        log(`[Proxy API] Session created for [${psp.name.toUpperCase()}]`, 'success', sessionData);
        if (sessionData.order_no || sessionData.id) {
            updateActiveAttemptStatus('pending', sessionData.order_no || sessionData.id);
        }
        
        return sessionData;

    } catch (err) {
        log(`[Proxy API Error] Local proxy server request failed: ${err.message}`, 'error');
        updateActiveAttemptStatus('error');
        throw err;
    }
}

/**
 * High-level form submission handler delegating to the selected PSP mount flow
 */
async function initializeSdkFlow(e) {
    e.preventDefault();
    
    let sessionData = null;
    const originalBtnText = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Preparing Session...';

    cleanupExistingSession();

    const psp = getSelectedPsp();
    const rawAmount = parseInt(orderAmountInput ? orderAmountInput.value.trim() : '811', 10);
    const amount = Number.isInteger(rawAmount) ? rawAmount : 811;
    const currency = (orderCurrencyInput && orderCurrencyInput.value.trim()) || psp.defaultCurrency;
    const checkoutMethod = checkoutMethodSelect ? checkoutMethodSelect.value : psp.defaultMethod;
    const customerRef = (customerRefInput && customerRefInput.value.trim()) || '1';

    startPaymentAttemptLog({
        pspId: psp.id,
        pspName: psp.name,
        method: checkoutMethod,
        amount: amount,
        currency: currency,
        customerRef: customerRef
    });

    try {
        sessionData = await createCheckoutSession();
    } catch (apiError) {
        log(`[Error] Failed to initialize checkout session: ${apiError.message}`, 'error');
        alert(`Failed to initialize checkout session:\n"${apiError.message}"`);
        submitBtn.disabled = false;
        submitBtn.textContent = originalBtnText;
        return;
    }

    const pspConfig = SUPPORTED_PSPS[sessionData.psp] || getSelectedPsp();
    if (!pspConfig) {
        const errorMsg = `Unsupported PSP: ${sessionData.psp}`;
        log(`[Error] ${errorMsg}`, 'error');
        alert(errorMsg);
        submitBtn.disabled = false;
        submitBtn.textContent = originalBtnText;
        return;
    }

    // Verify SDK availability if required by PSP
    if (typeof pspConfig.checkSdkAvailable === 'function' && !pspConfig.checkSdkAvailable()) {
        const errorMsg = pspConfig.sdkMissingMessage || `${pspConfig.name} SDK script failed to load.`;
        log(`[Error] ${errorMsg}`, 'error');
        alert(errorMsg);
        submitBtn.disabled = false;
        submitBtn.textContent = originalBtnText;
        if (sdkPlaceholder) sdkPlaceholder.classList.remove('hidden');
        return;
    }

    // Reset UI Panel
    if (sdkPlaceholder) sdkPlaceholder.classList.add('hidden');
    if (unmountBtn) unmountBtn.disabled = false;

    try {
        await pspConfig.mount(sessionData, {
            log,
            cleanupExistingSession,
            submitBtn,
            originalBtnText,
            sdkPlaceholder,
            unmountBtn,
            sdkContainer,
            monerisContainer
        });
    } catch (err) {
        log(`[System Error] ${pspConfig.name} initialization failure: ${err.message}`, 'error');
        console.error(`${pspConfig.name} initialization failure:`, err);
        if (sdkPlaceholder) sdkPlaceholder.classList.remove('hidden');
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = originalBtnText;
    }
}

// Attach Event Listeners
document.addEventListener('DOMContentLoaded', () => {
    setupColorPickers();
    
    // Populate PSP select from registry
    populatePspSelect();

    // Populate any saved Moneris tokens from localStorage
    populateSavedDataKeysDropdown();

    // Handle selecting a saved token from dropdown
    if (monerisSavedTokensSelect) {
        monerisSavedTokensSelect.addEventListener('change', function() {
            if (this.value === 'custom') {
                if (monerisVaultDataKeyInput) {
                    monerisVaultDataKeyInput.value = '';
                    monerisVaultDataKeyInput.placeholder = 'Paste custom data_key here...';
                    monerisVaultDataKeyInput.focus();
                }
            } else if (this.value) {
                if (monerisVaultDataKeyInput) {
                    monerisVaultDataKeyInput.value = this.value;
                }
            }
        });
    }

    // Handle clear saved tokens
    if (btnClearSavedTokens) {
        btnClearSavedTokens.addEventListener('click', () => {
            if (confirm('Are you sure you want to clear all locally saved Moneris tokens?')) {
                localStorage.removeItem(STORAGE_KEY_MONERIS_TOKENS);
                populateSavedDataKeysDropdown();
                log('[Moneris Vault] Cleared all saved tokens from local storage.', 'system');
            }
        });
    }

    // Delegated 1-click listener for 'Pay Next Order with This Saved Token' buttons
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('.btn-use-saved-token');
        if (btn) {
            const token = btn.getAttribute('data-token');
            if (token) {
                selectMonerisSavedTokenForPayment(token);
            }
        }
    });

    // Attach checkout method and PSP change listeners
    if (checkoutMethodSelect) {
        checkoutMethodSelect.addEventListener('change', updateCheckoutMethodUI);
    }
    if (pspProviderSelect) {
        pspProviderSelect.addEventListener('change', updatePspUI);
        updatePspUI();
    } else {
        updateCheckoutMethodUI();
    }
    
    // Check script load status dynamically for all registered PSPs
    Object.values(SUPPORTED_PSPS).forEach(psp => {
        if (typeof psp.checkSdkAvailable === 'function') {
            if (!psp.checkSdkAvailable()) {
                log(`[System] Note: ${psp.name} SDK script is not available or loading.`, 'system');
            } else {
                log(`[System] ${psp.name} SDK CDN script loaded successfully.`, 'success');
            }
        }
    });
    
    if (configForm) {
        configForm.addEventListener('submit', initializeSdkFlow);
    }

    // Setup Custom Dynamic Metadata Rows
    const addMetadataBtn = document.getElementById('btn-add-metadata');
    const metadataContainer = document.getElementById('metadata-rows-container');

    if (addMetadataBtn && metadataContainer) {
        const existingRemoveBtns = metadataContainer.querySelectorAll('.btn-remove-row');
        existingRemoveBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                btn.parentElement.remove();
                log('[System] Custom metadata field removed.', 'system');
            });
        });

        addMetadataBtn.addEventListener('click', () => {
            const row = document.createElement('div');
            row.className = 'metadata-row';
            row.style.display = 'flex';
            row.style.gap = '8px';
            row.style.alignItems = 'center';
            row.style.animation = 'fadeIn 0.2s ease';
            
            row.innerHTML = `
                <input type="text" class="metadata-key" placeholder="Key" style="flex: 1; padding: 6px 10px; font-size: 0.8rem; border: 1px solid var(--border-color); border-radius: var(--radius-sm);">
                <input type="text" class="metadata-value" placeholder="Value" style="flex: 1; padding: 6px 10px; font-size: 0.8rem; border: 1px solid var(--border-color); border-radius: var(--radius-sm);">
                <button type="button" class="btn-remove-row" style="background: none; border: none; color: var(--error); font-size: 1.25rem; cursor: pointer; padding: 0 4px; line-height: 1;">×</button>
            `;
            
            const removeBtn = row.querySelector('.btn-remove-row');
            removeBtn.addEventListener('click', () => {
                row.remove();
                log('[System] Custom metadata field removed.', 'system');
            });
            
            metadataContainer.appendChild(row);
            log('[System] New custom metadata field added.', 'system');
        });
    }
    
    if (unmountBtn) {
        unmountBtn.addEventListener('click', () => {
            cleanupExistingSession();
            unmountBtn.disabled = true;
            if (sdkPlaceholder) sdkPlaceholder.classList.remove('hidden');
            if (sdkContainer) {
                sdkContainer.classList.add('hidden');
                sdkContainer.innerHTML = '';
            }
        });
    }
    
    // Logs Toolbar Actions: Clear, Copy All, Expand Height, Fullscreen Modal
    if (clearLogsBtn) {
        clearLogsBtn.addEventListener('click', () => {
            if (logsContainer) logsContainer.innerHTML = '';
            allLogGroups.length = 0;
            activeLogGroup = null;
            logAttemptCounter = 0;
            updateLogsCountBadge();
            log('[System] Logs cleared.', 'system');
        });
    }

    if (copyAllLogsBtn) {
        copyAllLogsBtn.addEventListener('click', () => {
            if (allLogGroups.length === 0) return;
            const fullText = allLogGroups.map(g => formatGroupForClipboard(g)).join('\n\n' + '='.repeat(60) + '\n\n');
            copyTextWithFeedback(fullText, copyAllLogsBtn, '📋 Copy All', '✅ All Copied!');
        });
    }

    if (expandLogsBtn && logsContainer) {
        expandLogsBtn.addEventListener('click', () => {
            logsContainer.style.height = ''; // Reset manual drag height if any
            const isExpanded = logsContainer.classList.toggle('logs-expanded');
            expandLogsBtn.classList.toggle('active', isExpanded);
            expandLogsBtn.textContent = isExpanded ? '↕️ Default Size' : '↕️ Taller';
        });
    }

    let logsBackdrop = document.querySelector('.logs-backdrop');
    if (!logsBackdrop) {
        logsBackdrop = document.createElement('div');
        logsBackdrop.className = 'logs-backdrop';
        document.body.appendChild(logsBackdrop);
    }

    const toggleFullscreenLogs = (forceState) => {
        if (!logsCard) return;
        const willBeFullscreen = typeof forceState === 'boolean'
            ? forceState
            : !logsCard.classList.contains('logs-fullscreen');

        logsCard.classList.toggle('logs-fullscreen', willBeFullscreen);
        if (logsBackdrop) logsBackdrop.classList.toggle('active', willBeFullscreen);
        if (fullscreenLogsBtn) {
            fullscreenLogsBtn.classList.toggle('active', willBeFullscreen);
            fullscreenLogsBtn.textContent = willBeFullscreen ? '✕ Exit Fullscreen' : '⛶ Maximize';
        }
    };

    if (fullscreenLogsBtn) {
        fullscreenLogsBtn.addEventListener('click', () => toggleFullscreenLogs());
    }
    if (logsBackdrop) {
        logsBackdrop.addEventListener('click', () => toggleFullscreenLogs(false));
    }
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && logsCard && logsCard.classList.contains('logs-fullscreen')) {
            toggleFullscreenLogs(false);
        }
    });
    
    log('[System] Demo playground ready. Configure theme or input a token to start.', 'system');
});
