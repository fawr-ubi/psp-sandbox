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
