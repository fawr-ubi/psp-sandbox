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

const LOGS_BROADCAST_CHANNEL_NAME = 'psp_sandbox_live_logs_v1';
const LOGS_SNAPSHOT_STORAGE_KEY = 'psp_sandbox_logs_snapshot_v1';
let logsBroadcastChannel = null;
try {
    if (typeof BroadcastChannel !== 'undefined') {
        logsBroadcastChannel = new BroadcastChannel(LOGS_BROADCAST_CHANNEL_NAME);
    }
} catch (e) {
    logsBroadcastChannel = null;
}

function broadcastLogEvent(eventPayload) {
    if (!logsBroadcastChannel) return;
    try {
        logsBroadcastChannel.postMessage(eventPayload);
    } catch (e) {
        // Ignore broadcast serialization errors
    }
}

function saveLogsSnapshotForNewTab() {
    try {
        const serializableGroups = allLogGroups.map(g => ({
            isSystemGroup: g.isSystemGroup,
            pspId: g.pspId,
            pspName: g.pspName,
            title: g.title,
            metaText: g.metaText,
            status: g.status,
            entries: g.entries.map(e => ({
                timestamp: e.timestamp,
                type: e.type,
                category: e.category,
                cleanText: e.cleanText,
                payload: e.payload
            }))
        }));
        localStorage.setItem(LOGS_SNAPSHOT_STORAGE_KEY, JSON.stringify(serializableGroups));
    } catch (e) {
        // Ignore quota errors
    }
}

/**
 * Starts a new dedicated Payment Attempt section in the logs panel
 */
function startPaymentAttemptLog({ pspId, pspName, method, amount, currency, customerRef }, fromBroadcast = false) {
    const formattedAmount = amount !== undefined && amount !== null
        ? `${(Number(amount) / 100).toFixed(2)} ${currency || ''}`.trim()
        : '';
    const grp = createLogGroup({
        isSystemGroup: false,
        pspId: pspId || 'system',
        pspName: pspName || 'PSP',
        method: method || 'sdk',
        amountDisplay: formattedAmount,
        customerRef: customerRef || '1'
    });
    if (!fromBroadcast) {
        broadcastLogEvent({
            action: 'start_attempt',
            data: { pspId, pspName, method, amount, currency, customerRef }
        });
    }
    return grp;
}

/**
 * Updates the status pill and border color of the current payment attempt
 */
function updateActiveAttemptStatus(newStatus, extraMeta = '', fromBroadcast = false) {
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

    if (!fromBroadcast) {
        broadcastLogEvent({
            action: 'update_status',
            data: { newStatus, extraMeta }
        });
    }
}

/**
 * Utility to log messages into our structured console log view
 */
function log(message, type = 'system', explicitData = null, fromBroadcast = false) {
    const timestamp = new Date().toLocaleTimeString();

    if (!activeLogGroup) {
        createLogGroup({ isSystemGroup: true });
    }

    const { category, catClass, cleanText, payload } = parseLogContent(message, explicitData, type);

    // Auto-update attempt status on error or final callback
    if (!activeLogGroup.isSystemGroup) {
        if (type === 'error') {
            updateActiveAttemptStatus('error', '', fromBroadcast);
        } else if (type === 'success' && (
            category.toUpperCase().includes('CALLBACK') ||
            cleanText.includes('registered successfully') ||
            cleanText.includes('Receipt Status') ||
            cleanText.includes('Final Link') ||
            category.toUpperCase().includes('RESPONSE')
        )) {
            updateActiveAttemptStatus('success', '', fromBroadcast);
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

    if (!fromBroadcast) {
        broadcastLogEvent({
            action: 'log_entry',
            data: { message, type, explicitData }
        });
    }

    const hasPayload = payload !== null && payload !== undefined;

    const entry = document.createElement('div');
    entry.className = `log-entry ${type}${hasPayload ? ' has-payload' : ''}`;

    const topRow = document.createElement('div');
    topRow.className = `log-entry-top${hasPayload ? ' has-payload' : ''}`;

    const mainCol = document.createElement('div');
    mainCol.className = 'log-entry-main';

    // Line-by-line Collapse / Expand button
    const collapseLineBtn = document.createElement('button');
    collapseLineBtn.type = 'button';
    collapseLineBtn.className = 'log-entry-collapse-btn';
    collapseLineBtn.textContent = '▼';
    collapseLineBtn.title = hasPayload
        ? 'Collapse / Expand this log line and its payload'
        : 'Collapse / Expand this log line';

    const toggleEntryCollapsed = (e) => {
        if (e) e.stopPropagation();
        const isCollapsed = entry.classList.toggle('entry-collapsed');
        const foldLineBtn = entry.querySelector('.log-fold-line-btn');
        if (foldLineBtn) {
            foldLineBtn.textContent = isCollapsed ? '➕ Unfold Line' : '➖ Fold Line';
        }
    };

    collapseLineBtn.addEventListener('click', toggleEntryCollapsed);

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

    mainCol.appendChild(collapseLineBtn);
    mainCol.appendChild(timeSpan);
    mainCol.appendChild(catSpan);
    mainCol.appendChild(msgSpan);

    if (hasPayload) {
        const collapsedPill = document.createElement('span');
        collapsedPill.className = 'log-collapsed-payload-pill';
        const keyCount = (typeof payload === 'object' && payload !== null) ? Object.keys(payload).length : 0;
        collapsedPill.textContent = keyCount > 0 ? `{… ${keyCount} keys — click to expand}` : '{… payload hidden — click to expand}';
        collapsedPill.title = 'Click to expand JSON payload';
        collapsedPill.addEventListener('click', toggleEntryCollapsed);
        mainCol.appendChild(collapsedPill);

        topRow.addEventListener('click', (e) => {
            if (e.target.closest('button')) return;
            toggleEntryCollapsed();
        });
    }

    topRow.appendChild(mainCol);

    // Individual copy button if entry is a callback, error, response, or has payload
    const isImportantEntry = hasPayload ||
        type === 'callback' ||
        type === 'error' ||
        category.toUpperCase().includes('CALLBACK') ||
        category.toUpperCase().includes('RESPONSE');

    if (isImportantEntry && !hasPayload) {
        const copyEntryBtn = document.createElement('button');
        copyEntryBtn.type = 'button';
        copyEntryBtn.className = 'btn-copy-entry';
        copyEntryBtn.textContent = '📋 Copy';
        copyEntryBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const rawText = `[${timestamp}] [${category}] ${cleanText}`;
            copyTextWithFeedback(rawText, copyEntryBtn, '📋 Copy');
        });
        topRow.appendChild(copyEntryBtn);
    }

    entry.appendChild(topRow);

    // Render pretty JSON / structured payload block if present
    if (hasPayload) {
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

        const foldPayloadBtn = document.createElement('button');
        foldPayloadBtn.type = 'button';
        foldPayloadBtn.className = 'btn-copy-entry log-fold-line-btn';
        foldPayloadBtn.textContent = '➖ Fold Line';
        foldPayloadBtn.title = 'Collapse this log entry & payload into a single line';
        foldPayloadBtn.addEventListener('click', toggleEntryCollapsed);
        toolbarActions.appendChild(foldPayloadBtn);

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

        // Populate Local Callback LittlePay fields with the latest checkout values
        populateLittlepayCallbackFieldsFromReceipt({
            orderId: receiptData.order_id || sessionData.id || '',
            transactionId: receiptData.payment_intent_id || paymentIntentId || '',
            fundingSourceId: fundingSourceId !== 'N/A' ? fundingSourceId : '',
            cardMask: formattedMaskedPan !== 'SAVED_CARD' ? formattedMaskedPan : (cardMask16 !== 'N/A' ? cardMask16 : '************4242'),
            cardExpiry: cardExpiry !== 'N/A' ? cardExpiry : '12/28',
            cardType: cardType !== 'N/A' ? cardType : 'VISA',
            amount: amount,
            currency: currency,
            customerRef: receiptData.customer_ref || customerRef || ''
        });

        detailsHtml += `
            <div style="margin-top: 10px; padding-top: 10px; border-top: 1px dashed rgba(47, 133, 90, 0.25);">
                <button type="button" class="btn-use-saved-token btn-forward-callback-inline btn-trigger-local-cb" data-psp="littlepay" data-order-id="${receiptData.order_id || sessionData.id || ''}" style="width: 100%; padding: 8px 12px; font-size: 0.78rem; font-weight: 700; color: #ffffff; background: linear-gradient(135deg, #276749 0%, #2f855a 100%); border: none; border-radius: 6px; cursor: pointer;">
                    🔄 Forward Callback to Local Server (wfwp-platform)
                </button>
            </div>
        `;
        detailsHtml += `<div id="inline-cb-forward-status" style="margin-top: 10px;"></div>`;

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

        if (isApproved) {
            updateCallbackStepper(2, 'done');
            if (isLocalCallbackEnabled()) {
                await forwardLocalCallbackToBackend({ psp: 'littlepay', autoTriggered: true });
            }
        } else {
            updateCallbackStepper(2, 'error');
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

                    const cbMonerisTicketInput = document.getElementById('cbMonerisTicket');
                    if (cbMonerisTicketInput && sessionData.ticket) {
                        cbMonerisTicketInput.value = sessionData.ticket;
                    }

                    detailsHtml += `
                        <div style="margin-top: 10px; padding-top: 10px; border-top: 1px dashed rgba(43, 108, 176, 0.25);">
                            <button type="button" class="btn-forward-callback-inline" data-psp="moneris" data-ticket="${sessionData.ticket || ''}" style="width: 100%; padding: 8px 12px; font-size: 0.78rem; font-weight: 700; color: #ffffff; background: linear-gradient(135deg, #2b6cb0 0%, #3182ce 100%); border: none; border-radius: 6px; cursor: pointer;">
                                🔄 Forward Callback to Local Server (wfwp-platform)
                            </button>
                        </div>
                    `;

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

                    updateCallbackStepper(2, 'done');
                    if (isLocalCallbackEnabled() && isApproved) {
                        log('[Local Callback] Auto-forwarding enabled: forwarding Moneris callback to local server...', 'system');
                        setTimeout(() => {
                            forwardLocalCallbackToBackend({ psp: 'moneris', autoTriggered: true });
                        }, 300);
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

    const cbLittlepayFields = document.getElementById('cb-littlepay-fields');
    const cbMonerisFields = document.getElementById('cb-moneris-fields');
    const cbWindowPspChip = document.getElementById('cb-window-psp-chip');
    if (cbLittlepayFields) cbLittlepayFields.style.display = psp.id === 'littlepay' ? 'block' : 'none';
    if (cbMonerisFields) cbMonerisFields.style.display = psp.id === 'moneris' ? 'block' : 'none';
    if (cbWindowPspChip) cbWindowPspChip.textContent = psp.id.toUpperCase();
    syncLocalCallbackMerchantForPsp(psp.id);
}

/**
 * Updates UI labels and placeholders based on chosen checkout method & PSP
 */
function updateCheckoutMethodUI() {
    const psp = getSelectedPsp();
    const method = checkoutMethodSelect ? checkoutMethodSelect.value : psp.defaultMethod;
    const monerisProfileContainer = document.getElementById('moneris-profile-settings-container');

    if (monerisProfileContainer) {
        monerisProfileContainer.style.display = (psp.id === 'moneris' && method === 'sdk') ? 'block' : 'none';
    }

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

    const monerisCheckoutIdInput = document.getElementById('monerisCheckoutIdInput');
    const monerisProfileAliasSelect = document.getElementById('monerisProfileAliasSelect');

    const payload = {
        psp: psp.id,
        mitType: mitType,
        checkoutMethod: checkoutMethod,
        disableSavedCards: disableSavedCards,
        locale: localeSelect ? localeSelect.value : 'en-GB',
        checkoutId: (psp.id === 'moneris' && monerisCheckoutIdInput) ? monerisCheckoutIdInput.value.trim() : undefined,
        checkoutProfileAlias: (psp.id === 'moneris' && monerisProfileAliasSelect) ? monerisProfileAliasSelect.value : undefined,
        dataKey: monerisVaultDataKeyInput ? monerisVaultDataKeyInput.value.trim() : undefined,
        monerisVaultDataKey: monerisVaultDataKeyInput ? monerisVaultDataKeyInput.value.trim() : undefined,
        monerisVaultExpDate: monerisVaultExpDateInput ? monerisVaultExpDateInput.value.trim() : undefined,
        monerisVaultCryptType: monerisVaultCryptTypeSelect ? monerisVaultCryptTypeSelect.value : '7',
        monerisActionType: (checkoutMethod === 'vault' && monerisVaultActionTypeSelect) ? monerisVaultActionTypeSelect.value : 'purchase',
        localCallback: getLocalCallbackConfigObject(),
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
        if (sessionData.ticket) {
            const cbMonerisTicketInput = document.getElementById('cbMonerisTicket');
            if (cbMonerisTicketInput) {
                cbMonerisTicketInput.value = sessionData.ticket;
            }
        }
        updateCallbackStepper(2, 'active');
        
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
    
    // Logs Toolbar Actions: Clear, Copy All, Fold Payloads, New Tab, Expand Height, Fullscreen Modal
    const foldAllPayloadsBtn = document.getElementById('btn-fold-all-payloads');
    const openLogsNewTabBtn = document.getElementById('btn-open-logs-new-tab');
    let allPayloadsFolded = false;

    if (foldAllPayloadsBtn) {
        foldAllPayloadsBtn.addEventListener('click', () => {
            allPayloadsFolded = !allPayloadsFolded;
            const payloadEntries = logsContainer ? logsContainer.querySelectorAll('.log-entry.has-payload') : [];
            payloadEntries.forEach(entry => {
                entry.classList.toggle('entry-collapsed', allPayloadsFolded);
                const foldLineBtn = entry.querySelector('.log-fold-line-btn');
                if (foldLineBtn) foldLineBtn.textContent = allPayloadsFolded ? '➕ Unfold Line' : '➖ Fold Line';
            });
            foldAllPayloadsBtn.classList.toggle('active', allPayloadsFolded);
            foldAllPayloadsBtn.textContent = allPayloadsFolded ? '🔼 Unfold Payloads' : '🔽 Fold Payloads';
        });
    }

    if (openLogsNewTabBtn) {
        openLogsNewTabBtn.addEventListener('click', () => {
            saveLogsSnapshotForNewTab();
            window.open('/?view=logs', '_blank');
        });
    }

    if (clearLogsBtn) {
        clearLogsBtn.addEventListener('click', () => {
            if (logsContainer) logsContainer.innerHTML = '';
            allLogGroups.length = 0;
            activeLogGroup = null;
            logAttemptCounter = 0;
            updateLogsCountBadge();
            broadcastLogEvent({ action: 'clear_logs' });
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

    setupLocalCallbackPanel();

    // Top-level Navigation Tabs (Checkout & SDK vs Local Backend Callback)
    const tabBtnCheckout = document.getElementById('tab-btn-checkout');
    const tabBtnCallback = document.getElementById('tab-btn-callback');
    if (tabBtnCheckout) {
        tabBtnCheckout.addEventListener('click', () => switchSandboxTab('checkout'));
    }
    if (tabBtnCallback) {
        tabBtnCallback.addEventListener('click', () => switchSandboxTab('callback'));
    }

    // URL Query Parameters Support (?tab=callback or ?view=logs)
    const urlParams = new URLSearchParams(window.location.search);
    const requestedTab = urlParams.get('tab');
    const requestedView = urlParams.get('view');

    if (requestedTab === 'callback') {
        switchSandboxTab('callback');
    }

    if (requestedView === 'logs') {
        document.body.classList.add('standalone-logs-view');
        document.title = 'PSP Sandbox — Live Logs & Events';
        try {
            const rawSnap = localStorage.getItem(LOGS_SNAPSHOT_STORAGE_KEY);
            if (rawSnap) {
                const parsedSnap = JSON.parse(rawSnap);
                const snapGroups = Array.isArray(parsedSnap)
                    ? parsedSnap
                    : (Array.isArray(parsedSnap?.groups) ? parsedSnap.groups : []);
                if (snapGroups.length > 0) {
                    if (logsContainer) logsContainer.innerHTML = '';
                    allLogGroups.length = 0;
                    activeLogGroup = null;
                    logAttemptCounter = 0;
                    snapGroups.forEach(g => {
                        createLogGroup({
                            isSystemGroup: Boolean(g.isSystemGroup),
                            pspId: g.pspId || 'system',
                            pspName: g.pspName || 'PSP',
                            method: g.method || 'sdk',
                            amountDisplay: g.amountDisplay || '',
                            customerRef: g.customerRef || ''
                        });
                        if (g.status && g.status !== 'pending' && !g.isSystemGroup) {
                            updateActiveAttemptStatus(g.status, '', true);
                        }
                        if (Array.isArray(g.entries)) {
                            g.entries.forEach(entry => {
                                const msgText = entry.message || (entry.category ? `[${entry.category}] ${entry.cleanText || ''}` : (entry.cleanText || ''));
                                log(msgText, entry.type || 'info', entry.payload, true);
                            });
                        }
                    });
                }
            }
        } catch (e) {
            // Ignore snapshot parse error
        }

        if (logsBroadcastChannel) {
            logsBroadcastChannel.onmessage = (event) => {
                const msg = event.data;
                const action = msg && (msg.action || msg.eventType);
                if (!action) return;
                if (action === 'start_attempt' && msg.data) {
                    startPaymentAttemptLog(msg.data, true);
                } else if (action === 'update_status' && msg.data) {
                    updateActiveAttemptStatus(msg.data.newStatus || msg.data.status, msg.data.extraMeta || msg.data.label || '', true);
                } else if (action === 'log_entry' && msg.data) {
                    log(msg.data.message, msg.data.type, msg.data.explicitData !== undefined ? msg.data.explicitData : msg.data.payload, true);
                } else if (action === 'clear_logs' || action === 'clear') {
                    if (logsContainer) logsContainer.innerHTML = '';
                    allLogGroups.length = 0;
                    activeLogGroup = null;
                    logAttemptCounter = 0;
                    updateLogsCountBadge();
                }
            };
        }
        log('[System] Standalone Live Logs tab connected. Listening for real-time events from main sandbox tab...', 'system');
    } else {
        log('[System] Demo playground ready. Configure theme or input a token to start.', 'system');
    }
});

// =========================================================================
// Local Backend Callback Forwarding (wfwp-platform)
// =========================================================================
const STORAGE_KEY_LOCAL_CALLBACK = 'psp_sandbox_local_callback_state_v2';
let localDiscoveredDbEntities = { merchants: [], carts: [], passengers: [] };

function isLocalCallbackEnabled() {
    const toggle = document.getElementById('localCallbackEnabled');
    return Boolean(toggle && toggle.checked);
}

function getLocalCallbackConfigObject() {
    const psp = getSelectedPsp();
    const getVal = (id, fallback = '') => {
        const el = document.getElementById(id);
        return el ? el.value.trim() : fallback;
    };
    const getChecked = (id, fallback = true) => {
        const el = document.getElementById(id);
        return el ? Boolean(el.checked) : fallback;
    };

    const merchantId = getVal('cbMerchantUuid', '');
    const reference = getVal('cbReferenceUuid', '');
    const customerRef = getVal('cbCustomerUuid', '');
    const paymentContext = getVal('cbPaymentContext', 'save_card');
    const shouldSaveCard = getVal('cbMonerisShouldSaveCard', 'true') !== 'false';
    const darkMode = getVal('cbMonerisDarkMode', 'false') === 'true';

    return {
        enabled: isLocalCallbackEnabled(),
        psp: psp.id,
        customerShortname: getVal('cbCustomerShortname', 'DEV-LOCAL'),
        paymentContext: paymentContext,
        targetServer: getVal('cbTargetServer', 'auto'),
        merchantId: merchantId,
        merchantUuid: merchantId,
        reference: reference,
        referenceUuid: reference,
        customerRef: customerRef,
        customerUuid: customerRef,
        shouldSaveCard: shouldSaveCard,
        darkMode: darkMode,
        autoConsumeQueue: getChecked('cbAutoConsumeQueue', true),
        webhookSecret: getVal('cbLpWebhookSecret', 'test_secret_12345'),
        paymentProviderId: getVal('cbLpProviderId', 'matawan-testportal'),
        fundingSourceId: getVal('cbLpFundingSourceId', ''),
        transactionId: getVal('cbLpTransactionId', ''),
        cardMask: getVal('cbLpCardMask', '************4242'),
        cardExpiry: getVal('cbLpCardExpiry', '12/28'),
        cardType: getVal('cbLpCardType', 'VISA'),
        amount: parseInt(orderAmountInput ? orderAmountInput.value.trim() : '811', 10) || 0,
        currency: (orderCurrencyInput ? orderCurrencyInput.value.trim() : 'EUR') || 'EUR',
        ticket: getVal('cbMonerisTicket', '')
    };
}

function saveLocalCallbackStateToStorage() {
    try {
        const cfg = getLocalCallbackConfigObject();
        localStorage.setItem(STORAGE_KEY_LOCAL_CALLBACK, JSON.stringify(cfg));
    } catch (e) {
        // Ignore storage errors
    }
}

function loadLocalCallbackStateFromStorage() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY_LOCAL_CALLBACK);
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (e) {
        return null;
    }
}

function updateCallbackStepper(stepNum, state = 'active') {
    for (let i = 1; i <= 4; i++) {
        const el = document.getElementById(`cb-step-${i}`);
        if (!el) continue;
        if (i < stepNum) {
            el.classList.remove('active');
            el.classList.add('done');
        } else if (i === stepNum) {
            if (state === 'done') {
                el.classList.remove('active');
                el.classList.add('done');
            } else {
                el.classList.add('active');
                el.classList.remove('done');
            }
        } else {
            el.classList.remove('active', 'done');
        }
    }
}

function populateLittlepayCallbackFieldsFromReceipt(orderIdOrObj, receipt) {
    const fsInput = document.getElementById('cbLpFundingSourceId');
    const txInput = document.getElementById('cbLpTransactionId');
    const panInput = document.getElementById('cbLpCardMask');
    const expInput = document.getElementById('cbLpCardExpiry');
    const schemeInput = document.getElementById('cbLpCardType');

    if (orderIdOrObj && typeof orderIdOrObj === 'object' && !receipt) {
        const obj = orderIdOrObj;
        if (fsInput && obj.fundingSourceId) fsInput.value = obj.fundingSourceId;
        if (txInput && (obj.transactionId || obj.orderId)) txInput.value = obj.transactionId || obj.orderId;
        if (panInput && obj.cardMask && obj.cardMask !== 'SAVED_CARD') panInput.value = obj.cardMask;
        if (expInput && obj.cardExpiry) expInput.value = obj.cardExpiry;
        if (schemeInput && obj.cardType) schemeInput.value = String(obj.cardType).toUpperCase();
        saveLocalCallbackStateToStorage();
        return;
    }

    const orderId = orderIdOrObj;
    const latestSpm = receipt?.latestStoredPaymentMethod || {};
    const latestDetail = receipt?.latestStoredPaymentMethodDetail || {};
    const pi = receipt?.paymentIntent || {};

    const fundingSourceId = latestSpm.funding_source_id || latestSpm.id || latestDetail.funding_source_id || latestDetail.id || '';
    const txId = receipt?.payment_intent_id || pi.id || orderId || '';
    const maskedPan = receipt?.formattedMaskedPan || latestSpm.card_mask || latestDetail.card_mask || '';
    const expiry = latestSpm.card_expiry || latestDetail.card_expiry || '';
    const cardType = latestSpm.card_type || latestDetail.card_type || latestSpm.scheme || '';

    if (fsInput && fundingSourceId) fsInput.value = fundingSourceId;
    if (txInput && txId) txInput.value = txId;
    if (panInput && maskedPan && maskedPan !== 'SAVED_CARD') panInput.value = maskedPan;
    if (expInput && expiry) expInput.value = expiry;
    if (schemeInput && cardType) schemeInput.value = String(cardType).toUpperCase();

    saveLocalCallbackStateToStorage();
}

function syncLocalCallbackToMainForm() {
    const cfg = getLocalCallbackConfigObject();
    if (!cfg.enabled) return;

    // 1. Sync Customer Reference (Passenger Custom UUID)
    if (cfg.customerRef && customerRefInput) {
        customerRefInput.value = cfg.customerRef;
    }

    // 2. Sync Metadata rows for LittlePay & general alignment
    const metadataContainer = document.getElementById('metadata-rows-container');
    if (!metadataContainer) return;

    const setOrCreateMetadataRow = (key, value) => {
        if (!value) return;
        const rows = metadataContainer.querySelectorAll('.metadata-row');
        for (const row of rows) {
            const kIn = row.querySelector('.metadata-key');
            const vIn = row.querySelector('.metadata-value');
            if (kIn && kIn.value.trim() === key && vIn) {
                vIn.value = value;
                return;
            }
        }
        const row = document.createElement('div');
        row.className = 'metadata-row';
        row.style.display = 'flex';
        row.style.gap = '8px';
        row.style.alignItems = 'center';
        row.innerHTML = `
            <input type="text" class="metadata-key" value="${key}" placeholder="Key" style="flex: 1; padding: 6px 10px; font-size: 0.8rem; border: 1px solid var(--border-color); border-radius: var(--radius-sm);">
            <input type="text" class="metadata-value" value="${value}" placeholder="Value" style="flex: 1; padding: 6px 10px; font-size: 0.8rem; border: 1px solid var(--border-color); border-radius: var(--radius-sm);">
            <button type="button" class="btn-remove-row" style="background: none; border: none; color: var(--error); font-size: 1.25rem; cursor: pointer; padding: 0 4px; line-height: 1;">×</button>
        `;
        const removeBtn = row.querySelector('.btn-remove-row');
        if (removeBtn) {
            removeBtn.addEventListener('click', () => row.remove());
        }
        metadataContainer.appendChild(row);
    };

    if (cfg.merchantId) setOrCreateMetadataRow('merchant_id', cfg.merchantId);
    if (cfg.paymentContext) setOrCreateMetadataRow('payment_context', cfg.paymentContext);
    if (cfg.reference) setOrCreateMetadataRow('reference', cfg.reference);
}

function syncLocalCallbackMerchantForPsp(pspId) {
    if (!localDiscoveredDbEntities.merchants || localDiscoveredDbEntities.merchants.length === 0) return;
    const providerUpper = pspId === 'moneris' ? 'MONERIS' : 'LITTLEPAY';
    const matchingMerchant = localDiscoveredDbEntities.merchants.find(
        m => String(m.psp).toUpperCase() === providerUpper && (pspId === 'moneris' ? m.decryptedApiToken : m.decryptedWebhookSecret)
    ) || localDiscoveredDbEntities.merchants.find(
        m => String(m.psp).toUpperCase() === providerUpper
    );
    if (matchingMerchant) {
        const cbMerchantSelect = document.getElementById('cbMerchantSelect');
        const cbMerchantUuid = document.getElementById('cbMerchantUuid');
        const cbLpWebhookSecret = document.getElementById('cbLpWebhookSecret');
        const cbLpProviderId = document.getElementById('cbLpProviderId');
        if (cbMerchantSelect) cbMerchantSelect.value = matchingMerchant.customUuid;
        if (cbMerchantUuid) cbMerchantUuid.value = matchingMerchant.customUuid;
        if (pspId === 'littlepay') {
            if (matchingMerchant.decryptedWebhookSecret && cbLpWebhookSecret) {
                cbLpWebhookSecret.value = matchingMerchant.decryptedWebhookSecret;
            }
            if (matchingMerchant.paymentProviderId && cbLpProviderId) {
                cbLpProviderId.value = matchingMerchant.paymentProviderId;
            }
        }
        syncLocalCallbackToMainForm();
        saveLocalCallbackStateToStorage();
    }
}

async function discoverAndAutoFillFromLocalDb(runCheckAfter = true) {
    const btnAutofill = document.getElementById('btn-cb-autofill');
    const cfg = getLocalCallbackConfigObject();
    if (btnAutofill) {
        btnAutofill.disabled = true;
        btnAutofill.textContent = '⏳ Discovering local DB...';
    }

    try {
        const res = await fetch('/api/local-callback/preflight', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'discover',
                psp: cfg.psp,
                customerShortname: cfg.customerShortname,
                targetServer: cfg.targetServer
            })
        });
        const data = await res.json();
        if (!res.ok || data.error) {
            throw new Error(data.error || 'Discovery failed');
        }

        localDiscoveredDbEntities = {
            merchants: data.merchants || [],
            carts: data.shoppingCarts || [],
            passengers: data.samplePassengers || []
        };

        // Populate Merchant dropdown
        const cbMerchantSelect = document.getElementById('cbMerchantSelect');
        if (cbMerchantSelect) {
            cbMerchantSelect.innerHTML = '<option value="">-- Select Merchant from DB --</option>';
            localDiscoveredDbEntities.merchants.forEach(m => {
                const opt = document.createElement('option');
                opt.value = m.customUuid;
                opt.dataset.psp = m.psp;
                opt.dataset.secret = m.decryptedWebhookSecret || '';
                opt.dataset.providerId = m.paymentProviderId || '';
                opt.textContent = `#${m.id} [${m.psp}] ${m.name} (${m.paymentProviderId}) → ${m.customUuid.slice(0, 8)}…`;
                cbMerchantSelect.appendChild(opt);
            });
        }

        // Populate Entity / Cart / Passenger dropdown
        const cbEntitySelect = document.getElementById('cbEntitySelect');
        if (cbEntitySelect) {
            cbEntitySelect.innerHTML = '<option value="">-- Select Passenger / ShoppingCart from DB --</option>';
            localDiscoveredDbEntities.passengers.forEach(p => {
                const opt = document.createElement('option');
                opt.value = p.customUuid;
                opt.dataset.type = 'passenger';
                opt.dataset.passengerUuid = p.customUuid;
                opt.textContent = `👤 ${p.label} → ${p.customUuid.slice(0, 8)}…`;
                cbEntitySelect.appendChild(opt);
            });
            localDiscoveredDbEntities.carts.forEach(c => {
                const opt = document.createElement('option');
                opt.value = c.customUuid;
                opt.dataset.type = 'cart';
                opt.dataset.passengerUuid = c.passengerCustomUuid || '';
                opt.textContent = `🛒 Cart #${c.id} (${c.status}, Passenger #${c.passengerAccountId}) → ${c.customUuid.slice(0, 8)}…`;
                cbEntitySelect.appendChild(opt);
            });
        }

        // Auto-select matching merchant for active PSP
        const psp = getSelectedPsp();
        syncLocalCallbackMerchantForPsp(psp.id);

        // Auto-select entity based on paymentContext
        const firstCart = localDiscoveredDbEntities.carts[0];
        const firstPassenger = localDiscoveredDbEntities.passengers[0];
        const cbReferenceUuid = document.getElementById('cbReferenceUuid');
        const cbCustomerUuid = document.getElementById('cbCustomerUuid');

        if (cfg.paymentContext === 'cart' && firstCart) {
            if (cbEntitySelect) cbEntitySelect.value = firstCart.customUuid;
            if (cbReferenceUuid) cbReferenceUuid.value = firstCart.customUuid;
            if (cbCustomerUuid && firstCart.passengerCustomUuid) {
                cbCustomerUuid.value = firstCart.passengerCustomUuid;
            }
        } else if (firstPassenger) {
            if (cbEntitySelect) cbEntitySelect.value = firstPassenger.customUuid;
            if (cbCustomerUuid) cbCustomerUuid.value = firstPassenger.customUuid;
            if (cbReferenceUuid) cbReferenceUuid.value = firstPassenger.customUuid;
        }

        syncLocalCallbackToMainForm();
        saveLocalCallbackStateToStorage();
        log(`[Local Callback] Discovered ${localDiscoveredDbEntities.merchants.length} merchants, ${localDiscoveredDbEntities.carts.length} carts, ${localDiscoveredDbEntities.passengers.length} passengers from local PostgreSQL.`, 'success', data);

        if (runCheckAfter) {
            await runLocalCallbackPreflightChecks();
        }
    } catch (err) {
        log(`[Local Callback Error] Auto-discovery failed: ${err.message}`, 'error');
    } finally {
        if (btnAutofill) {
            btnAutofill.disabled = false;
            btnAutofill.textContent = '⚡ Auto-Fill from Local DB';
        }
    }
}

async function runLocalCallbackPreflightChecks() {
    const btnPreflight = document.getElementById('btn-cb-preflight');
    const resultsContainer = document.getElementById('local-cb-preflight-results');
    const badgeEl = document.getElementById('localCallbackStatusBadge');
    const cfg = getLocalCallbackConfigObject();

    if (btnPreflight) {
        btnPreflight.disabled = true;
        btnPreflight.textContent = '⏳ Running Checks...';
    }
    if (resultsContainer) {
        resultsContainer.classList.remove('hidden');
        resultsContainer.innerHTML = '<div style="font-size: 0.72rem; color: var(--text-muted); padding: 4px;">Running 6 pre-flight diagnostic checks against local Docker & PostgreSQL...</div>';
    }

    try {
        const res = await fetch('/api/local-callback/preflight', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'check',
                psp: cfg.psp,
                customerShortname: cfg.customerShortname,
                paymentContext: cfg.paymentContext,
                targetServer: cfg.targetServer,
                merchantId: cfg.merchantId,
                reference: cfg.reference,
                customerRef: cfg.customerRef,
                webhookSecret: cfg.webhookSecret
            })
        });

        const data = await res.json();
        if (!res.ok || data.error) {
            throw new Error(data.error || 'Pre-flight check failed');
        }

        if (resultsContainer && Array.isArray(data.checks)) {
            resultsContainer.innerHTML = data.checks.map(chk => {
                const icon = chk.status === 'ok' ? '✅' : (chk.status === 'warn' ? '⚠️' : '❌');
                let fixBtnHtml = '';
                if (chk.fixAction) {
                    fixBtnHtml = `<button type="button" class="btn-preflight-fix" data-fix='${JSON.stringify(chk.fixAction).replace(/'/g, "&#39;")}'>${chk.fixAction.label}</button>`;
                }
                return `
                    <div class="preflight-check-item status-${chk.status}">
                        <span class="preflight-check-icon">${icon}</span>
                        <div class="preflight-check-body">
                            <div class="preflight-check-label">${chk.title || chk.label}</div>
                            <div class="preflight-check-detail">${chk.summary || ''}${chk.details ? ` — <span style="opacity:0.85;">${chk.details}</span>` : ''}</div>
                        </div>
                        ${fixBtnHtml}
                    </div>
                `;
            }).join('');
        }

        if (badgeEl && isLocalCallbackEnabled()) {
            badgeEl.textContent = data.allPassed ? 'AUTO-ON (OK)' : 'AUTO-ON (WARN)';
            badgeEl.classList.add('active');
        }
        updateCompactCallbackSummaryPills(data);

        updateCallbackStepper(1, data.allPassed ? 'done' : 'active');
        log(`[Local Callback Pre-Flight] Completed (${data.allPassed ? 'ALL PASSED' : 'Action Recommended'})`, data.allPassed ? 'success' : 'system', data);
        return data;
    } catch (err) {
        if (resultsContainer) {
            resultsContainer.innerHTML = `<div class="preflight-check-item status-error"><span class="preflight-check-icon">❌</span><div class="preflight-check-body"><div class="preflight-check-label">Pre-Flight Error</div><div class="preflight-check-detail">${err.message}</div></div></div>`;
        }
        log(`[Local Callback Pre-Flight Error] ${err.message}`, 'error');
        return null;
    } finally {
        if (btnPreflight) {
            btnPreflight.disabled = false;
            btnPreflight.textContent = '🩺 Run Pre-Flight Checks';
        }
    }
}

async function forwardLocalCallbackToBackend(options = {}) {
    const cfg = getLocalCallbackConfigObject();
    const pspId = options.psp || cfg.psp;
    const btnForward = document.getElementById('btn-cb-forward-now');
    const resultCard = document.getElementById('local-cb-persistence-result');

    if (options.orderId) {
        cfg.orderId = options.orderId;
    }
    if (options.ticket) {
        cfg.ticket = options.ticket;
        const ticketInput = document.getElementById('cbMonerisTicket');
        if (ticketInput) ticketInput.value = options.ticket;
    }

    if (btnForward) {
        btnForward.disabled = true;
        btnForward.textContent = `⏳ Forwarding ${pspId.toUpperCase()} Callback to Local Backend...`;
    }
    updateCallbackStepper(3, 'active');

    log(`[Local Callback] Forwarding ${pspId.toUpperCase()} callback (${options.autoTriggered ? 'AUTO' : 'MANUAL'}) to /billing/payment/callback/${cfg.customerShortname}...`, 'system', cfg);

    try {
        const res = await fetch('/api/local-callback/forward', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ...cfg,
                psp: pspId
            })
        });

        const data = await res.json();
        if (!res.ok || data.error) {
            throw new Error(data.error || `HTTP ${res.status}`);
        }

        const statusCode = data.callbackResponse?.statusCode || 500;
        const isSuccess = Boolean(data.ok && statusCode >= 200 && statusCode < 300);
        updateCallbackStepper(3, isSuccess ? 'done' : 'active');
        updateCallbackStepper(4, isSuccess ? 'done' : 'active');

        if (resultCard) {
            resultCard.classList.remove('hidden');
            const newTokens = data.persistence?.newTokens || [];
            const customerTokens = data.persistence?.customerTokens || [];
            const latestToken = newTokens[0] || customerTokens[0];
            const newSales = data.persistence?.newSales || [];
            const recentSales = data.persistence?.recentSales || [];
            const latestSale = newSales[0] || recentSales[0];
            const cartRow = data.persistence?.updatedCart;
            const sigHeader = data.callbackRequest?.headers?.['Event-Signature'] || '';

            resultCard.innerHTML = `
                <div class="persistence-title">
                    <span>${isSuccess ? '✅ Local Callback Forwarded & Persisted in DB' : `⚠️ Callback Returned HTTP ${statusCode}`}</span>
                    <span style="font-family: var(--font-mono); font-size: 0.68rem;">HTTP ${statusCode} (${data.targetContainer})</span>
                </div>
                <div class="persistence-row"><strong>Endpoint:</strong> <code>POST ${data.callbackRequest?.url}</code></div>
                <div class="persistence-row"><strong>Auth Header:</strong> <code>${pspId === 'moneris' ? 'X-Payment-Provider: moneris + Bearer JWT' : `Event-Signature: ${sigHeader.slice(0, 24)}…`}</code></div>
                ${data.consumerResult ? `<div class="persistence-row"><strong>Messenger Queue:</strong> Consumed <code>billing_sale_transport</code> (${data.consumerResult.ok ? 'OK' : 'Warning'})</div>` : ''}
                ${latestToken ? `<div class="persistence-row"><strong>Card Token in DB (<code>fare_payment_tokens</code>):</strong> <code>#${latestToken.id}</code> | token=<code>${latestToken.token}</code> | label=<code>${latestToken.label}</code> | provider=<code>${latestToken.paymentProviderName}</code> | passenger=<code>#${latestToken.passengerAccountId}</code> ${newTokens.length > 0 ? '<span style="color:#276749;font-weight:700;">(NEW!)</span>' : ''}</div>` : ''}
                ${latestSale ? `<div class="persistence-row"><strong>Sale in DB (<code>fare_sales</code>):</strong> <code>#${latestSale.id}</code> | status=<code>${latestSale.status}</code> | ref=<code>${latestSale.reference || latestSale.transactionId}</code> ${newSales.length > 0 ? '<span style="color:#276749;font-weight:700;">(NEW!)</span>' : ''}</div>` : ''}
                ${cartRow ? `<div class="persistence-row"><strong>ShoppingCart (<code>#${cartRow.id}</code>):</strong> status=<code>${cartRow.status}</code> | updated=<code>${cartRow.updatedAt}</code></div>` : ''}
            `;
        }

        log(`[Local Callback] ${pspId.toUpperCase()} callback response HTTP ${statusCode} & DB verification complete.`, isSuccess ? 'success' : 'error', data);
        return data;
    } catch (err) {
        if (resultCard) {
            resultCard.classList.remove('hidden');
            resultCard.innerHTML = `<div class="persistence-title" style="color: var(--error);">❌ Callback Forwarding Failed: ${err.message}</div>`;
        }
        log(`[Local Callback Error] ${err.message}`, 'error');
        return null;
    } finally {
        if (btnForward) {
            btnForward.disabled = false;
            btnForward.textContent = '🚀 Forward / Replay Callback to Local Server Now';
        }
    }
}

function switchSandboxTab(tabName = 'checkout') {
    const viewCheckout = document.getElementById('tab-view-checkout');
    const viewCallback = document.getElementById('tab-view-callback');
    const btnCheckout = document.getElementById('tab-btn-checkout');
    const btnCallback = document.getElementById('tab-btn-callback');

    const isCallback = tabName === 'callback';
    if (viewCheckout) viewCheckout.classList.toggle('hidden', isCallback);
    if (viewCallback) viewCallback.classList.toggle('hidden', !isCallback);
    if (btnCheckout) btnCheckout.classList.toggle('active', !isCallback);
    if (btnCallback) btnCallback.classList.toggle('active', isCallback);
}

function openLocalCallbackWindow() {
    switchSandboxTab('callback');
}

function closeLocalCallbackWindow() {
    switchSandboxTab('checkout');
}

function updateCompactCallbackSummaryPills(preflightData = null) {
    const cfg = getLocalCallbackConfigObject();
    const tenantPill = document.getElementById('cb-pill-tenant');
    const contextPill = document.getElementById('cb-pill-context');
    const preflightPill = document.getElementById('cb-pill-preflight');
    const compactBadge = document.getElementById('localCallbackCompactBadge');
    const headerBadge = document.getElementById('headerCallbackStatusBadge');

    if (tenantPill) {
        tenantPill.innerHTML = `Tenant: <strong>${cfg.customerShortname || 'DEV-LOCAL'}</strong>`;
    }
    if (contextPill) {
        contextPill.innerHTML = `Context: <strong>${cfg.paymentContext || 'save_card'}</strong>`;
    }
    if (preflightData && preflightPill && Array.isArray(preflightData.checks)) {
        const passedCount = preflightData.checks.filter(c => c.status === 'ok').length;
        const totalCount = preflightData.checks.length;
        preflightPill.classList.remove('health-ok', 'health-warn', 'health-error');
        if (preflightData.overallStatus === 'ok') {
            preflightPill.classList.add('health-ok');
            preflightPill.innerHTML = `Pre-Flight: <strong>${passedCount}/${totalCount} OK ✅</strong>`;
        } else if (preflightData.overallStatus === 'warn') {
            preflightPill.classList.add('health-warn');
            preflightPill.innerHTML = `Pre-Flight: <strong>${passedCount}/${totalCount} WARN ⚠️</strong>`;
        } else {
            preflightPill.classList.add('health-error');
            preflightPill.innerHTML = `Pre-Flight: <strong>${passedCount}/${totalCount} ERR ❌</strong>`;
        }
    }

    const enabled = isLocalCallbackEnabled();
    const labelText = enabled
        ? (preflightData ? (preflightData.allPassed ? 'AUTO-ON (OK)' : 'AUTO-ON (WARN)') : 'AUTO-ON')
        : 'OFF';

    [compactBadge, headerBadge].forEach(el => {
        if (el) {
            el.textContent = labelText;
            el.classList.toggle('active', enabled);
        }
    });
}

function setupLocalCallbackPanel() {
    const toggle = document.getElementById('localCallbackEnabled');
    const compactToggle = document.getElementById('localCallbackEnabledCompact');
    const bodyEl = document.getElementById('local-callback-body');
    const badgeEl = document.getElementById('localCallbackStatusBadge');
    const btnAutofill = document.getElementById('btn-cb-autofill');
    const btnPreflight = document.getElementById('btn-cb-preflight');
    const btnForwardNow = document.getElementById('btn-cb-forward-now');
    const btnEncodeId = document.getElementById('btn-cb-encode-id');
    const cbMerchantSelect = document.getElementById('cbMerchantSelect');
    const cbEntitySelect = document.getElementById('cbEntitySelect');
    const cbPaymentContext = document.getElementById('cbPaymentContext');
    const btnOpenStudio = document.getElementById('btn-open-cb-window');
    const btnOpenStudioHeader = document.getElementById('btn-open-cb-window-header');
    const btnCloseStudio = document.getElementById('btn-close-cb-window');
    const btnDoneStudio = document.getElementById('btn-done-cb-window');
    const btnReplayCompact = document.getElementById('btn-cb-replay-compact');
    const modalBackdrop = document.getElementById('local-callback-modal');

    if (!toggle || !bodyEl) return;

    // Restore persisted state from localStorage
    const saved = loadLocalCallbackStateFromStorage();
    if (saved) {
        toggle.checked = Boolean(saved.enabled);
        if (compactToggle) compactToggle.checked = Boolean(saved.enabled);
        const setIfPresent = (id, val) => {
            const el = document.getElementById(id);
            if (el && val !== undefined && val !== '') el.value = val;
        };
        setIfPresent('cbCustomerShortname', saved.customerShortname);
        setIfPresent('cbPaymentContext', saved.paymentContext);
        setIfPresent('cbTargetServer', saved.targetServer);
        setIfPresent('cbMerchantUuid', saved.merchantId || saved.merchantUuid);
        setIfPresent('cbReferenceUuid', saved.reference || saved.referenceUuid);
        setIfPresent('cbCustomerUuid', saved.customerRef || saved.customerUuid);
        setIfPresent('cbLpWebhookSecret', saved.webhookSecret);
        setIfPresent('cbLpProviderId', saved.paymentProviderId);
        setIfPresent('cbLpFundingSourceId', saved.fundingSourceId);
        setIfPresent('cbLpTransactionId', saved.transactionId);
        setIfPresent('cbLpCardMask', saved.cardMask);
        setIfPresent('cbLpCardExpiry', saved.cardExpiry);
        setIfPresent('cbLpCardType', saved.cardType);
        setIfPresent('cbMonerisTicket', saved.ticket);
    }

    const applyToggleUI = async (runDiscoveryOnEnable = false) => {
        const enabled = toggle.checked;
        if (compactToggle && compactToggle.checked !== enabled) {
            compactToggle.checked = enabled;
        }
        if (badgeEl) {
            badgeEl.textContent = enabled ? 'AUTO-ON' : 'OFF';
            badgeEl.classList.toggle('active', enabled);
        }
        updateCompactCallbackSummaryPills();
        saveLocalCallbackStateToStorage();
        if (enabled) {
            syncLocalCallbackToMainForm();
            if (runDiscoveryOnEnable) {
                await discoverAndAutoFillFromLocalDb(true);
            }
        }
    };

    toggle.addEventListener('change', () => {
        applyToggleUI(true);
    });

    if (compactToggle) {
        compactToggle.addEventListener('change', () => {
            toggle.checked = compactToggle.checked;
            applyToggleUI(true);
        });
    }

    // Tab / Window open / close handlers
    if (btnOpenStudio) {
        btnOpenStudio.addEventListener('click', () => openLocalCallbackWindow());
    }
    if (btnOpenStudioHeader) {
        btnOpenStudioHeader.addEventListener('click', () => openLocalCallbackWindow());
    }
    if (btnCloseStudio) {
        btnCloseStudio.addEventListener('click', () => closeLocalCallbackWindow());
    }
    if (btnDoneStudio) {
        btnDoneStudio.addEventListener('click', () => closeLocalCallbackWindow());
    }

    if (btnReplayCompact) {
        btnReplayCompact.addEventListener('click', () => {
            openLocalCallbackWindow();
            forwardLocalCallbackToBackend({ autoTriggered: false });
        });
    }

    if (btnAutofill) {
        btnAutofill.addEventListener('click', () => discoverAndAutoFillFromLocalDb(true));
    }
    if (btnPreflight) {
        btnPreflight.addEventListener('click', () => runLocalCallbackPreflightChecks());
    }
    if (btnForwardNow) {
        btnForwardNow.addEventListener('click', () => forwardLocalCallbackToBackend({ autoTriggered: false }));
    }

    if (cbPaymentContext) {
        cbPaymentContext.addEventListener('change', function() {
            const ctx = this.value;
            const cbReferenceUuid = document.getElementById('cbReferenceUuid');
            const cbCustomerUuid = document.getElementById('cbCustomerUuid');
            if (ctx === 'cart' && localDiscoveredDbEntities.carts.length > 0) {
                const c = localDiscoveredDbEntities.carts[0];
                if (cbReferenceUuid) cbReferenceUuid.value = c.customUuid;
                if (cbCustomerUuid && c.passengerCustomUuid) cbCustomerUuid.value = c.passengerCustomUuid;
            } else if (ctx === 'save_card' && cbCustomerUuid && cbCustomerUuid.value) {
                if (cbReferenceUuid) cbReferenceUuid.value = cbCustomerUuid.value;
            }
            syncLocalCallbackToMainForm();
            saveLocalCallbackStateToStorage();
        });
    }

    if (cbMerchantSelect) {
        cbMerchantSelect.addEventListener('change', function() {
            const cbMerchantUuid = document.getElementById('cbMerchantUuid');
            if (cbMerchantUuid && this.value) {
                cbMerchantUuid.value = this.value;
            }
            const selectedOpt = this.options[this.selectedIndex];
            if (selectedOpt) {
                if (selectedOpt.dataset.secret) {
                    const secretIn = document.getElementById('cbLpWebhookSecret');
                    if (secretIn) secretIn.value = selectedOpt.dataset.secret;
                }
                if (selectedOpt.dataset.providerId) {
                    const provIn = document.getElementById('cbLpProviderId');
                    if (provIn) provIn.value = selectedOpt.dataset.providerId;
                }
            }
            syncLocalCallbackToMainForm();
            saveLocalCallbackStateToStorage();
        });
    }

    if (cbEntitySelect) {
        cbEntitySelect.addEventListener('change', function() {
            const selectedOpt = this.options[this.selectedIndex];
            if (!selectedOpt || !this.value) return;
            const cbReferenceUuid = document.getElementById('cbReferenceUuid');
            const cbCustomerUuid = document.getElementById('cbCustomerUuid');
            if (cbReferenceUuid) cbReferenceUuid.value = this.value;
            if (selectedOpt.dataset.passengerUuid && cbCustomerUuid) {
                cbCustomerUuid.value = selectedOpt.dataset.passengerUuid;
            }
            syncLocalCallbackToMainForm();
            saveLocalCallbackStateToStorage();
        });
    }

    if (btnEncodeId) {
        btnEncodeId.addEventListener('click', async () => {
            const rawIdInput = document.getElementById('cbRawIdInput');
            const targetSelect = document.getElementById('cbEncodeTargetField');
            const shortnameInput = document.getElementById('cbCustomerShortname');
            const rawId = rawIdInput ? rawIdInput.value.trim() : '';
            if (!rawId) return;

            btnEncodeId.disabled = true;
            try {
                const res = await fetch('/api/local-callback/preflight', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        action: 'encode_uuid',
                        rawId: rawId,
                        customerShortname: shortnameInput ? shortnameInput.value.trim() : 'DEV-LOCAL'
                    })
                });
                const data = await res.json();
                const encoded = data.customUuid || data.uuid;
                if (encoded) {
                    const mode = targetSelect ? targetSelect.value : 'customer_and_ref';
                    const refEl = document.getElementById('cbReferenceUuid');
                    const custEl = document.getElementById('cbCustomerUuid');
                    const merchEl = document.getElementById('cbMerchantUuid');
                    if (mode === 'customer_and_ref') {
                        if (refEl) refEl.value = encoded;
                        if (custEl) custEl.value = encoded;
                    } else if (mode === 'reference') {
                        if (refEl) refEl.value = encoded;
                    } else if (mode === 'merchant') {
                        if (merchEl) merchEl.value = encoded;
                    }
                    syncLocalCallbackToMainForm();
                    saveLocalCallbackStateToStorage();
                    log(`[Local Callback] Encoded raw ID #${rawId} (${data.customerShortname}) → ${encoded}`, 'success');
                }
            } catch (e) {
                log(`[Local Callback Error] Failed to encode UUID: ${e.message}`, 'error');
            } finally {
                btnEncodeId.disabled = false;
            }
        });
    }

    // Sync manual input edits to main form & storage
    const watchedIds = [
        'cbCustomerShortname', 'cbPaymentContext', 'cbTargetServer',
        'cbMerchantUuid', 'cbReferenceUuid', 'cbCustomerUuid',
        'cbLpWebhookSecret', 'cbLpProviderId', 'cbLpFundingSourceId',
        'cbLpTransactionId', 'cbLpCardMask', 'cbLpCardExpiry',
        'cbLpCardType', 'cbMonerisTicket', 'cbMonerisShouldSaveCard',
        'cbMonerisDarkMode', 'cbAutoConsumeQueue'
    ];
    watchedIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('change', () => {
                syncLocalCallbackToMainForm();
                updateCompactCallbackSummaryPills();
                saveLocalCallbackStateToStorage();
            });
            el.addEventListener('input', () => {
                updateCompactCallbackSummaryPills();
                saveLocalCallbackStateToStorage();
            });
        }
    });

    // Delegated listener for 1-Click Fix buttons in preflight results & inline forward buttons in receipt cards
    document.addEventListener('click', async (e) => {
        const fixBtn = e.target.closest('.btn-preflight-fix');
        if (fixBtn) {
            try {
                const fixAction = JSON.parse(fixBtn.getAttribute('data-fix'));
                if (fixAction.type === 'auto_fill') {
                    await discoverAndAutoFillFromLocalDb(true);
                } else if (fixAction.type === 'select_merchant' && fixAction.merchant) {
                    const cbMerchantUuid = document.getElementById('cbMerchantUuid');
                    const cbMerchantSelect = document.getElementById('cbMerchantSelect');
                    if (cbMerchantUuid) cbMerchantUuid.value = fixAction.merchant.customUuid;
                    if (cbMerchantSelect) cbMerchantSelect.value = fixAction.merchant.customUuid;
                    syncLocalCallbackToMainForm();
                    saveLocalCallbackStateToStorage();
                    await runLocalCallbackPreflightChecks();
                } else if (fixAction.type === 'set_webhook_secret' && fixAction.value) {
                    const el = document.getElementById('cbLpWebhookSecret');
                    if (el) el.value = fixAction.value;
                    saveLocalCallbackStateToStorage();
                    await runLocalCallbackPreflightChecks();
                } else if (fixAction.type === 'sync_reference_to_customer' && fixAction.value) {
                    const el = document.getElementById('cbReferenceUuid');
                    if (el) el.value = fixAction.value;
                    syncLocalCallbackToMainForm();
                    saveLocalCallbackStateToStorage();
                    await runLocalCallbackPreflightChecks();
                } else if (fixAction.type === 'select_cart' && fixAction.cart) {
                    const refEl = document.getElementById('cbReferenceUuid');
                    const custEl = document.getElementById('cbCustomerUuid');
                    if (refEl) refEl.value = fixAction.cart.customUuid;
                    if (custEl && fixAction.cart.passengerCustomUuid) custEl.value = fixAction.cart.passengerCustomUuid;
                    syncLocalCallbackToMainForm();
                    saveLocalCallbackStateToStorage();
                    await runLocalCallbackPreflightChecks();
                } else if (fixAction.type === 'switch_target_server' && fixAction.value) {
                    const srvEl = document.getElementById('cbTargetServer');
                    if (srvEl) srvEl.value = fixAction.value;
                    saveLocalCallbackStateToStorage();
                    await runLocalCallbackPreflightChecks();
                } else if ((fixAction.type === 'fix_cart_status' || fixAction.type === 'reset_cart_status') && fixAction.cartId) {
                    fixBtn.disabled = true;
                    fixBtn.textContent = '⏳ Resetting...';
                    await fetch('/api/local-callback/preflight', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            action: 'fix_cart_status',
                            cartIdOrUuid: fixAction.cartId,
                            status: 'WAITING_PAYMENT'
                        })
                    });
                    log(`[Local Callback] Reset ShoppingCart #${fixAction.cartId} status to WAITING_PAYMENT.`, 'success');
                    await runLocalCallbackPreflightChecks();
                }
            } catch (err) {
                log(`[Local Callback Fix Error] ${err.message}`, 'error');
            }
        }

        const inlineForwardBtn = e.target.closest('.btn-forward-callback-inline');
        if (inlineForwardBtn) {
            const pspId = inlineForwardBtn.getAttribute('data-psp') || getSelectedPsp().id;
            const orderId = inlineForwardBtn.getAttribute('data-order-id') || '';
            const ticket = inlineForwardBtn.getAttribute('data-ticket') || '';
            inlineForwardBtn.disabled = true;
            const prevText = inlineForwardBtn.textContent;
            inlineForwardBtn.textContent = '⏳ Forwarding Callback to Local Backend...';
            try {
                const res = await forwardLocalCallbackToBackend({ psp: pspId, orderId, ticket, autoTriggered: false });
                if (res && res.ok) {
                    inlineForwardBtn.textContent = '✅ Callback Forwarded & Persisted in Local DB!';
                } else {
                    inlineForwardBtn.textContent = prevText;
                }
            } catch (err) {
                inlineForwardBtn.textContent = prevText;
            } finally {
                setTimeout(() => {
                    inlineForwardBtn.disabled = false;
                }, 1500);
            }
        }
    });

    // Initialize UI state
    applyToggleUI(toggle.checked);
    setupMonerisProfileAndServerControl();
}

// =========================================================================
// Moneris Checkout Profile Manager & Sandbox Server Restart Control
// =========================================================================
let cachedMonerisServerConfig = null;

async function fetchServerAndMonerisConfig(silent = false) {
    try {
        const res = await fetch('/api/config?t=' + Date.now());
        if (!res.ok) return null;
        const data = await res.json();
        cachedMonerisServerConfig = data;

        const pidBadge = document.getElementById('moneris-server-pid-badge');
        const statusText = document.getElementById('server-status-text');
        const checkoutIdInput = document.getElementById('monerisCheckoutIdInput');
        const aliasSelect = document.getElementById('monerisProfileAliasSelect');

        if (pidBadge && data.server?.pid) {
            pidBadge.textContent = `PID: ${data.server.pid}`;
        }
        if (statusText && data.server?.pid) {
            statusText.textContent = `Sandbox Online (PID ${data.server.pid})`;
        }

        if (checkoutIdInput && data.moneris) {
            const alias = aliasSelect ? aliasSelect.value : 'all';
            const profiles = data.moneris.checkoutProfiles || {};
            if (alias !== 'all' && profiles[alias]) {
                checkoutIdInput.value = profiles[alias];
            } else if (data.moneris.checkoutId) {
                checkoutIdInput.value = data.moneris.checkoutId;
            }
        }

        if (!silent) {
            log(`[Server Config] Loaded Moneris profile '${data.moneris?.checkoutId || ''}' (Server PID ${data.server?.pid || '?'}).`, 'system', data);
        }
        return data;
    } catch (e) {
        return null;
    }
}

async function waitForServerRestart(previousPid, maxAttempts = 20) {
    for (let i = 0; i < maxAttempts; i++) {
        await new Promise(r => setTimeout(r, 350));
        try {
            const res = await fetch('/api/config?t=' + Date.now());
            if (res.ok) {
                const data = await res.json();
                if (data && data.server && data.server.pid) {
                    if (!previousPid || data.server.pid !== previousPid || i >= 2) {
                        return data;
                    }
                }
            }
        } catch (e) {
            // Server is mid-restart, keep polling
        }
    }
    return null;
}

function setMonerisProfileBanner(message, statusClass = 'status-ok') {
    const banner = document.getElementById('moneris-profile-status-banner');
    if (!banner) return;
    banner.classList.remove('hidden', 'status-ok', 'status-restarting', 'status-error');
    banner.classList.add(statusClass);
    banner.innerHTML = message;
}

async function applyMonerisProfileAndRestart({ restartOnly = false } = {}) {
    const checkoutIdInput = document.getElementById('monerisCheckoutIdInput');
    const aliasSelect = document.getElementById('monerisProfileAliasSelect');
    const syncDbCheckbox = document.getElementById('monerisSyncLocalDbCheckbox');
    const btnSaveRestart = document.getElementById('btn-save-restart-moneris-profile');
    const btnRestartOnly = document.getElementById('btn-restart-only-moneris');
    const btnHeaderRestart = document.getElementById('btn-restart-server-header');

    const checkoutId = checkoutIdInput ? checkoutIdInput.value.trim() : '';
    const alias = aliasSelect ? aliasSelect.value : 'all';
    const syncLocalDb = syncDbCheckbox ? Boolean(syncDbCheckbox.checked) : true;

    if (!restartOnly && !checkoutId) {
        setMonerisProfileBanner('❌ Please enter a valid Moneris <code>checkout_id</code>.', 'status-error');
        return;
    }

    const buttons = [btnSaveRestart, btnRestartOnly, btnHeaderRestart].filter(Boolean);
    buttons.forEach(b => { b.disabled = true; });
    if (btnHeaderRestart) btnHeaderRestart.innerHTML = '<span>⏳ Restarting...</span>';

    setMonerisProfileBanner(
        restartOnly
            ? '⏳ Restarting Sandbox Server & reloading <code>env.local.json</code>...'
            : `⏳ Saving <code>${checkoutId}</code> (${alias}) to <code>env.local.json</code>${syncLocalDb ? ' + local PostgreSQL' : ''} & restarting server...`,
        'status-restarting'
    );

    try {
        let previousPid = cachedMonerisServerConfig?.server?.pid || null;
        let dbSyncOk = false;

        if (restartOnly) {
            const res = await fetch('/api/server/restart', { method: 'POST' });
            const data = await res.json();
            previousPid = data.previousPid || previousPid;
        } else {
            const res = await fetch('/api/moneris/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    checkoutId,
                    alias,
                    syncLocalDb,
                    restartServer: true
                })
            });
            const data = await res.json();
            if (!res.ok || data.error) {
                throw new Error(data.error || 'Failed to update Moneris checkout profile');
            }
            previousPid = data.previousPid || previousPid;
            dbSyncOk = Boolean(data.dbSyncResult && data.dbSyncResult.ok);
        }

        const newServerData = await waitForServerRestart(previousPid);
        await fetchServerAndMonerisConfig(true);

        const newPid = newServerData?.server?.pid || cachedMonerisServerConfig?.server?.pid || 'online';
        const activeChkId = newServerData?.moneris?.checkoutId || checkoutId;

        setMonerisProfileBanner(
            `✅ Server restarted (PID <code>${previousPid || '?'}</code> → <code>${newPid}</code>) • Active <code>checkout_id</code>: <strong>${activeChkId}</strong>${!restartOnly && syncLocalDb ? (dbSyncOk ? ' • Local DB <code>fare_merchants</code> synced ✅' : '') : ''}`,
            'status-ok'
        );

        log(
            restartOnly
                ? `[Server Restart] Sandbox server restarted cleanly (PID ${previousPid || '?'} -> ${newPid}).`
                : `[Moneris Profile] Updated checkout_id='${activeChkId}' (alias=${alias}), synced env.local.json${dbSyncOk ? ' + local DB' : ''}, and restarted server (PID ${previousPid || '?'} -> ${newPid}).`,
            'success',
            newServerData
        );
    } catch (err) {
        setMonerisProfileBanner(`❌ Error: ${err.message}`, 'status-error');
        log(`[Moneris Profile / Server Restart Error] ${err.message}`, 'error');
    } finally {
        buttons.forEach(b => { b.disabled = false; });
        if (btnHeaderRestart) btnHeaderRestart.innerHTML = '<span>⚡ Restart Server</span>';
    }
}

function setupMonerisProfileAndServerControl() {
    const btnSaveRestart = document.getElementById('btn-save-restart-moneris-profile');
    const btnRestartOnly = document.getElementById('btn-restart-only-moneris');
    const btnHeaderRestart = document.getElementById('btn-restart-server-header');
    const aliasSelect = document.getElementById('monerisProfileAliasSelect');
    const checkoutIdInput = document.getElementById('monerisCheckoutIdInput');

    fetchServerAndMonerisConfig(true);

    if (aliasSelect && checkoutIdInput) {
        aliasSelect.addEventListener('change', () => {
            const profiles = cachedMonerisServerConfig?.moneris?.checkoutProfiles || {};
            const alias = aliasSelect.value;
            if (alias !== 'all' && profiles[alias]) {
                checkoutIdInput.value = profiles[alias];
            } else if (cachedMonerisServerConfig?.moneris?.checkoutId) {
                checkoutIdInput.value = cachedMonerisServerConfig.moneris.checkoutId;
            }
        });
    }

    document.querySelectorAll('.btn-moneris-preset').forEach(btn => {
        btn.addEventListener('click', () => {
            const presetId = btn.getAttribute('data-checkout-id');
            if (presetId && checkoutIdInput) {
                checkoutIdInput.value = presetId;
            }
        });
    });

    if (btnSaveRestart) {
        btnSaveRestart.addEventListener('click', () => applyMonerisProfileAndRestart({ restartOnly: false }));
    }
    if (btnRestartOnly) {
        btnRestartOnly.addEventListener('click', () => applyMonerisProfileAndRestart({ restartOnly: true }));
    }
    if (btnHeaderRestart) {
        btnHeaderRestart.addEventListener('click', () => applyMonerisProfileAndRestart({ restartOnly: true }));
    }
}
