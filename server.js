const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

const PORT = 8000;
const SERVER_BOOT_TIME = new Date().toISOString();

const MONERIS_PROFILE_ALIASES = [
    'save_card_light',
    'save_card_dark',
    'payment_with_save_card_light',
    'payment_with_save_card_dark',
    'payment_without_save_card_light',
    'payment_without_save_card_dark'
];

/**
 * Loads or reloads env.json and env.local.json into process.env
 */
function loadEnvConfig() {
    if (fs.existsSync('env.json')) {
        try {
            const envData = JSON.parse(fs.readFileSync('env.json', 'utf-8'));
            for (const [key, val] of Object.entries(envData)) {
                process.env[key] = typeof val === 'object' && val !== null ? JSON.stringify(val) : val;
            }
            console.log(`[Config] Loaded default variables from env.json.`);
        } catch (e) {
            console.warn(`[Config] Failed to parse env.json:`, e.message);
        }
    }

    if (fs.existsSync('env.local.json')) {
        try {
            const envLocalData = JSON.parse(fs.readFileSync('env.local.json', 'utf-8'));
            for (const [key, val] of Object.entries(envLocalData)) {
                process.env[key] = typeof val === 'object' && val !== null ? JSON.stringify(val) : val;
            }
            console.log(`[Config] Loaded secure overrides from env.local.json successfully.`);
        } catch (e) {
            console.warn(`[Config] Failed to parse env.local.json:`, e.message);
        }
    }
}

loadEnvConfig();

/**
 * Helper to log and send JSON response from local server
 */
function sendJsonResponse(res, statusCode, data, routeName = '') {
    const jsonStr = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    console.log(`\n============================================================`);
    console.log(`[Server Response] ${routeName} -> Status ${statusCode}`);
    console.log(`[Response Payload]:\n${jsonStr}`);
    console.log(`============================================================\n`);
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(jsonStr);
}

/**
 * Modern Promise wrapper around Node's native HTTPS request module (Zero Dependencies)
 * Logs the full request payload and response body for all upstream gateway calls
 */
function makeHttpsRequest(urlStr, method, headers, requestBody) {
    return new Promise((resolve, reject) => {
        try {
            const parsedUrl = new url.URL(urlStr);

            console.log(`\n------------------------------------------------------------`);
            console.log(`[Upstream HTTPS Request] ${method} ${urlStr}`);
            if (headers) {
                console.log(`[Upstream Headers]:`, JSON.stringify(headers, null, 2));
            }
            if (requestBody) {
                console.log(`[Upstream Payload]:\n${requestBody}`);
            }
            console.log(`------------------------------------------------------------\n`);

            const reqHeaders = { ...headers };
            if (requestBody !== undefined && requestBody !== null) {
                reqHeaders['Content-Length'] = Buffer.byteLength(requestBody);
            }

            const options = {
                hostname: parsedUrl.hostname,
                port: 443,
                path: parsedUrl.pathname + parsedUrl.search,
                method: method,
                headers: reqHeaders
            };

            const req = https.request(options, (res) => {
                let resBody = '';
                res.on('data', (chunk) => {
                    resBody += chunk;
                });
                res.on('end', () => {
                    console.log(`\n------------------------------------------------------------`);
                    console.log(`[Upstream HTTPS Response] ${method} ${urlStr} -> ${res.statusCode} ${res.statusMessage}`);
                    console.log(`[Upstream Response Body]:\n${resBody}`);
                    console.log(`------------------------------------------------------------\n`);

                    resolve({
                        statusCode: res.statusCode,
                        statusMessage: res.statusMessage,
                        headers: res.headers,
                        body: resBody
                    });
                });
            });

            req.on('error', (err) => {
                console.error(`[Upstream HTTPS Error] ${method} ${urlStr}:`, err.message);
                reject(err);
            });

            if (requestBody !== undefined && requestBody !== null) {
                req.write(requestBody);
            }
            req.end();
        } catch (err) {
            reject(err);
        }
    });
}

// =============================================================================
// SUPPORTED PSP SESSION HANDLERS
// =============================================================================

/**
 * Parses Moneris Gateway XML Receipt into a clean key-value dictionary
 */
function parseMonerisXmlReceipt(xmlStr) {
    const result = {};
    if (!xmlStr) return result;
    const tagRegex = /<([a-zA-Z0-9_]+)>([^<]*)<\/\1>/g;
    let match;
    while ((match = tagRegex.exec(xmlStr)) !== null) {
        result[match[1]] = match[2];
    }
    return result;
}

function getMonerisCheckoutProfilesMap() {
    let profiles = {};
    if (process.env.MONERIS_CHECKOUT_PROFILES) {
        try {
            const parsed = typeof process.env.MONERIS_CHECKOUT_PROFILES === 'string'
                ? JSON.parse(process.env.MONERIS_CHECKOUT_PROFILES)
                : process.env.MONERIS_CHECKOUT_PROFILES;
            if (parsed && typeof parsed === 'object') {
                profiles = { ...parsed };
            }
        } catch (e) {
            profiles = {};
        }
    }
    const defaultId = (process.env.MONERIS_CHECKOUT_ID || '').trim();
    for (const alias of MONERIS_PROFILE_ALIASES) {
        if (!profiles[alias] || profiles[alias] === 'FILLME') {
            profiles[alias] = defaultId;
        }
    }
    return profiles;
}

function resolveMonerisAliasForContext(paymentContext = 'save_card', shouldSaveCard = true, darkMode = false) {
    if (paymentContext === 'save_card') {
        return darkMode ? 'save_card_dark' : 'save_card_light';
    }
    if (shouldSaveCard) {
        return darkMode ? 'payment_with_save_card_dark' : 'payment_with_save_card_light';
    }
    return darkMode ? 'payment_without_save_card_dark' : 'payment_without_save_card_light';
}

/**
 * Resolves the Moneris Checkout Profile ID from MONERIS_CHECKOUT_PROFILES or MONERIS_CHECKOUT_ID
 */
function resolveMonerisCheckoutId(paymentContext = 'save_card', shouldSaveCard = true, darkMode = false, explicitAlias = '') {
    const profiles = getMonerisCheckoutProfilesMap();
    const alias = (explicitAlias && explicitAlias !== 'auto' && MONERIS_PROFILE_ALIASES.includes(explicitAlias))
        ? explicitAlias
        : resolveMonerisAliasForContext(paymentContext, shouldSaveCard, darkMode);

    if (profiles[alias] && profiles[alias] !== 'FILLME') {
        return String(profiles[alias]).trim();
    }
    return (process.env.MONERIS_CHECKOUT_ID || '').trim();
}

function isUuidLike(val) {
    return typeof val === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val.trim());
}

function normalizePaymentContext(rawContext, rawCents) {
    const lower = String(rawContext || '').trim().toLowerCase();
    if (lower === 'save_card' || lower === 'mit-registration' || rawCents === 0) {
        return 'save_card';
    }
    if (lower === 'cart' || lower === 'shopping_cart') {
        return 'cart';
    }
    if (lower === 'ewallet_reload' || lower === 'ewallet') {
        return 'ewallet_reload';
    }
    return 'cart';
}

function resolveValidDevLocalCustomerUuid(rawCustId) {
    const trimmed = String(rawCustId || '').trim();
    if (isUuidLike(trimmed)) {
        return trimmed;
    }
    if (trimmed === '1') {
        return '0cd00107-cae0-5003-a0e0-0c0002150000';
    }
    if (trimmed === '2891') {
        return 'a705b2e0-00c0-5e01-a0da-0008c0001c80';
    }
    return 'c00002c2-e000-5e08-a01a-00da57b0c000'; // Passenger #2858
}

function resolveValidDevLocalReferenceUuid(paymentContext, rawRef, customerUuid) {
    const trimmed = String(rawRef || '').trim();
    if (isUuidLike(trimmed)) {
        return trimmed;
    }
    if (paymentContext === 'save_card') {
        return customerUuid;
    }
    if (paymentContext === 'ewallet_reload') {
        return '0cd00a07-cae0-5103-a0e0-7cf002150000';
    }
    return '05e00070-c010-5c01-a20e-0c00001ad000'; // ShoppingCart #1
}

/**
 * Generates a Moneris order_no matching wfwp-platform MonerisPaymentGateway::generateOrderNo()
 * Uses 10-digit Unix seconds timestamp so total length is <= 50 chars when reference is a 36-char UUID.
 */
function buildMonerisOrderNo(paymentContext, reference) {
    const tsSec = Math.floor(Date.now() / 1000);
    if (paymentContext === 'save_card') {
        return `SC_${crypto.randomUUID()}`;
    }
    if (paymentContext === 'cart' && reference) {
        return `C_${reference}_${tsSec}`.slice(0, 50);
    }
    if (paymentContext === 'ewallet_reload' && reference) {
        return `ER_${reference}_${tsSec}`.slice(0, 50);
    }
    return `ORDER-${Date.now()}`;
}

/**
 * Moneris Session Handler
 * Supports:
 * - 'vault': Moneris Vault (Pay with saved data_key)
 * - 'sdk': Moneris Checkout (MCO) Ticket Preload
 */
async function handleMonerisSession(sessionParams, res) {
    const { orderPayload, checkoutMethod, localCallback } = sessionParams;
    const metadata = (orderPayload && orderPayload.metadata) || {};
    const rawCents = orderPayload && orderPayload.charge && Number.isFinite(Number(orderPayload.charge.amount))
        ? Number(orderPayload.charge.amount)
        : 1000;
    const rawPaymentContext = (localCallback && localCallback.paymentContext) || metadata.payment_context || '';
    const paymentContext = normalizePaymentContext(rawPaymentContext, rawCents);
    const rawCustId = (localCallback && localCallback.customerRef)
        || (orderPayload && orderPayload.customer_ref)
        || '';
    const effectiveCustId = resolveValidDevLocalCustomerUuid(rawCustId);
    const rawReference = (localCallback && localCallback.reference) || metadata.reference || '';
    const reference = resolveValidDevLocalReferenceUuid(paymentContext, rawReference, effectiveCustId);
    const shouldSaveCard = localCallback && typeof localCallback.shouldSaveCard === 'boolean'
        ? localCallback.shouldSaveCard
        : true;
    const darkMode = Boolean(localCallback && localCallback.darkMode);

    const storeId = (process.env.MONERIS_STORE_ID || '').trim();
    const apiToken = (process.env.MONERIS_API_TOKEN || '').trim();
    const explicitAlias = (sessionParams.checkoutProfileAlias || (localCallback && localCallback.checkoutProfileAlias) || '').trim();
    const explicitCheckoutId = (sessionParams.checkoutId || (localCallback && localCallback.checkoutId) || '').trim();
    const resolvedAlias = (explicitAlias && explicitAlias !== 'auto')
        ? explicitAlias
        : resolveMonerisAliasForContext(paymentContext || 'save_card', shouldSaveCard, darkMode);
    const checkoutId = (explicitCheckoutId && explicitCheckoutId !== 'FILLME')
        ? explicitCheckoutId
        : resolveMonerisCheckoutId(paymentContext || 'save_card', shouldSaveCard, darkMode, explicitAlias);
    const envMode = (process.env.MONERIS_ENV || 'qa').trim().toLowerCase();

    // -------------------------------------------------------------------------
    // FLOW A: MONERIS VAULT (Pay with Saved data_key)
    // -------------------------------------------------------------------------
    if (checkoutMethod === 'vault') {
        const dataKey = (sessionParams.dataKey || sessionParams.monerisVaultDataKey || '').trim();
        if (!dataKey) {
            sendJsonResponse(res, 400, {
                error: 'A saved data_key is required to pay with Moneris Vault. Please select or enter a data_key.'
            }, 'handleMonerisSession Error');
            return;
        }

        const chargeAmount = orderPayload && orderPayload.charge ? (orderPayload.charge.amount / 100).toFixed(2) : '10.00';
        const orderNo = `ORDER-${Date.now()}`;

        sendJsonResponse(res, 200, {
            psp: 'moneris',
            checkoutMethod: 'vault',
            dataKey: dataKey,
            order_no: orderNo,
            amount: chargeAmount,
            currency: (orderPayload && orderPayload.charge && orderPayload.charge.currency) || 'CAD',
            environment: envMode,
            expDate: (sessionParams.monerisVaultExpDate || '').trim(),
            cryptType: (sessionParams.monerisVaultCryptType || '7').trim(),
            action: sessionParams.monerisActionType || 'purchase'
        }, 'handleMonerisSession (Vault)');
        return;
    }

    // -------------------------------------------------------------------------
    // FLOW B: MONERIS CHECKOUT (MCO Ticket Preload)
    // -------------------------------------------------------------------------
    if (!storeId || storeId === 'FILLME' || !apiToken || apiToken === 'FILLME') {
        sendJsonResponse(res, 400, {
            error: 'MONERIS_STORE_ID or MONERIS_API_TOKEN is not configured or set to FILLME. Please check your env.local.json file.'
        }, 'handleMonerisSession Error');
        return;
    }

    if (!checkoutId || checkoutId === 'FILLME') {
        sendJsonResponse(res, 400, {
            error: 'MONERIS_CHECKOUT_ID is not configured or set to FILLME. Please configure MONERIS_CHECKOUT_ID in your env.local.json file.'
        }, 'handleMonerisSession Error');
        return;
    }

    const chargeAmount = (paymentContext === 'save_card' && rawCents === 0)
        ? '0.00'
        : (rawCents / 100).toFixed(2);
    const orderNo = buildMonerisOrderNo(paymentContext, reference);

    const mcoUrl = envMode === 'prod'
        ? 'https://gateway.moneris.com/chktv2/request/request.php'
        : 'https://gatewayt.moneris.com/chktv2/request/request.php';

    console.log(`[Proxy Moneris] Initiating MCO Preload for Store: ${storeId}, Checkout: ${checkoutId}, Order: ${orderNo}, Amount: ${chargeAmount}, CustId: ${effectiveCustId}, Env: ${envMode} (${mcoUrl})...`);

    const preloadPayload = {
        store_id: storeId,
        api_token: apiToken,
        checkout_id: checkoutId,
        environment: envMode,
        action: 'preload',
        txn_total: chargeAmount,
        order_no: orderNo,
        cust_id: String(effectiveCustId)
    };

    if (orderPayload && orderPayload.token) {
        preloadPayload.token = orderPayload.token;
    }

    const mcoRes = await makeHttpsRequest(
        mcoUrl,
        'POST',
        {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        JSON.stringify(preloadPayload)
    );

    let parsedData;
    try {
        parsedData = JSON.parse(mcoRes.body);
    } catch (e) {
        parsedData = null;
    }

    if (parsedData && parsedData.response && parsedData.response.ticket) {
        sendJsonResponse(res, 200, {
            psp: 'moneris',
            checkoutMethod: 'sdk',
            ticket: parsedData.response.ticket,
            environment: envMode,
            order_no: orderNo,
            checkout_id: checkoutId,
            checkout_profile_alias: resolvedAlias,
            cust_id: preloadPayload.cust_id || null
        }, 'handleMonerisSession (MCO Preload)');
    } else {
        const errDetail = parsedData && parsedData.response && parsedData.response.error
            ? `${parsedData.response.error.field}: ${parsedData.response.error.message}`
            : mcoRes.body;
        sendJsonResponse(res, 400, {
            error: `Moneris Checkout preload failed (${errDetail}). Please verify your MONERIS_STORE_ID, MONERIS_API_TOKEN, MONERIS_CHECKOUT_ID, and MONERIS_ENV.`
        }, 'handleMonerisSession Error');
    }
}

/**
 * Decodes Littlepay client_token (Base64 JSON + embedded JWT payload)
 */
function decodeLittlepayClientToken(clientToken) {
    if (!clientToken || typeof clientToken !== 'string') return null;
    try {
        const decodedJson = JSON.parse(Buffer.from(clientToken, 'base64').toString('utf8'));
        let jwtClaims = null;
        if (decodedJson.auth_token && typeof decodedJson.auth_token === 'string') {
            const parts = decodedJson.auth_token.split('.');
            if (parts.length >= 2) {
                jwtClaims = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
            }
        }
        return {
            https_api: decodedJson.https_api,
            auth_token: decodedJson.auth_token,
            jwt_claims: jwtClaims
        };
    } catch (e) {
        return null;
    }
}

/**
 * Littlepay Session Creation Handler (Inline SDK or Hosted Payment Link)
 */
async function handleLittlepaySession(sessionParams, res) {
    const { mitType, orderPayload, checkoutMethod, disableSavedCards, locale } = sessionParams;
    const apiKey = process.env.LITTLEPAY_API_KEY;
    const apiSteps = [];

    if (!apiKey) {
        sendJsonResponse(res, 400, {
            error: 'LITTLEPAY_API_KEY environment variable is not configured on the server. Please check your env.json file.'
        }, 'handleLittlepaySession Error');
        return;
    }

    console.log(`[Proxy Littlepay] Step 1: POST /merchant/v1/orders for Customer: ${orderPayload.customer_ref}...`);

    // Create Order on Littlepay Sandbox (common to both SDK and Payment Link)
    const orderRes = await makeHttpsRequest(
        'https://checkout.sandbox.littlepay.com/merchant/v1/orders',
        'POST',
        {
            'Content-Type': 'application/json',
            'X-Api-Key': apiKey
        },
        JSON.stringify(orderPayload)
    );

    if (orderRes.statusCode < 200 || orderRes.statusCode >= 300) {
        console.error(`[Proxy Littlepay] Order creation failed with status ${orderRes.statusCode}:`, orderRes.body);
        sendJsonResponse(res, orderRes.statusCode, { error: `Order creation failed: ${orderRes.body}` }, 'handleLittlepaySession Error');
        return;
    }

    const orderData = JSON.parse(orderRes.body);
    const paymentIntentId = orderData.payment_intent_id;
    const orderId = orderData.id;
    const decodedToken = decodeLittlepayClientToken(orderData.client_token);
    apiSteps.push({
        step: 1,
        name: 'POST /merchant/v1/orders',
        statusCode: orderRes.statusCode,
        request: orderPayload,
        response: orderData,
        decodedClientToken: decodedToken ? { https_api: decodedToken.https_api, jwt_claims: decodedToken.jwt_claims } : null
    });
    console.log(`[Proxy Littlepay] Order created successfully! ID: ${orderId}, Intent: ${paymentIntentId}`);

    if (checkoutMethod === 'link') {
        // Flow A: PAYMENT LINK (4 steps)

        // Step 2: PATCH payment-intent to set capture_method to AUTO
        console.log(`[Proxy Littlepay] Step 2: PATCH /payment-intents/${paymentIntentId} (Set Capture to AUTO)...`);
        const captureRes = await makeHttpsRequest(
            `https://checkout.sandbox.littlepay.com/merchant/v1/payment-intents/${paymentIntentId}`,
            'PATCH',
            {
                'Content-Type': 'application/json',
                'X-Api-Key': apiKey
            },
            JSON.stringify({ capture_method: 'AUTO' })
        );

        let captureBody = captureRes.body;
        try { captureBody = captureRes.body ? JSON.parse(captureRes.body) : { status: '204 No Content' }; } catch (e) {}
        apiSteps.push({
            step: 2,
            name: `PATCH /merchant/v1/payment-intents/${paymentIntentId}`,
            statusCode: captureRes.statusCode,
            request: { capture_method: 'AUTO' },
            response: captureBody
        });

        if (captureRes.statusCode < 200 || captureRes.statusCode >= 300) {
            console.error(`[Proxy Littlepay] PATCH Capture failed with status ${captureRes.statusCode}:`, captureRes.body);
            sendJsonResponse(res, captureRes.statusCode, { error: `Setting capture method to AUTO failed: ${captureRes.body}` }, 'handleLittlepaySession Error');
            return;
        }

        // Step 3: PUT payment-intent mit_type (conditional)
        if (mitType) {
            console.log(`[Proxy Littlepay] Step 3: PUT /payment-intents/${paymentIntentId}/payment-method-options (Add MIT Type)...`);
            const optionsRes = await makeHttpsRequest(
                `https://checkout.sandbox.littlepay.com/merchant/v1/payment-intents/${paymentIntentId}/payment-method-options`,
                'PUT',
                {
                    'Content-Type': 'application/json',
                    'X-Api-Key': apiKey
                },
                JSON.stringify({ mit_type: mitType })
            );

            let optionsBody = optionsRes.body;
            try { optionsBody = optionsRes.body ? JSON.parse(optionsRes.body) : { status: '204 No Content' }; } catch (e) {}
            apiSteps.push({
                step: 3,
                name: `PUT /merchant/v1/payment-intents/${paymentIntentId}/payment-method-options`,
                statusCode: optionsRes.statusCode,
                request: { mit_type: mitType },
                response: optionsBody
            });

            if (optionsRes.statusCode < 200 || optionsRes.statusCode >= 300) {
                console.error(`[Proxy Littlepay] Setting MIT options failed with status ${optionsRes.statusCode}:`, optionsRes.body);
                sendJsonResponse(res, optionsRes.statusCode, { error: `Setting MIT options failed: ${optionsRes.body}` }, 'handleLittlepaySession Error');
                return;
            }
        } else {
            console.log(`[Proxy Littlepay] Step 3: Skipping PUT /payment-method-options (mitType is null/empty).`);
        }

        // Step 4: POST /orders/{order_id}/payment-links
        console.log(`[Proxy Littlepay] Step 4: POST /orders/${orderId}/payment-links (Generate Hosted Link)...`);
        const linkPayload = {
            callback_url: 'https://google.com',
            locale: locale || 'en-GB',
            sdk_options: {
                disableSavedCards: disableSavedCards
            },
            auth_type: 'CODE'
        };

        const linkRes = await makeHttpsRequest(
            `https://checkout.sandbox.littlepay.com/merchant/v1/orders/${orderId}/payment-links`,
            'POST',
            {
                'Content-Type': 'application/json',
                'X-Api-Key': apiKey
            },
            JSON.stringify(linkPayload)
        );

        if (linkRes.statusCode < 200 || linkRes.statusCode >= 300) {
            console.error(`[Proxy Littlepay] Create payment link failed with status ${linkRes.statusCode}:`, linkRes.body);
            sendJsonResponse(res, linkRes.statusCode, { error: `Create payment link failed: ${linkRes.body}` }, 'handleLittlepaySession Error');
            return;
        }

        const linkData = JSON.parse(linkRes.body);
        apiSteps.push({
            step: 4,
            name: `POST /merchant/v1/orders/${orderId}/payment-links`,
            statusCode: linkRes.statusCode,
            request: linkPayload,
            response: linkData
        });
        let finalLinkUrl = linkData.url || linkData.payment_link || linkData.payment_link_url;

        if (finalLinkUrl) {
            // Append sdkVersion=2 query parameter as required by documentation
            if (finalLinkUrl.includes('?')) {
                finalLinkUrl += '&sdkVersion=2';
            } else {
                finalLinkUrl += '?sdkVersion=2';
            }
        }

        console.log(`[Proxy Littlepay] Payment link created successfully (sdkVersion=2 added)! URL: ${finalLinkUrl}`);

        sendJsonResponse(res, 200, {
            psp: 'littlepay',
            checkoutMethod: 'link',
            url: finalLinkUrl,
            id: orderId,
            payment_intent_id: paymentIntentId,
            client_token: orderData.client_token,
            customer_ref: orderPayload.customer_ref,
            mit_type: mitType || null,
            linkData: linkData,
            apiSteps: apiSteps
        }, 'handleLittlepaySession (Hosted Link)');

    } else {
        // Flow B: SDK INLINE (2 steps)
        if (mitType) {
            console.log(`[Proxy Littlepay] Step 2: PUT /payment-intents/${paymentIntentId}/payment-method-options (Add MIT Type)...`);

            const optionsRes = await makeHttpsRequest(
                `https://checkout.sandbox.littlepay.com/merchant/v1/payment-intents/${paymentIntentId}/payment-method-options`,
                'PUT',
                {
                    'Content-Type': 'application/json',
                    'X-Api-Key': apiKey
                },
                JSON.stringify({ mit_type: mitType })
            );

            let optionsBody = optionsRes.body;
            try { optionsBody = optionsRes.body ? JSON.parse(optionsRes.body) : { status: '204 No Content' }; } catch (e) {}
            apiSteps.push({
                step: 2,
                name: `PUT /merchant/v1/payment-intents/${paymentIntentId}/payment-method-options`,
                statusCode: optionsRes.statusCode,
                request: { mit_type: mitType },
                response: optionsBody
            });

            if (optionsRes.statusCode < 200 || optionsRes.statusCode >= 300) {
                console.error(`[Proxy Littlepay] Setting MIT options failed with status ${optionsRes.statusCode}:`, optionsRes.body);
                sendJsonResponse(res, optionsRes.statusCode, { error: `Setting MIT options failed: ${optionsRes.body}` }, 'handleLittlepaySession Error');
                return;
            }
            console.log(`[Proxy Littlepay] MIT Setup complete (204).`);
        } else {
            console.log(`[Proxy Littlepay] Step 2: Skipping PUT /payment-method-options (mitType is null/empty).`);
        }

        console.log(`[Proxy Littlepay] Returning client_token to client.`);

        sendJsonResponse(res, 200, {
            psp: 'littlepay',
            checkoutMethod: 'sdk',
            client_token: orderData.client_token,
            payment_intent_id: paymentIntentId,
            id: orderId,
            customer_ref: orderPayload.customer_ref,
            mit_type: mitType || null,
            apiSteps: apiSteps
        }, 'handleLittlepaySession (Inline SDK)');
    }
}

// =============================================================================
// LOCAL BACKEND CALLBACK FORWARDING & PRE-FLIGHT DIAGNOSTICS (wfwp-platform)
// =============================================================================

/**
 * Promise wrapper around Node's native HTTP/HTTPS request module for local & upstream endpoints
 */
function makeHttpRequest(urlStr, method, headers, requestBody, timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
        try {
            const parsedUrl = new url.URL(urlStr);
            const isHttps = parsedUrl.protocol === 'https:';
            const client = isHttps ? https : http;
            const defaultPort = isHttps ? 443 : 80;

            const reqHeaders = { ...headers };
            if (requestBody !== undefined && requestBody !== null) {
                reqHeaders['Content-Length'] = Buffer.byteLength(requestBody);
            }

            const options = {
                hostname: parsedUrl.hostname,
                port: parsedUrl.port ? Number(parsedUrl.port) : defaultPort,
                path: parsedUrl.pathname + parsedUrl.search,
                method: method,
                headers: reqHeaders,
                timeout: timeoutMs
            };

            const req = client.request(options, (res) => {
                let resBody = '';
                res.on('data', (chunk) => {
                    resBody += chunk;
                });
                res.on('end', () => {
                    resolve({
                        statusCode: res.statusCode,
                        statusMessage: res.statusMessage,
                        headers: res.headers,
                        body: resBody
                    });
                });
            });

            req.on('timeout', () => {
                req.destroy(new Error(`Request timed out after ${timeoutMs}ms (${urlStr})`));
            });

            req.on('error', (err) => {
                reject(err);
            });

            if (requestBody !== undefined && requestBody !== null) {
                req.write(requestBody);
            }
            req.end();
        } catch (err) {
            reject(err);
        }
    });
}

/**
 * Executes a CLI command using execFile (safe from shell injection)
 */
function execCommandPromise(cmd, args = [], timeoutMs = 10000) {
    return new Promise((resolve) => {
        execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
            resolve({
                ok: !err,
                code: err ? (err.code || 1) : 0,
                stdout: (stdout || '').trim(),
                stderr: (stderr || (err ? err.message : '')).trim()
            });
        });
    });
}

/**
 * Inspects running Docker containers relevant to wfwp-platform local callback processing
 */
async function inspectLocalDockerContainers() {
    const psRes = await execCommandPromise('docker', ['ps', '--format', '{{.Names}}|{{.Status}}|{{.Ports}}'], 5000);
    if (!psRes.ok) {
        return {
            dockerRunning: false,
            error: psRes.stderr || 'Docker daemon is not reachable',
            containers: {}
        };
    }

    const containers = {};
    const lines = psRes.stdout.split('\n').filter(Boolean);
    for (const line of lines) {
        const [name, status, ports] = line.split('|');
        if (name) {
            containers[name.trim()] = {
                name: name.trim(),
                status: (status || '').trim(),
                ports: (ports || '').trim()
            };
        }
    }

    return {
        dockerRunning: true,
        containers
    };
}

/**
 * Selects the best available wfwp-platform PHP container and target base URL
 */
function resolveTargetContainerAndUrl(dockerInfo, targetServerPref = 'auto', psp = 'littlepay') {
    const containers = (dockerInfo && dockerInfo.containers) || {};
    const hasMonerisSandbox = Boolean(containers['wfwp-moneris-sandbox']);
    const hasMainPlatform = Boolean(containers['wfwp-platform-php-1']);

    if (targetServerPref === 'http://127.0.0.1:8099' || targetServerPref === '8099') {
        return {
            containerName: hasMonerisSandbox ? 'wfwp-moneris-sandbox' : (hasMainPlatform ? 'wfwp-platform-php-1' : 'wfwp-moneris-sandbox'),
            baseUrl: 'http://127.0.0.1:8099',
            hostHeader: 'wfwp-platform.wandev',
            mode: 'sandbox-8099'
        };
    }

    if (targetServerPref === 'http://127.0.0.1:80' || targetServerPref === '80') {
        return {
            containerName: hasMainPlatform ? 'wfwp-platform-php-1' : (hasMonerisSandbox ? 'wfwp-moneris-sandbox' : 'wfwp-platform-php-1'),
            baseUrl: 'http://127.0.0.1:80',
            hostHeader: 'wfwp-platform.wandev',
            mode: 'traefik-80'
        };
    }

    if (targetServerPref && targetServerPref !== 'auto' && targetServerPref.startsWith('http')) {
        const useSandbox = targetServerPref.includes('8099');
        return {
            containerName: useSandbox && hasMonerisSandbox ? 'wfwp-moneris-sandbox' : (hasMainPlatform ? 'wfwp-platform-php-1' : 'wfwp-moneris-sandbox'),
            baseUrl: targetServerPref.replace(/\/$/, ''),
            hostHeader: 'wfwp-platform.wandev',
            mode: 'custom'
        };
    }

    // Auto mode: prefer wfwp-moneris-sandbox (port 8099) if running because it supports both Moneris & LittlePay callbacks
    if (hasMonerisSandbox) {
        return {
            containerName: 'wfwp-moneris-sandbox',
            baseUrl: 'http://127.0.0.1:8099',
            hostHeader: 'wfwp-platform.wandev',
            mode: 'auto-8099'
        };
    }

    return {
        containerName: 'wfwp-platform-php-1',
        baseUrl: 'http://127.0.0.1:80',
        hostHeader: 'wfwp-platform.wandev',
        mode: 'auto-80'
    };
}

/**
 * Runs a small PHP diagnostic / DB / UUID helper inside the wfwp-platform container
 */
async function runLocalPhpBridge(containerName, payloadObj) {
    const phpScript = `
require '/projects/services/app/vendor/autoload.php';
if (class_exists(\\Symfony\\Component\\Dotenv\\Dotenv::class) && file_exists('/projects/services/app/.env')) {
    (new \\Symfony\\Component\\Dotenv\\Dotenv())->usePutenv()->bootEnv('/projects/services/app/.env');
}
$input = json_decode(base64_decode($argv[1] ?? ''), true) ?: [];
$action = $input['action'] ?? 'discover';
$customer = $input['customerShortname'] ?? 'DEV-LOCAL';
$secret = $_ENV['LITTLEPAY_ENCRYPTION_SECRET'] ?? getenv('LITTLEPAY_ENCRYPTION_SECRET') ?: '';

$decryptFn = function (?string $enc) use ($secret): ?string {
    if (!$enc || !$secret) return null;
    try {
        if (class_exists(\\App\\Billing\\Security\\EncryptionManager::class)) {
            return (new \\App\\Billing\\Security\\EncryptionManager($secret))->decrypt($enc);
        }
    } catch (\\Throwable $e) {
        return null;
    }
    return null;
};

$encodeUuid = function ($id) use ($customer): ?string {
    if ($id === null || $id === '') return null;
    try {
        return \\Ubitransports\\CustomUuid\\Encoder\\UuidEncoder::encode($customer, (string) $id);
    } catch (\\Throwable $e) {
        return null;
    }
};

$decodeUuid = function (?string $uuid) use ($customer): ?string {
    if (!$uuid) return null;
    try {
        return \\Ubitransports\\CustomUuid\\Encoder\\UuidDecoder::decode($customer, $uuid);
    } catch (\\Throwable $e) {
        return null;
    }
};

$isValidUuidV5 = function (?string $uuid): bool {
    if (!$uuid) return false;
    try {
        return \\Symfony\\Component\\Uid\\UuidV5::isValid($uuid);
    } catch (\\Throwable $e) {
        return false;
    }
};

$securityYaml = @file_get_contents('/projects/services/app/config/packages/security.yaml') ?: '';
$authenticators = [
    'littlepay' => strpos($securityYaml, 'LittlepayCallbackAuthenticator') !== false,
    'moneris' => strpos($securityYaml, 'MonerisCallbackAuthenticator') !== false,
];

$pdo = null;
$dbError = null;
try {
    $pdo = new PDO('pgsql:host=2cloud-postgres_main-1;port=5432;dbname=postgres', 'www-data', 'ubitransport', [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_TIMEOUT => 3,
    ]);
} catch (\\Throwable $e) {
    $dbError = $e->getMessage();
}

if ($action === 'encode_uuid') {
    $rawId = (string) ($input['rawId'] ?? '');
    echo json_encode([
        'ok' => true,
        'customerShortname' => $customer,
        'rawId' => $rawId,
        'customUuid' => $encodeUuid($rawId),
    ]);
    exit(0);
}

if ($action === 'fix_cart_status' && $pdo) {
    $cartIdOrUuid = (string) ($input['cartIdOrUuid'] ?? $input['cartId'] ?? '');
    $targetStatus = (string) ($input['status'] ?? 'WAITING_PAYMENT');
    $decodedId = ctype_digit($cartIdOrUuid) ? (int) $cartIdOrUuid : (int) $decodeUuid($cartIdOrUuid);
    if ($decodedId <= 0) {
        echo json_encode(['ok' => false, 'error' => 'Could not resolve a valid integer ShoppingCart ID from: ' . $cartIdOrUuid]);
        exit(0);
    }
    $stmt = $pdo->prepare('UPDATE shopping_carts SET status = :st, modified = NOW() WHERE id = :id RETURNING id, status, merchant_id, passenger_account_id');
    $stmt->execute(['st' => $targetStatus, 'id' => $decodedId]);
    $updated = $stmt->fetch();
    echo json_encode([
        'ok' => (bool) $updated,
        'updatedCart' => $updated,
        'customUuid' => $updated ? $encodeUuid($updated['id']) : null,
    ]);
    exit(0);
}

if ($action === 'update_moneris_profiles' && $pdo) {
    $profilesMap = $input['profilesMap'] ?? [];
    if (!is_array($profilesMap) || empty($profilesMap)) {
        echo json_encode(['ok' => false, 'error' => 'profilesMap is required']);
        exit(0);
    }
    $mRows = $pdo->query("SELECT id, name, payment_provider_configuration FROM fare_merchants WHERE payment_provider_name = 'MONERIS' AND deleted IS NULL ORDER BY id ASC")->fetchAll();
    $updatedMerchants = [];
    foreach ($mRows as $m) {
        $details = json_decode($m['payment_provider_configuration'] ?? '{}', true) ?: [];
        $newProfiles = [];
        foreach ($profilesMap as $alias => $idVal) {
            if (!empty($idVal) && $idVal !== 'FILLME') {
                $newProfiles[] = [
                    'id' => (string) $idVal,
                    'alias' => (string) $alias,
                ];
            }
        }
        $details['checkoutProfiles'] = $newProfiles;
        $upd = $pdo->prepare('UPDATE fare_merchants SET payment_provider_configuration = :cfg, modified = NOW() WHERE id = :id');
        $upd->execute([
            'cfg' => json_encode($details, JSON_UNESCAPED_SLASHES),
            'id' => (int) $m['id'],
        ]);
        $updatedMerchants[] = [
            'id' => (int) $m['id'],
            'name' => $m['name'],
            'checkoutProfiles' => $newProfiles,
        ];
    }
    echo json_encode([
        'ok' => true,
        'updatedMerchants' => $updatedMerchants,
    ]);
    exit(0);
}

$merchants = [];
$shoppingCarts = [];
$recentTokens = [];
$recentSales = [];

if ($pdo) {
    $mRows = $pdo->query('SELECT id, name, payment_provider_name AS payment_service_provider, payment_provider_id, payment_provider_configuration AS details FROM fare_merchants WHERE deleted IS NULL ORDER BY id ASC')->fetchAll();
    foreach ($mRows as $m) {
        $details = json_decode($m['details'] ?? '{}', true) ?: [];
        $decryptedApiToken = null;
        $checkoutProfiles = null;
        $decryptedWebhookSecret = null;
        if (($m['payment_service_provider'] ?? '') === 'MONERIS') {
            $decryptedApiToken = isset($details['checkoutApiToken']) ? $decryptFn($details['checkoutApiToken']) : null;
            $checkoutProfiles = $details['checkoutProfiles'] ?? null;
        } elseif (($m['payment_service_provider'] ?? '') === 'LITTLEPAY') {
            $encSec = $details['webhooks']['charge.authorisation.succeeded']['secretKey'] ?? null;
            if (!$encSec && !empty($details['subscriptions']) && is_array($details['subscriptions'])) {
                foreach ($details['subscriptions'] as $sub) {
                    if (($sub['eventType'] ?? '') === 'charge.authorisation.succeeded' && !empty($sub['secretKey'])) {
                        $encSec = $sub['secretKey'];
                        break;
                    }
                }
            }
            $decryptedWebhookSecret = $encSec ? $decryptFn($encSec) : null;
        }
        $merchants[] = [
            'id' => (int) $m['id'],
            'customUuid' => $encodeUuid($m['id']),
            'name' => $m['name'],
            'psp' => $m['payment_service_provider'],
            'paymentProviderId' => $m['payment_provider_id'],
            'decryptedApiToken' => $decryptedApiToken,
            'checkoutProfiles' => $checkoutProfiles,
            'decryptedWebhookSecret' => $decryptedWebhookSecret,
        ];
    }

    $cRows = $pdo->query('SELECT id, status, merchant_id, passenger_account_id, created, modified FROM shopping_carts ORDER BY id DESC LIMIT 20')->fetchAll();
    foreach ($cRows as $c) {
        $shoppingCarts[] = [
            'id' => (int) $c['id'],
            'customUuid' => $encodeUuid($c['id']),
            'status' => $c['status'],
            'merchantId' => (int) $c['merchant_id'],
            'merchantCustomUuid' => $encodeUuid($c['merchant_id']),
            'passengerAccountId' => (int) $c['passenger_account_id'],
            'passengerCustomUuid' => $encodeUuid($c['passenger_account_id']),
            'updatedAt' => $c['modified'],
        ];
    }

    $tRows = $pdo->query('SELECT id, passenger_account_id, payment_provider_id, raw_token, label, payment_provider_name, payment_token_type, status, expired, created FROM fare_payment_tokens ORDER BY id DESC LIMIT 10')->fetchAll();
    foreach ($tRows as $t) {
        $recentTokens[] = [
            'id' => (int) $t['id'],
            'customUuid' => $encodeUuid($t['id']),
            'passengerAccountId' => (int) $t['passenger_account_id'],
            'passengerCustomUuid' => $encodeUuid($t['passenger_account_id']),
            'paymentProviderId' => $t['payment_provider_id'],
            'token' => (json_decode($t['raw_token'] ?? '', true)['identifier'] ?? $t['raw_token']),
            'rawToken' => $t['raw_token'],
            'label' => $t['label'],
            'paymentProviderName' => $t['payment_provider_name'],
            'paymentMethod' => $t['payment_token_type'],
            'status' => $t['status'],
            'expirationDate' => $t['expired'],
            'createdAt' => $t['created'],
        ];
    }

    $sRows = $pdo->query('SELECT s.id, s.reference, s.status, s.passenger_account_id, s.created, t.ext_ref AS transaction_id, t.amount, t.currency_type FROM fare_sales s LEFT JOIN fare_transactions t ON t.fare_sale_id = s.id ORDER BY s.id DESC LIMIT 10')->fetchAll();
    foreach ($sRows as $s) {
        $recentSales[] = [
            'id' => (int) $s['id'],
            'reference' => $s['reference'],
            'transactionId' => $s['transaction_id'] ?? $s['reference'],
            'status' => $s['status'],
            'passengerAccountId' => (int) $s['passenger_account_id'],
            'amount' => $s['amount'],
            'currency' => $s['currency_type'],
            'createdAt' => $s['created'],
        ];
    }
}

$samplePassengers = [
    ['id' => 2858, 'customUuid' => $encodeUuid(2858), 'label' => 'Passenger #2858 (Default QA)'],
    ['id' => 1, 'customUuid' => $encodeUuid(1), 'label' => 'Passenger #1'],
    ['id' => 2891, 'customUuid' => $encodeUuid(2891), 'label' => 'Passenger #2891'],
];

$inspectUuids = [];
foreach (['merchantId', 'reference', 'customerRef'] as $field) {
    $val = trim((string) ($input[$field] ?? ''));
    $inspectUuids[$field] = [
        'value' => $val,
        'isValidUuidV5' => $isValidUuidV5($val),
        'decodedId' => $decodeUuid($val),
    ];
}

echo json_encode([
    'ok' => true,
    'customerShortname' => $customer,
    'authenticators' => $authenticators,
    'dbConnected' => $pdo !== null,
    'dbError' => $dbError,
    'merchants' => $merchants,
    'shoppingCarts' => $shoppingCarts,
    'samplePassengers' => $samplePassengers,
    'recentTokens' => $recentTokens,
    'recentSales' => $recentSales,
    'inspectUuids' => $inspectUuids,
]);
`;

    const b64Input = Buffer.from(JSON.stringify(payloadObj || {}), 'utf8').toString('base64');
    const res = await execCommandPromise('docker', ['exec', containerName, 'php', '-r', phpScript, b64Input], 10000);
    if (!res.ok) {
        return {
            ok: false,
            error: res.stderr || `Failed to execute PHP bridge in container ${containerName}`
        };
    }

    try {
        return JSON.parse(res.stdout);
    } catch (e) {
        return {
            ok: false,
            error: `Failed to parse PHP bridge output: ${res.stdout || res.stderr}`
        };
    }
}

/**
 * Fetches an OAuth2 Client Credentials JWT token from local Keycloak (keycloak.wandev)
 */
async function fetchLocalKeycloakToken(customerShortname = 'DEV-LOCAL') {
    const tokenUrl = `http://127.0.0.1:80/auth/realms/${encodeURIComponent(customerShortname)}/protocol/openid-connect/token`;
    const formBody = 'grant_type=client_credentials&client_id=back_2cloud&client_secret=7d5155cd-3774-4bce-8a81-7d7ac1367f7e&scope=customer';
    try {
        const res = await makeHttpRequest(
            tokenUrl,
            'POST',
            {
                'Host': 'keycloak.wandev',
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json'
            },
            formBody,
            6000
        );
        if (res.statusCode >= 200 && res.statusCode < 300) {
            const parsed = JSON.parse(res.body);
            if (parsed && parsed.access_token) {
                return {
                    ok: true,
                    accessToken: parsed.access_token,
                    expiresIn: parsed.expires_in
                };
            }
        }
        return {
            ok: false,
            statusCode: res.statusCode,
            error: `Keycloak returned HTTP ${res.statusCode}: ${res.body}`
        };
    } catch (err) {
        return {
            ok: false,
            error: `Keycloak connection error: ${err.message}`
        };
    }
}

/**
 * Handles POST /api/local-callback/preflight
 * Actions:
 * - 'discover': Returns local DB merchants, carts, passengers, and container status
 * - 'encode_uuid': Encodes a legacy integer ID into a Custom UUID
 * - 'fix_cart_status': Resets a shopping_cart row status to WAITING_PAYMENT
 * - 'check' (default): Executes the 6 Pre-Flight Checks for local callback readiness
 */
async function handleLocalCallbackPreflight(payload = {}) {
    const action = payload.action || 'check';
    const psp = (payload.psp || 'littlepay').toLowerCase();
    const customerShortname = (payload.customerShortname || 'DEV-LOCAL').trim();
    const targetServerPref = payload.targetServer || 'auto';

    const dockerInfo = await inspectLocalDockerContainers();
    const target = resolveTargetContainerAndUrl(dockerInfo, targetServerPref, psp);

    if (action === 'encode_uuid') {
        const bridgeRes = await runLocalPhpBridge(target.containerName, {
            action: 'encode_uuid',
            customerShortname,
            rawId: payload.rawId
        });
        return bridgeRes;
    }

    if (action === 'fix_cart_status') {
        const bridgeRes = await runLocalPhpBridge(target.containerName, {
            action: 'fix_cart_status',
            customerShortname,
            cartIdOrUuid: payload.cartIdOrUuid,
            status: payload.status || 'WAITING_PAYMENT'
        });
        return bridgeRes;
    }

    const bridgeData = dockerInfo.dockerRunning
        ? await runLocalPhpBridge(target.containerName, {
            action: 'discover',
            customerShortname,
            merchantId: payload.merchantId,
            reference: payload.reference,
            customerRef: payload.customerRef
        })
        : { ok: false, error: dockerInfo.error };

    if (action === 'discover') {
        return {
            ok: Boolean(bridgeData && bridgeData.ok),
            dockerInfo,
            resolvedTarget: target,
            envConfig: {
                monerisStoreId: (process.env.MONERIS_STORE_ID || '').trim(),
                monerisCheckoutId: resolveMonerisCheckoutId(payload.paymentContext || 'save_card', true, false),
                monerisHasApiToken: Boolean(process.env.MONERIS_API_TOKEN && process.env.MONERIS_API_TOKEN !== 'FILLME'),
                littlepayHasApiKey: Boolean(process.env.LITTLEPAY_API_KEY)
            },
            ...(bridgeData || {})
        };
    }

    // -------------------------------------------------------------------------
    // ACTION: 'check' — Run the 6 Pre-Flight Diagnostic Checks
    // -------------------------------------------------------------------------
    const checks = [];
    const paymentContext = (payload.paymentContext || 'save_card').trim();
    const merchantId = (payload.merchantId || '').trim();
    const reference = (payload.reference || '').trim();
    const customerRef = (payload.customerRef || '').trim();
    const webhookSecret = (payload.webhookSecret || '').trim();

    // Check 1: Docker & wfwp-platform Container + Authenticator Registration
    const containerRunning = Boolean(dockerInfo.containers && dockerInfo.containers[target.containerName]);
    const auths = (bridgeData && bridgeData.authenticators) || {};
    const hasRequiredAuthenticator = psp === 'moneris' ? Boolean(auths.moneris) : Boolean(auths.littlepay);

    if (!dockerInfo.dockerRunning || !containerRunning) {
        checks.push({
            id: 'server_route',
            step: 1,
            title: 'Local Server & Container (`wfwp-platform`)',
            status: 'error',
            summary: `Container '${target.containerName}' is not running.`,
            details: dockerInfo.error || `Start wfwp-platform container before forwarding callbacks.`
        });
    } else if (!hasRequiredAuthenticator) {
        const altNote = psp === 'moneris' && dockerInfo.containers['wfwp-moneris-sandbox']
            ? `Switch Target Server to 'http://127.0.0.1:8099 (wfwp-moneris-sandbox)' which has MonerisCallbackAuthenticator enabled.`
            : `Ensure ${psp === 'moneris' ? 'MonerisCallbackAuthenticator' : 'LittlepayCallbackAuthenticator'} is registered in security.yaml.`;
        checks.push({
            id: 'server_route',
            step: 1,
            title: 'Local Server & Authenticator (`wfwp-platform`)',
            status: 'error',
            summary: `${psp.toUpperCase()} callback authenticator is missing on container '${target.containerName}'.`,
            details: altNote,
            fixAction: (psp === 'moneris' && dockerInfo.containers['wfwp-moneris-sandbox'])
                ? { type: 'switch_target_server', value: 'http://127.0.0.1:8099', label: '⚡ Switch to Port 8099 (wfwp-moneris-sandbox)' }
                : null
        });
    } else {
        checks.push({
            id: 'server_route',
            step: 1,
            title: 'Local Server & Authenticator (`wfwp-platform`)',
            status: 'ok',
            summary: `Target '${target.baseUrl}/billing/payment/callback/${customerShortname}' (${target.containerName}) is online with ${psp === 'moneris' ? 'MonerisCallbackAuthenticator' : 'LittlepayCallbackAuthenticator'}.`,
            details: `Container status: ${dockerInfo.containers[target.containerName].status}`
        });
    }

    // Check 2: Custom UUID Format (UuidV5) & Tenant Decoding
    const uuids = (bridgeData && bridgeData.inspectUuids) || {};
    const mUuid = uuids.merchantId || {};
    const rUuid = uuids.reference || {};
    const cUuid = uuids.customerRef || {};

    const uuidErrors = [];
    if (!mUuid.isValidUuidV5 || !mUuid.decodedId) {
        uuidErrors.push(`merchant_id '${merchantId || '(empty)'}' is not a valid ${customerShortname} Custom UUID`);
    }
    if (!rUuid.isValidUuidV5 || !rUuid.decodedId) {
        uuidErrors.push(`reference '${reference || '(empty)'}' is not a valid ${customerShortname} Custom UUID`);
    }
    if (!cUuid.isValidUuidV5 || !cUuid.decodedId) {
        uuidErrors.push(`customer_ref '${customerRef || '(empty)'}' is not a valid ${customerShortname} Custom UUID`);
    }

    if (uuidErrors.length > 0) {
        checks.push({
            id: 'custom_uuids',
            step: 2,
            title: `Custom UUIDv5 Format & Decoding (${customerShortname})`,
            status: 'error',
            summary: uuidErrors.join(' • '),
            details: `wfwp-platform requires valid UuidV5 strings encoded for '${customerShortname}'. Click 'Auto-Fill from Local DB' to populate valid Custom UUIDs.`,
            fixAction: { type: 'auto_fill', label: '⚡ Auto-Fill Valid UUIDs from Local DB' }
        });
    } else {
        checks.push({
            id: 'custom_uuids',
            step: 2,
            title: `Custom UUIDv5 Format & Decoding (${customerShortname})`,
            status: 'ok',
            summary: `Decoded IDs → Merchant #${mUuid.decodedId}, Reference #${rUuid.decodedId}, Customer #${cUuid.decodedId}`,
            details: `All 3 UUIDs are valid UuidV5 strings for tenant '${customerShortname}'.`
        });
    }

    // Check 3: Merchant Record in fare_merchants
    const merchants = (bridgeData && bridgeData.merchants) || [];
    const matchedMerchant = merchants.find(m => String(m.id) === String(mUuid.decodedId));
    const expectedPspEnum = psp === 'moneris' ? 'MONERIS' : 'LITTLEPAY';

    const findPreferredCandidateMerchant = (pspEnum) => {
        if (pspEnum === 'LITTLEPAY') {
            return merchants.find(m => m.psp === 'LITTLEPAY' && m.decryptedWebhookSecret)
                || merchants.find(m => m.psp === 'LITTLEPAY');
        }
        return merchants.find(m => m.psp === 'MONERIS' && m.decryptedApiToken)
            || merchants.find(m => m.psp === pspEnum);
    };

    if (!matchedMerchant) {
        const candidateMerchant = findPreferredCandidateMerchant(expectedPspEnum);
        checks.push({
            id: 'merchant_db',
            step: 3,
            title: 'Merchant Record in Local DB (`fare_merchants`)',
            status: 'error',
            summary: `Merchant ID #${mUuid.decodedId || '?'} was not found in 'fare_merchants'.`,
            details: candidateMerchant
                ? `Available ${expectedPspEnum} merchant in DB: #${candidateMerchant.id} (${candidateMerchant.name} — ${candidateMerchant.customUuid}).`
                : `No ${expectedPspEnum} merchant found in fare_merchants.`,
            fixAction: candidateMerchant
                ? { type: 'select_merchant', merchant: candidateMerchant, label: `⚡ Use Merchant #${candidateMerchant.id} (${candidateMerchant.name})` }
                : null
        });
    } else if (matchedMerchant.psp !== expectedPspEnum) {
        const candidateMerchant = findPreferredCandidateMerchant(expectedPspEnum);
        checks.push({
            id: 'merchant_db',
            step: 3,
            title: 'Merchant Record in Local DB (`fare_merchants`)',
            status: 'error',
            summary: `Merchant #${matchedMerchant.id} (${matchedMerchant.name}) has PSP '${matchedMerchant.psp}', expected '${expectedPspEnum}'.`,
            details: `Select a ${expectedPspEnum} merchant so PaymentCallbackController routes to the right PaymentGateway.`,
            fixAction: candidateMerchant
                ? { type: 'select_merchant', merchant: candidateMerchant, label: `⚡ Switch to Merchant #${candidateMerchant.id} (${candidateMerchant.name})` }
                : null
        });
    } else {
        checks.push({
            id: 'merchant_db',
            step: 3,
            title: 'Merchant Record in Local DB (`fare_merchants`)',
            status: 'ok',
            summary: `Merchant #${matchedMerchant.id} '${matchedMerchant.name}' (${matchedMerchant.psp} / ${matchedMerchant.paymentProviderId}) found.`,
            details: `Custom UUID: ${matchedMerchant.customUuid}`
        });
    }

    // Check 4: Callback Authentication & Gateway Credentials
    if (psp === 'moneris') {
        const kcRes = await fetchLocalKeycloakToken(customerShortname);
        const envStoreId = (process.env.MONERIS_STORE_ID || '').trim();
        const envApiToken = (process.env.MONERIS_API_TOKEN || '').trim();
        const dbStoreId = matchedMerchant ? matchedMerchant.paymentProviderId : null;
        const dbApiToken = matchedMerchant ? matchedMerchant.decryptedApiToken : null;

        const credsMatch = matchedMerchant && dbStoreId === envStoreId && dbApiToken === envApiToken;
        if (!kcRes.ok) {
            checks.push({
                id: 'auth_credentials',
                step: 4,
                title: 'Moneris Callback Auth (Keycloak JWT & MCO Credentials)',
                status: 'error',
                summary: `Keycloak token request failed: ${kcRes.error}`,
                details: `MonerisCallbackAuthenticator requires a valid Bearer JWT from keycloak.wandev.`
            });
        } else if (matchedMerchant && !credsMatch) {
            checks.push({
                id: 'auth_credentials',
                step: 4,
                title: 'Moneris Callback Auth (Keycloak JWT & MCO Credentials)',
                status: 'warn',
                summary: `Keycloak JWT OK, but Merchant #${matchedMerchant.id} DB credentials (${dbStoreId}) differ from env.local.json (${envStoreId}).`,
                details: `MonerisPaymentGateway::getPaymentDetails() uses fare_merchants credentials to verify the MCO ticket.`
            });
        } else {
            checks.push({
                id: 'auth_credentials',
                step: 4,
                title: 'Moneris Callback Auth (Keycloak JWT & MCO Credentials)',
                status: 'ok',
                summary: `Keycloak Bearer JWT acquired & Merchant #${matchedMerchant ? matchedMerchant.id : '?'} MCO credentials match env.local.json (${envStoreId}).`,
                details: `Header 'X-Payment-Provider: moneris' + 'Authorization: Bearer <jwt>' ready.`
            });
        }
    } else {
        const dbSecret = matchedMerchant ? matchedMerchant.decryptedWebhookSecret : null;
        const effectiveSecret = webhookSecret || dbSecret || '';
        const candidateWithSecret = merchants.find(m => m.psp === 'LITTLEPAY' && m.decryptedWebhookSecret);
        if (matchedMerchant && !dbSecret) {
            checks.push({
                id: 'auth_credentials',
                step: 4,
                title: 'LittlePay Webhook Signature (`Event-Signature` HMAC-SHA256)',
                status: 'error',
                summary: `Merchant #${matchedMerchant.id} (${matchedMerchant.name}) has no 'charge.authorisation.succeeded' webhook subscription in fare_merchants.`,
                details: `LittlepayCallbackAuthenticator will fail with 401 ('Subscription of type charge.authorisation.succeeded is not found.').`,
                fixAction: candidateWithSecret
                    ? { type: 'select_merchant', merchant: candidateWithSecret, label: `⚡ Switch to Merchant #${candidateWithSecret.id} (${candidateWithSecret.name})` }
                    : null
            });
        } else if (!effectiveSecret) {
            checks.push({
                id: 'auth_credentials',
                step: 4,
                title: 'LittlePay Webhook Signature (`Event-Signature` HMAC-SHA256)',
                status: 'error',
                summary: `No webhook secret key configured or found in fare_merchants.`,
                details: `LittlepayCallbackAuthenticator verifies 'Event-Signature' using HMAC-SHA256.`
            });
        } else if (dbSecret && webhookSecret && dbSecret !== webhookSecret) {
            checks.push({
                id: 'auth_credentials',
                step: 4,
                title: 'LittlePay Webhook Signature (`Event-Signature` HMAC-SHA256)',
                status: 'error',
                summary: `Configured webhook secret does not match Merchant #${matchedMerchant.id} decrypted secret in DB ('${dbSecret}').`,
                details: `Signature verification in LittlepayCallbackAuthenticator will fail with 401 Unauthorized.`,
                fixAction: { type: 'set_webhook_secret', value: dbSecret, label: `⚡ Use DB Secret (${dbSecret})` }
            });
        } else {
            checks.push({
                id: 'auth_credentials',
                step: 4,
                title: 'LittlePay Webhook Signature (`Event-Signature` HMAC-SHA256)',
                status: 'ok',
                summary: `HMAC-SHA256 secretKey verified ('${effectiveSecret}') — matches Merchant #${matchedMerchant ? matchedMerchant.id : '?'} in DB.`,
                details: `Header 'Event-Signature' will be automatically signed over the JSON payload.`
            });
        }
    }

    // Check 5: Payment Context Target Entity (save_card / cart / ewallet_reload)
    const carts = (bridgeData && bridgeData.shoppingCarts) || [];
    if (paymentContext === 'save_card') {
        if (reference && customerRef && reference !== customerRef) {
            checks.push({
                id: 'context_entity',
                step: 5,
                title: 'Payment Context Entity (`save_card` → Passenger Account)',
                status: 'warn',
                summary: `For 'save_card', reference (${reference.slice(0, 8)}…) usually equals customer_ref (${customerRef.slice(0, 8)}…).`,
                details: `SaveCardSaleConfirmedProcessor saves the PaymentToken under passengerAccountId = decoded(reference) (#${rUuid.decodedId}).`,
                fixAction: customerRef
                    ? { type: 'sync_reference_to_customer', value: customerRef, label: '⚡ Set Reference = Customer UUID' }
                    : null
            });
        } else {
            checks.push({
                id: 'context_entity',
                step: 5,
                title: 'Payment Context Entity (`save_card` → Passenger Account)',
                status: 'ok',
                summary: `Card token will be saved in 'fare_payment_tokens' for Passenger Account #${rUuid.decodedId || '?'}.`,
                details: `Passenger Custom UUID: ${reference}`
            });
        }
    } else if (paymentContext === 'cart') {
        const matchedCart = carts.find(c => String(c.id) === String(rUuid.decodedId));
        if (!matchedCart) {
            const fallbackCart = carts[0] || null;
            checks.push({
                id: 'context_entity',
                step: 5,
                title: 'Payment Context Entity (`cart` → `shopping_carts`)',
                status: 'error',
                summary: `ShoppingCart #${rUuid.decodedId || '?'} does not exist in 'shopping_carts'.`,
                details: fallbackCart
                    ? `CartSaleConfirmedProcessor requires an existing row in shopping_carts (e.g. Cart #${fallbackCart.id} → ${fallbackCart.customUuid}).`
                    : `No rows found in shopping_carts.`,
                fixAction: fallbackCart
                    ? { type: 'select_cart', cart: fallbackCart, label: `⚡ Use ShoppingCart #${fallbackCart.id}` }
                    : null
            });
        } else if (matchedCart.status !== 'WAITING_PAYMENT') {
            checks.push({
                id: 'context_entity',
                step: 5,
                title: 'Payment Context Entity (`cart` → `shopping_carts`)',
                status: 'warn',
                summary: `ShoppingCart #${matchedCart.id} has status '${matchedCart.status}' (must be 'WAITING_PAYMENT' to process).`,
                details: `CartSaleConfirmedProcessor ignores carts that are not in WAITING_PAYMENT status.`,
                fixAction: {
                    type: 'fix_cart_status',
                    cartId: matchedCart.id,
                    customUuid: matchedCart.customUuid,
                    label: `⚡ Reset Cart #${matchedCart.id} to WAITING_PAYMENT`
                }
            });
        } else {
            checks.push({
                id: 'context_entity',
                step: 5,
                title: 'Payment Context Entity (`cart` → `shopping_carts`)',
                status: 'ok',
                summary: `ShoppingCart #${matchedCart.id} is in 'WAITING_PAYMENT' status (Passenger #${matchedCart.passengerAccountId}).`,
                details: `Cart Custom UUID: ${matchedCart.customUuid}`
            });
        }
    } else {
        checks.push({
            id: 'context_entity',
            step: 5,
            title: 'Payment Context Entity (`ewallet_reload`)',
            status: rUuid.decodedId ? 'ok' : 'error',
            summary: rUuid.decodedId
                ? `eWallet Reload Reference decoded to ID #${rUuid.decodedId} (Customer #${cUuid.decodedId}).`
                : `Invalid reference UUID for ewallet_reload.`,
            details: `EwalletReloadSaleConfirmedProcessor will process reload reference #${rUuid.decodedId || '?'}.`
        });
    }

    // Check 6: Database & Async Messenger Transport (`billing_sale_transport`)
    const hasPostgres = Boolean(dockerInfo.containers && dockerInfo.containers['2cloud-postgres_main-1']) && Boolean(bridgeData && bridgeData.dbConnected);
    const hasPubsub = Boolean(dockerInfo.containers && dockerInfo.containers['2cloud-pubsub-1']);

    if (!hasPostgres) {
        checks.push({
            id: 'db_and_queue',
            step: 6,
            title: 'PostgreSQL DB & Messenger Queue (`billing_sale_transport`)',
            status: 'error',
            summary: `PostgreSQL container '2cloud-postgres_main-1' is not reachable.`,
            details: (bridgeData && bridgeData.dbError) || 'Check docker ps for 2cloud-postgres_main-1.'
        });
    } else if (!hasPubsub) {
        checks.push({
            id: 'db_and_queue',
            step: 6,
            title: 'PostgreSQL DB & Messenger Queue (`billing_sale_transport`)',
            status: 'warn',
            summary: `PostgreSQL is connected, but '2cloud-pubsub-1' container was not detected.`,
            details: `PaymentCallbackController dispatches SaleConfirmedMessage to PubSub emulator.`
        });
    } else {
        checks.push({
            id: 'db_and_queue',
            step: 6,
            title: 'PostgreSQL DB & Messenger Queue (`billing_sale_transport`)',
            status: 'ok',
            summary: `PostgreSQL ('2cloud-postgres_main-1') & PubSub ('2cloud-pubsub-1') online. Auto-consume enabled.`,
            details: `After HTTP 200 callback, 'messenger:consume billing_sale_transport --limit=1' will persist records into fare_payment_tokens / fare_sales.`
        });
    }

    const hasError = checks.some(c => c.status === 'error');
    const hasWarn = checks.some(c => c.status === 'warn');

    return {
        ok: true,
        allPassed: !hasError,
        overallStatus: hasError ? 'error' : (hasWarn ? 'warn' : 'ok'),
        psp,
        customerShortname,
        paymentContext,
        resolvedTarget: target,
        checks,
        merchants: (bridgeData && bridgeData.merchants) || [],
        shoppingCarts: (bridgeData && bridgeData.shoppingCarts) || [],
        samplePassengers: (bridgeData && bridgeData.samplePassengers) || [],
        recentTokens: (bridgeData && bridgeData.recentTokens) || [],
        recentSales: (bridgeData && bridgeData.recentSales) || [],
        inspectUuids: uuids
    };
}

/**
 * Handles POST /api/local-callback/forward
 * Builds/synthesizes the exact PSP callback (Moneris or LittlePay), sends it to
 * POST /billing/payment/callback/{customerShortname}, optionally consumes 1 message
 * from billing_sale_transport, and queries PostgreSQL to verify persisted records.
 */
async function handleLocalCallbackForward(payload = {}) {
    const psp = (payload.psp || 'littlepay').toLowerCase();
    const customerShortname = (payload.customerShortname || 'DEV-LOCAL').trim();
    const targetServerPref = payload.targetServer || 'auto';
    const paymentContext = (payload.paymentContext || 'save_card').trim();
    const merchantId = (payload.merchantId || '').trim();
    const reference = (payload.reference || '').trim();
    const customerRef = (payload.customerRef || reference).trim();
    const autoConsumeQueue = payload.autoConsumeQueue !== false;

    const dockerInfo = await inspectLocalDockerContainers();
    const target = resolveTargetContainerAndUrl(dockerInfo, targetServerPref, psp);
    const callbackUrl = `${target.baseUrl}/billing/payment/callback/${encodeURIComponent(customerShortname)}`;

    // Inspect before state in DB so we can highlight newly persisted tokens/sales
    const beforeBridge = dockerInfo.dockerRunning
        ? await runLocalPhpBridge(target.containerName, {
            action: 'discover',
            customerShortname,
            merchantId,
            reference,
            customerRef
        })
        : null;

    let requestHeaders = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Host': target.hostHeader
    };
    let callbackBodyObj = null;

    if (psp === 'moneris') {
        const ticket = (payload.ticket || '').trim();
        if (!ticket) {
            return {
                ok: false,
                error: 'A Moneris Checkout ticket is required to forward a Moneris callback.'
            };
        }

        let bearerToken = (payload.bearerToken || '').trim();
        if (!bearerToken) {
            const kcRes = await fetchLocalKeycloakToken(customerShortname);
            if (!kcRes.ok) {
                return {
                    ok: false,
                    error: `Failed to obtain Keycloak Bearer token for Moneris callback: ${kcRes.error}`
                };
            }
            bearerToken = kcRes.accessToken;
        }

        requestHeaders['X-Payment-Provider'] = 'moneris';
        requestHeaders['Authorization'] = `Bearer ${bearerToken}`;

        const effectiveMerchantId = isUuidLike(merchantId)
            ? merchantId
            : '0cd00307-cae0-5003-a0e0-0c0002150000';

        const explicitAlias = (payload.checkoutProfile || payload.checkoutProfileAlias || '').trim();
        const checkoutProfileAlias = (explicitAlias && explicitAlias !== 'auto')
            ? explicitAlias
            : resolveMonerisAliasForContext(
                paymentContext || 'save_card',
                payload.shouldSaveCard !== false,
                Boolean(payload.darkMode)
            );

        callbackBodyObj = payload.customPayloadOverride || {
            ticket: ticket,
            merchant_id: effectiveMerchantId,
            checkout_profile: checkoutProfileAlias
        };
    } else {
        // LittlePay Webhook Synthesis (charge.authorisation.succeeded)
        const matchedMerchant = ((beforeBridge && beforeBridge.merchants) || []).find(
            m => m.customUuid === merchantId || ( m.psp === 'LITTLEPAY' && !merchantId )
        );
        const webhookSecret = (payload.webhookSecret || (matchedMerchant && matchedMerchant.decryptedWebhookSecret) || 'test_secret_12345').trim();
        const paymentProviderId = (payload.paymentProviderId || (matchedMerchant && matchedMerchant.paymentProviderId) || 'matawan-testportal').trim();

        const rawMask = String(payload.cardMask || '************4242').trim();
        const normalizedMask = rawMask.length >= 4
            ? '*'.repeat(12) + rawMask.slice(-4)
            : '************4242';

        callbackBodyObj = payload.customPayloadOverride || {
            event_id: payload.eventId || `ev_sandbox_${Date.now()}`,
            type: 'charge.authorisation.succeeded',
            created_date_time: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
            data_object: {
                transaction_id: payload.transactionId || `pi_sandbox_${Date.now()}`,
                charge: {
                    order_id: payload.orderId || `ord_sandbox_${Date.now()}`,
                    amount: Number.isFinite(Number(payload.amount)) ? Number(payload.amount) : 0,
                    currency: (payload.currency || 'EUR').trim(),
                    payment_method: 'CARD',
                    saved_by_customer: payload.savedByCustomer !== false,
                    funding_source_id: payload.fundingSourceId || `fs_sandbox_${Date.now()}`,
                    acquirer_transaction_reference: Math.floor(100000 + Math.random() * 900000),
                    card_mask: normalizedMask,
                    card_expiry: (payload.cardExpiry || '12/28').trim(),
                    card_type: (payload.cardType || 'VISA').trim().toUpperCase(),
                    customer_ref: customerRef,
                    order_metadata: {
                        reference: reference,
                        merchant_id: merchantId,
                        payment_provider_id: paymentProviderId,
                        payment_context: paymentContext
                    }
                }
            }
        };

        const rawBodyForSig = JSON.stringify(callbackBodyObj);
        const hmacSignature = crypto
            .createHmac('sha256', webhookSecret)
            .update(rawBodyForSig, 'utf8')
            .digest('hex');

        requestHeaders['Event-Signature'] = hmacSignature;
    }

    const rawBodyString = JSON.stringify(callbackBodyObj);

    console.log(`\n------------------------------------------------------------`);
    console.log(`[Local Callback Forward] POST ${callbackUrl} (${psp.toUpperCase()})`);
    console.log(`[Local Callback Headers]:`, JSON.stringify(requestHeaders, null, 2));
    console.log(`[Local Callback Payload]:\n${JSON.stringify(callbackBodyObj, null, 2)}`);
    console.log(`------------------------------------------------------------\n`);

    let callbackHttpRes = await makeHttpRequest(callbackUrl, 'POST', requestHeaders, rawBodyString, 15000);
    if (
        callbackHttpRes.statusCode === 500 &&
        dockerInfo.dockerRunning &&
        typeof callbackHttpRes.body === 'string' &&
        callbackHttpRes.body.includes('Topic not found')
    ) {
        console.log(`[Local Callback Forward] Pub/Sub topic not found — creating topics & running 'enqueue:setup-broker' on ${target.containerName} and retrying...`);
        await execCommandPromise(
            'docker',
            [
                'exec',
                target.containerName,
                'php',
                '-r',
                'require "/projects/services/app/vendor/autoload.php"; (new \\Symfony\\Component\\Dotenv\\Dotenv())->usePutenv()->bootEnv("/projects/services/app/.env"); $c = new \\Google\\Cloud\\PubSub\\PubSubClient(["projectId" => getenv("PUBSUB_PROJECT_ID") ?: "local"]); foreach (["event-sale", "event-sale-deadletter", "event-sale-item", "event-sale-item-deadletter", "event-ewallet", "event-ewallet-deadletter", "event-process-operation", "event-process-operation-deadletter"] as $t) { $tp = $c->topic($t); if (!$tp->exists()) { $tp->create(); } }'
            ],
            8000
        );
        await execCommandPromise(
            'docker',
            ['exec', target.containerName, 'php', 'bin/console', 'enqueue:setup-broker'],
            8000
        );
        callbackHttpRes = await makeHttpRequest(callbackUrl, 'POST', requestHeaders, rawBodyString, 15000);
    }

    let parsedCallbackResBody = callbackHttpRes.body;
    try {
        parsedCallbackResBody = callbackHttpRes.body ? JSON.parse(callbackHttpRes.body) : { status: `${callbackHttpRes.statusCode} ${callbackHttpRes.statusMessage || 'OK'}` };
    } catch (e) {
        parsedCallbackResBody = callbackHttpRes.body || `${callbackHttpRes.statusCode} ${callbackHttpRes.statusMessage}`;
    }

    const callbackSucceeded = callbackHttpRes.statusCode >= 200 && callbackHttpRes.statusCode < 300;

    // Step 3b: Consume 1 message from billing_sale_transport so SaleConfirmedHandler persists to DB immediately
    let consumerResult = null;
    if (callbackSucceeded && autoConsumeQueue && dockerInfo.dockerRunning) {
        const consumeCmd = await execCommandPromise(
            'docker',
            [
                'exec',
                target.containerName,
                'php',
                'bin/console',
                'messenger:consume',
                'billing_sale_transport',
                '--limit=1',
                '--time-limit=4',
                '--no-interaction',
                '-v'
            ],
            8000
        );
        consumerResult = {
            ok: consumeCmd.ok,
            output: consumeCmd.stdout || consumeCmd.stderr
        };
    }

    // Step 4: Inspect DB state after callback & queue consumption
    const afterBridge = dockerInfo.dockerRunning
        ? await runLocalPhpBridge(target.containerName, {
            action: 'discover',
            customerShortname,
            merchantId,
            reference,
            customerRef
        })
        : null;

    const beforeTokenIds = new Set(((beforeBridge && beforeBridge.recentTokens) || []).map(t => t.id));
    const afterTokens = (afterBridge && afterBridge.recentTokens) || [];
    const newTokens = afterTokens.filter(t => !beforeTokenIds.has(t.id));

    const beforeSaleIds = new Set(((beforeBridge && beforeBridge.recentSales) || []).map(s => s.id));
    const afterSales = (afterBridge && afterBridge.recentSales) || [];
    const newSales = afterSales.filter(s => !beforeSaleIds.has(s.id));

    const decodedCustomerId = afterBridge?.inspectUuids?.customerRef?.decodedId
        || afterBridge?.inspectUuids?.reference?.decodedId
        || null;
    const customerTokens = decodedCustomerId
        ? afterTokens.filter(t => String(t.passengerAccountId) === String(decodedCustomerId))
        : afterTokens.slice(0, 3);

    const decodedRefId = afterBridge?.inspectUuids?.reference?.decodedId || null;
    const updatedCart = (paymentContext === 'cart' && decodedRefId && afterBridge?.shoppingCarts)
        ? afterBridge.shoppingCarts.find(c => String(c.id) === String(decodedRefId))
        : null;

    return {
        ok: callbackSucceeded,
        psp,
        customerShortname,
        paymentContext,
        targetContainer: target.containerName,
        callbackRequest: {
            url: callbackUrl,
            method: 'POST',
            headers: {
                ...requestHeaders,
                ...(requestHeaders.Authorization ? { Authorization: `${requestHeaders.Authorization.slice(0, 32)}…[JWT]` } : {})
            },
            payload: callbackBodyObj
        },
        callbackResponse: {
            statusCode: callbackHttpRes.statusCode,
            statusMessage: callbackHttpRes.statusMessage,
            body: parsedCallbackResBody
        },
        consumerResult,
        persistence: {
            newTokens,
            customerTokens: customerTokens.slice(0, 5),
            newSales,
            recentSales: afterSales.slice(0, 5),
            updatedCart
        }
    };
}

/**
 * Master Registry of Supported PSP Backend Handlers
 *
 * To add a new PSP on the server:
 * 1. Implement an async handler function `handle<Name>Session(sessionParams, res)`.
 * 2. Register it in `PSP_HANDLERS` below with the corresponding `psp` ID.
 */
const PSP_HANDLERS = {
    littlepay: handleLittlepaySession,
    moneris: handleMonerisSession
};

/**
 * Core Request Router & Server Logic
 */
const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    // Route: API proxy to bypass CORS for localhost development
    if (req.method === 'POST' && pathname === '/api/create-session') {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
        });

        req.on('end', async () => {
            console.log(`\n============================================================`);
            console.log(`[Incoming Request] POST /api/create-session`);
            console.log(`[Request Payload]:\n${body}`);
            console.log(`============================================================\n`);

            try {
                const sessionParams = JSON.parse(body);
                const psp = sessionParams.psp || 'littlepay';

                const handler = PSP_HANDLERS[psp];
                if (!handler) {
                    sendJsonResponse(res, 400, {
                        error: `Unsupported PSP: '${psp}'. Supported PSPs are: ${Object.keys(PSP_HANDLERS).join(', ')}`
                    }, 'POST /api/create-session Error');
                    return;
                }

                await handler(sessionParams, res);
            } catch (err) {
                console.error('[Proxy Error] Core failure:', err);
                sendJsonResponse(res, 500, { error: `Local proxy core failure: ${err.message}` }, 'POST /api/create-session Error');
            }
        });
        return;
    }

    // Route: Littlepay Receipt / Payment Intent & Stored Payment Methods Inspection Endpoint
    if (req.method === 'POST' && pathname === '/api/littlepay-receipt') {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
        });

        req.on('end', async () => {
            console.log(`\n============================================================`);
            console.log(`[Incoming Request] POST /api/littlepay-receipt`);
            console.log(`[Request Payload]:\n${body}`);
            console.log(`============================================================\n`);

            try {
                const {
                    client_token,
                    order_id,
                    payment_intent_id,
                    customer_ref,
                    amount = 0,
                    currency = 'EUR',
                    metadata = {}
                } = JSON.parse(body);

                let decoded = decodeLittlepayClientToken(client_token);

                // Fallback: if client_token was not supplied, generate a temporary 0-amount order to obtain customer auth_token
                if ((!decoded || !decoded.auth_token) && customer_ref && process.env.LITTLEPAY_API_KEY) {
                    const tempOrderRes = await makeHttpsRequest(
                        'https://checkout.sandbox.littlepay.com/merchant/v1/orders',
                        'POST',
                        {
                            'Content-Type': 'application/json',
                            'X-Api-Key': process.env.LITTLEPAY_API_KEY
                        },
                        JSON.stringify({
                            customer_ref: customer_ref,
                            charge: { amount: 0, currency: currency || 'EUR' }
                        })
                    );
                    if (tempOrderRes.statusCode >= 200 && tempOrderRes.statusCode < 300) {
                        const tempOrderData = JSON.parse(tempOrderRes.body);
                        decoded = decodeLittlepayClientToken(tempOrderData.client_token);
                    }
                }

                if (!decoded || !decoded.auth_token) {
                    sendJsonResponse(res, 400, {
                        error: 'Unable to decode Littlepay client_token or retrieve customer auth_token.'
                    }, 'POST /api/littlepay-receipt Error');
                    return;
                }

                const httpsApi = (decoded.https_api || 'https://checkout.sandbox.littlepay.com/customer/v1').replace(/\/$/, '');
                const authHeaders = {
                    'Accept': 'application/json',
                    'Authorization': `Bearer ${decoded.auth_token}`
                };

                const intentId = payment_intent_id || (decoded.jwt_claims && decoded.jwt_claims.payment_intent_id);
                let paymentIntent = null;
                if (intentId) {
                    const piRes = await makeHttpsRequest(
                        `${httpsApi}/payment-intents/${intentId}`,
                        'GET',
                        authHeaders
                    );
                    try {
                        paymentIntent = JSON.parse(piRes.body);
                    } catch (e) {
                        paymentIntent = { statusCode: piRes.statusCode, rawBody: piRes.body };
                    }
                }

                let storedPaymentMethods = [];
                const spmListRes = await makeHttpsRequest(
                    `${httpsApi}/stored-payment-methods`,
                    'GET',
                    authHeaders
                );
                try {
                    const parsedSpm = JSON.parse(spmListRes.body);
                    if (Array.isArray(parsedSpm)) {
                        storedPaymentMethods = parsedSpm;
                    }
                } catch (e) {
                    storedPaymentMethods = [];
                }

                // Sort by created_at descending to identify the most recently registered card
                const sortedMethods = [...storedPaymentMethods].sort((a, b) => {
                    return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
                });
                const latestStoredPaymentMethod = sortedMethods[0] || null;

                let latestStoredPaymentMethodDetail = null;
                if (latestStoredPaymentMethod && latestStoredPaymentMethod.id) {
                    const spmDetailRes = await makeHttpsRequest(
                        `${httpsApi}/stored-payment-methods/${latestStoredPaymentMethod.id}`,
                        'GET',
                        authHeaders
                    );
                    try {
                        latestStoredPaymentMethodDetail = JSON.parse(spmDetailRes.body);
                    } catch (e) {
                        latestStoredPaymentMethodDetail = null;
                    }
                }

                const cardMask = (latestStoredPaymentMethod && latestStoredPaymentMethod.card_mask)
                    || (latestStoredPaymentMethodDetail && latestStoredPaymentMethodDetail.card_mask)
                    || null;
                const formattedMaskedPan = cardMask && String(cardMask).trim().length >= 4
                    ? '*'.repeat(12) + String(cardMask).trim().slice(-4)
                    : 'SAVED_CARD';

                sendJsonResponse(res, 200, {
                    order_id: order_id || (decoded.jwt_claims && decoded.jwt_claims.order_id) || null,
                    payment_intent_id: intentId || null,
                    customer_ref: customer_ref || (decoded.jwt_claims && decoded.jwt_claims.customer_id) || null,
                    amount: amount,
                    currency: currency,
                    metadata: metadata,
                    paymentIntent: paymentIntent,
                    storedPaymentMethods: storedPaymentMethods,
                    latestStoredPaymentMethod: latestStoredPaymentMethod,
                    latestStoredPaymentMethodDetail: latestStoredPaymentMethodDetail,
                    formattedMaskedPan: formattedMaskedPan
                }, 'POST /api/littlepay-receipt');

            } catch (err) {
                console.error('[Proxy Littlepay Error] Receipt inspection error:', err);
                sendJsonResponse(res, 500, { error: err.message }, 'POST /api/littlepay-receipt Error');
            }
        });
        return;
    }

    // Route: Moneris Receipt Verification Endpoint
    if (req.method === 'POST' && pathname === '/api/moneris-receipt') {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
        });

        req.on('end', async () => {
            console.log(`\n============================================================`);
            console.log(`[Incoming Request] POST /api/moneris-receipt`);
            console.log(`[Request Payload]:\n${body}`);
            console.log(`============================================================\n`);

            try {
                const { ticket } = JSON.parse(body);
                const storeId = process.env.MONERIS_STORE_ID;
                const apiToken = process.env.MONERIS_API_TOKEN;
                const checkoutId = process.env.MONERIS_CHECKOUT_ID;
                const envMode = process.env.MONERIS_ENV || 'qa';

                if (!checkoutId || checkoutId === 'FILLME') {
                    sendJsonResponse(res, 400, { error: 'MONERIS_CHECKOUT_ID is not configured or set to FILLME. Please configure MONERIS_CHECKOUT_ID in your env.local.json file.' }, 'POST /api/moneris-receipt Error');
                    return;
                }

                const mcoUrl = envMode === 'prod'
                    ? 'https://gateway.moneris.com/chktv2/request/request.php'
                    : 'https://gatewayt.moneris.com/chktv2/request/request.php';

                const receiptPayload = {
                    store_id: storeId,
                    api_token: apiToken,
                    checkout_id: checkoutId,
                    ticket: ticket,
                    environment: envMode,
                    action: 'receipt'
                };

                const receiptRes = await makeHttpsRequest(
                    mcoUrl,
                    'POST',
                    {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json'
                    },
                    JSON.stringify(receiptPayload)
                );

                console.log(`[Proxy Moneris] Receipt Verification Response (${receiptRes.statusCode}):`, receiptRes.body);
                sendJsonResponse(res, receiptRes.statusCode, receiptRes.body, 'POST /api/moneris-receipt');

            } catch (err) {
                console.error('[Proxy Moneris Error] Receipt verification error:', err);
                sendJsonResponse(res, 500, { error: err.message }, 'POST /api/moneris-receipt Error');
            }
        });
        return;
    }

    // Route: Moneris Vault - Process Saved Token (Purchase or Card Verification)
    if (req.method === 'POST' && pathname === '/api/moneris-process-token') {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
        });

        req.on('end', async () => {
            console.log(`\n============================================================`);
            console.log(`[Incoming Request] POST /api/moneris-process-token`);
            console.log(`[Request Payload]:\n${body}`);
            console.log(`============================================================\n`);

            try {
                const {
                    dataKey,
                    orderNo,
                    amount,
                    custId,
                    action = 'purchase',
                    cryptType = '7',
                    mitType,
                    expDate
                } = JSON.parse(body);

                const storeId = (process.env.MONERIS_STORE_ID || '').trim();
                const apiToken = (process.env.MONERIS_API_TOKEN || '').trim();
                const envMode = (process.env.MONERIS_ENV || 'qa').trim().toLowerCase();

                if (!storeId || storeId === 'FILLME' || !apiToken || apiToken === 'FILLME') {
                    sendJsonResponse(res, 400, {
                        error: 'MONERIS_STORE_ID or MONERIS_API_TOKEN is not configured or set to FILLME. Please check your env.local.json file to process transactions with the token.'
                    }, 'POST /api/moneris-process-token Error');
                    return;
                }

                if (!dataKey) {
                    sendJsonResponse(res, 400, { error: 'dataKey (Hosted Token) is required.' }, 'POST /api/moneris-process-token Error');
                    return;
                }

                const mpgUrl = envMode === 'prod'
                    ? 'https://www3.moneris.com/gateway2/servlet/MpgRequest'
                    : 'https://esqa.moneris.com/gateway2/servlet/MpgRequest';

                const orderId = orderNo || `ORD-${Date.now()}`;
                const customerId = custId || '1';
                const formattedAmount = (parseFloat(amount) || 10.00).toFixed(2);
                const expDateXml = expDate ? `<expdate>${expDate}</expdate>` : '';

                let cofXml = '';
                if (mitType) {
                    cofXml = '<cof_info><payment_indicator>U</payment_indicator><payment_information>2</payment_information></cof_info>';
                }

                let txnXml = '';
                if (action === 'card_verification') {
                    txnXml = `<res_cardverification_cc>
                        <data_key>${dataKey}</data_key>
                        <order_id>${orderId}</order_id>
                        <cust_id>${customerId}</cust_id>
                        <crypt_type>${cryptType}</crypt_type>
                        ${expDateXml}
                        ${cofXml}
                    </res_cardverification_cc>`;
                } else if (action === 'vault_add') {
                    txnXml = `<res_add_token>
                        <data_key>${dataKey}</data_key>
                        <cust_id>${customerId}</cust_id>
                        <crypt_type>${cryptType}</crypt_type>
                        ${expDateXml}
                        <data_key_format>0</data_key_format>
                    </res_add_token>`;
                } else {
                    // Default: 'purchase'
                    txnXml = `<res_purchase_cc>
                        <data_key>${dataKey}</data_key>
                        <order_id>${orderId}</order_id>
                        <cust_id>${customerId}</cust_id>
                        <amount>${formattedAmount}</amount>
                        <crypt_type>${cryptType}</crypt_type>
                        ${expDateXml}
                        ${cofXml}
                    </res_purchase_cc>`;
                }

                const xmlPayload = `<?xml version="1.0" encoding="UTF-8"?>
<request>
    <store_id>${storeId}</store_id>
    <api_token>${apiToken}</api_token>
    <status_check>false</status_check>
    ${txnXml}
</request>`;

                console.log(`[Proxy Moneris HT] Sending ${action} transaction for DataKey: ${dataKey.substring(0, 8)}... to ${mpgUrl}...`);

                const mpgRes = await makeHttpsRequest(
                    mpgUrl,
                    'POST',
                    {
                        'Content-Type': 'application/xml',
                        'Accept': 'application/xml'
                    },
                    xmlPayload
                );

                console.log(`[Proxy Moneris HT] MpgRequest Response (${mpgRes.statusCode}):`, mpgRes.body);

                const receipt = parseMonerisXmlReceipt(mpgRes.body);
                const respCodeNum = parseInt(receipt.ResponseCode, 10);
                const isComplete = String(receipt.Complete).toLowerCase() === 'true';
                const hasApprovedCode = !isNaN(respCodeNum) && respCodeNum >= 0 && respCodeNum < 50;
                const isMessageDeclined = String(receipt.Message || '').toUpperCase().includes('DECLIN');

                let isApproved = false;
                if (action === 'vault_add') {
                    isApproved = isComplete && String(receipt.ResSuccess).toLowerCase() === 'true';
                } else {
                    isApproved = isComplete && hasApprovedCode && !isMessageDeclined;
                }

                sendJsonResponse(res, 200, {
                    success: isApproved,
                    action: action,
                    orderId: orderId,
                    amount: action === 'purchase' ? formattedAmount : '0.00',
                    receipt: receipt,
                    rawXml: mpgRes.body
                }, 'POST /api/moneris-process-token');

            } catch (err) {
                console.error('[Proxy Moneris Error] Process token error:', err);
                sendJsonResponse(res, 500, { error: err.message }, 'POST /api/moneris-process-token Error');
            }
        });
        return;
    }

    function scheduleSandboxServerRestart(reason = 'User requested restart from Sandbox UI') {
    console.log(`\n============================================================`);
    console.log(`[Server Restart] Scheduling clean sandbox server restart (${reason})...`);
    console.log(`[Server Restart] Old PID: ${process.pid}`);
    console.log(`============================================================\n`);

    setTimeout(() => {
        server.close(() => {
            console.log(`[Server Restart] Port ${PORT} released by PID ${process.pid}. Spawning new server.js instance...`);
            let outFd = 'ignore';
            let errFd = 'ignore';
            try {
                outFd = fs.openSync('/tmp/psp-sandbox.log', 'a');
                errFd = fs.openSync('/tmp/psp-sandbox.log', 'a');
            } catch (e) {
                outFd = 'ignore';
                errFd = 'ignore';
            }

            const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
                cwd: __dirname,
                detached: true,
                stdio: ['ignore', outFd, errFd]
            });
            child.unref();
            process.exit(0);
        });

        // Fallback in case keep-alive sockets delay server.close()
        setTimeout(() => {
            try {
                let outFd = 'ignore';
                let errFd = 'ignore';
                try {
                    outFd = fs.openSync('/tmp/psp-sandbox.log', 'a');
                    errFd = fs.openSync('/tmp/psp-sandbox.log', 'a');
                } catch (e) {}
                const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
                    cwd: __dirname,
                    detached: true,
                    stdio: ['ignore', outFd, errFd]
                });
                child.unref();
            } catch (e) {}
            process.exit(0);
        }, 400);
    }, 150);
}
    // Route: Configuration Info for Frontend
    if (req.method === 'GET' && pathname === '/api/config') {
        console.log(`\n============================================================`);
        console.log(`[Incoming Request] GET /api/config`);
        console.log(`============================================================\n`);

        sendJsonResponse(res, 200, {
            server: {
                pid: process.pid,
                bootTime: SERVER_BOOT_TIME,
                uptimeSeconds: Math.round(process.uptime())
            },
            moneris: {
                environment: process.env.MONERIS_ENV || 'qa',
                storeId: process.env.MONERIS_STORE_ID || '',
                checkoutId: (process.env.MONERIS_CHECKOUT_ID || '').trim() || resolveMonerisCheckoutId('save_card', true, false),
                checkoutProfiles: getMonerisCheckoutProfilesMap(),
                aliases: MONERIS_PROFILE_ALIASES
            }
        }, 'GET /api/config');
        return;
    }

    // Route: Update Moneris Checkout Profile & Optionally Restart Server
    if (req.method === 'POST' && pathname === '/api/moneris/config') {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
        });

        req.on('end', async () => {
            console.log(`\n============================================================`);
            console.log(`[Incoming Request] POST /api/moneris/config`);
            console.log(`[Request Payload]:\n${body}`);
            console.log(`============================================================\n`);

            try {
                const payload = body ? JSON.parse(body) : {};
                const checkoutId = (payload.checkoutId || '').trim();
                const targetAlias = (payload.alias || 'all').trim();
                const customProfiles = (payload.checkoutProfiles && typeof payload.checkoutProfiles === 'object')
                    ? payload.checkoutProfiles
                    : null;
                const syncLocalDb = payload.syncLocalDb !== false;
                const restartServer = Boolean(payload.restartServer);

                let envLocal = {};
                if (fs.existsSync('env.local.json')) {
                    try {
                        envLocal = JSON.parse(fs.readFileSync('env.local.json', 'utf-8'));
                    } catch (e) {
                        envLocal = {};
                    }
                }

                const currentProfiles = getMonerisCheckoutProfilesMap();
                let updatedProfiles = { ...currentProfiles };

                if (customProfiles) {
                    for (const alias of MONERIS_PROFILE_ALIASES) {
                        if (customProfiles[alias] && String(customProfiles[alias]).trim()) {
                            updatedProfiles[alias] = String(customProfiles[alias]).trim();
                        }
                    }
                }

                if (checkoutId) {
                    if (targetAlias === 'all' || targetAlias === 'auto' || !MONERIS_PROFILE_ALIASES.includes(targetAlias)) {
                        envLocal.MONERIS_CHECKOUT_ID = checkoutId;
                        for (const alias of MONERIS_PROFILE_ALIASES) {
                            updatedProfiles[alias] = checkoutId;
                        }
                    } else {
                        updatedProfiles[targetAlias] = checkoutId;
                        if (!envLocal.MONERIS_CHECKOUT_ID) {
                            envLocal.MONERIS_CHECKOUT_ID = checkoutId;
                        }
                    }
                }

                if (payload.storeId && String(payload.storeId).trim()) {
                    envLocal.MONERIS_STORE_ID = String(payload.storeId).trim();
                }
                if (payload.environment && String(payload.environment).trim()) {
                    envLocal.MONERIS_ENV = String(payload.environment).trim().toLowerCase();
                }

                envLocal.MONERIS_CHECKOUT_PROFILES = updatedProfiles;

                fs.writeFileSync('env.local.json', JSON.stringify(envLocal, null, 2) + '\n', 'utf-8');
                loadEnvConfig();

                let dbSyncResult = null;
                if (syncLocalDb) {
                    try {
                        const dockerInfo = await inspectLocalDockerContainers();
                        if (dockerInfo.dockerRunning) {
                            const target = resolveTargetContainerAndUrl(dockerInfo, 'auto', 'moneris');
                            dbSyncResult = await runLocalPhpBridge(target.containerName, {
                                action: 'update_moneris_profiles',
                                profilesMap: updatedProfiles
                            });
                        }
                    } catch (dbErr) {
                        dbSyncResult = { ok: false, error: dbErr.message };
                    }
                }

                const responsePayload = {
                    ok: true,
                    restarting: restartServer,
                    previousPid: process.pid,
                    server: {
                        pid: process.pid,
                        bootTime: SERVER_BOOT_TIME
                    },
                    moneris: {
                        environment: process.env.MONERIS_ENV || 'qa',
                        storeId: process.env.MONERIS_STORE_ID || '',
                        checkoutId: (process.env.MONERIS_CHECKOUT_ID || '').trim() || resolveMonerisCheckoutId('save_card', true, false),
                        checkoutProfiles: getMonerisCheckoutProfilesMap()
                    },
                    dbSyncResult
                };

                sendJsonResponse(res, 200, responsePayload, 'POST /api/moneris/config');

                if (restartServer) {
                    scheduleSandboxServerRestart(`Moneris Checkout Profile updated to '${checkoutId || targetAlias}'`);
                }
            } catch (err) {
                console.error('[Moneris Config Update Error]:', err);
                sendJsonResponse(res, 500, { error: err.message }, 'POST /api/moneris/config Error');
            }
        });
        return;
    }

    // Route: Restart Sandbox Server on Demand
    if (req.method === 'POST' && pathname === '/api/server/restart') {
        console.log(`\n============================================================`);
        console.log(`[Incoming Request] POST /api/server/restart`);
        console.log(`============================================================\n`);

        loadEnvConfig();
        sendJsonResponse(res, 200, {
            ok: true,
            restarting: true,
            previousPid: process.pid,
            message: 'Sandbox server is restarting and reloading env.local.json...'
        }, 'POST /api/server/restart');

        scheduleSandboxServerRestart('Manual restart triggered from UI');
        return;
    }

    // Route: Local Backend Callback Pre-Flight Checks, Discovery & Quick-Fix Actions
    if (req.method === 'POST' && pathname === '/api/local-callback/preflight') {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
        });

        req.on('end', async () => {
            console.log(`\n============================================================`);
            console.log(`[Incoming Request] POST /api/local-callback/preflight`);
            console.log(`[Request Payload]:\n${body}`);
            console.log(`============================================================\n`);

            try {
                const payload = body ? JSON.parse(body) : {};
                const result = await handleLocalCallbackPreflight(payload);
                sendJsonResponse(res, 200, result, 'POST /api/local-callback/preflight');
            } catch (err) {
                console.error('[Local Callback Preflight Error]:', err);
                sendJsonResponse(res, 500, { error: err.message }, 'POST /api/local-callback/preflight Error');
            }
        });
        return;
    }

    // Route: Local Backend Callback Synthesis & Direct Forwarding (Moneris & LittlePay)
    if (req.method === 'POST' && pathname === '/api/local-callback/forward') {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
        });

        req.on('end', async () => {
            console.log(`\n============================================================`);
            console.log(`[Incoming Request] POST /api/local-callback/forward`);
            console.log(`[Request Payload]:\n${body}`);
            console.log(`============================================================\n`);

            try {
                const payload = body ? JSON.parse(body) : {};
                const result = await handleLocalCallbackForward(payload);
                sendJsonResponse(res, 200, result, 'POST /api/local-callback/forward');
            } catch (err) {
                console.error('[Local Callback Forward Error]:', err);
                sendJsonResponse(res, 500, { error: err.message }, 'POST /api/local-callback/forward Error');
            }
        });
        return;
    }

    // Route: Static Files Server
    let filePath = '.' + pathname;
    if (filePath === './') {
        filePath = './index.html';
    }

    filePath = filePath.split('?')[0];

    const extname = String(path.extname(filePath)).toLowerCase();
    const mimeTypes = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
    };

    const contentType = mimeTypes[extname] || 'application/octet-stream';

    fs.readFile(filePath, (error, content) => {
        if (error) {
            if (error.code === 'ENOENT') {
                res.writeHead(404, { 'Content-Type': 'text/html' });
                res.end('<h3>404 Not Found</h3>', 'utf-8');
            } else {
                res.writeHead(500);
                res.end(`Server Error: ${error.code} ..\n`);
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });
});

server.listen(PORT, () => {
    console.log(`------------------------------------------------------------`);
    console.log(`🚀 Multi-PSP Checkout Demo running at http://localhost:${PORT}`);
    console.log(`📦 Registered PSP Handlers: ${Object.keys(PSP_HANDLERS).join(', ')}`);
    console.log(`------------------------------------------------------------`);
});
