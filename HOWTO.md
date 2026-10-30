# PSP Sandbox — Concise How-To Guide

## 1. Start the Sandbox
1. Copy `env.json` to `env.local.json` and fill in your sandbox keys (`LITTLEPAY_API_KEY`, `MONERIS_STORE_ID`, `MONERIS_API_TOKEN`, `MONERIS_CHECKOUT_ID`).
2. Run:
   ```bash
   node server.js
   ```
3. Open **`http://localhost:8000`** in your browser.
4. Pick your preferred UI theme (**Dark**, **Light**, or **Color**) in the top-right header — it is saved automatically for future sessions.

---

## 2. Test a Littlepay Flow
1. In **1. Session Configuration**, select **Payment Service Provider (PSP)**: `Littlepay`.
2. Choose **Checkout Method**:
   - `Inline Drop-in SDK` to mount the interactive card form inside Panel 2.
   - `Hosted Payment Link` to generate a redirect URL.
3. Set `Amount` (`0` for card registration, `> 0` for a sale) and verify the `metadata` rows (`reference`, `merchant_id`, `payment_context`).
4. Click **Generate Token & Register Card** (or **Generate Payment Link**).
5. Submit the card in Panel 2. Panel 3 (**3. SDK & Gateway Logs**) automatically logs the SDK events, fetches the Littlepay Payment Intent / Funding Source details, and forwards the webhook to `wfwp-platform` if **AUTO-ON** is enabled.

---

## 3. Test a Moneris Checkout (MCO) Flow
1. Select **Payment Service Provider (PSP)**: `Moneris` and **Checkout Method**: `Moneris Checkout (MCO Drop-in)`.
2. Under **Moneris Checkout Profile & Server Control**, pick the profile matching your test scenario:
   - **`save_card_*` (`chktCFAGT15557`)**: Card Verification (`$0.00` allowed). Automatically sets `Amount = 0`, `payment_context = save_card`, and `reference` to Passenger `#2858`.
   - **`payment_with_save_card_*` (`chktTHANC15557`)**: Purchase + Tokenize (`> $0.00` required). Automatically sets `Amount = 1000` (`$10.00 CAD`), `payment_context = cart`, and `reference` to ShoppingCart `#10`.
   - **`payment_without_save_card_*` (`chktRGSK815557`)**: Purchase Only (`> $0.00` required). Automatically sets `Amount = 1000`, `payment_context = cart`, and `shouldSaveCard = false`.
3. Click **Apply Profile & Restart Server** to update `env.local.json`, sync `fare_merchants` in local PostgreSQL, and hot-restart the Node proxy.
4. Click **Initialize Moneris Checkout (MCO)** to mount the full-size checkout iframe in Panel 2 and complete the test transaction.

---

## 4. Test Moneris Vault (`Pay with Saved Data Key`)
1. Select **Payment Service Provider (PSP)**: `Moneris` and **Checkout Method**: `Pay with Saved Data Key (Vault)`.
2. Select a saved `data_key` token (captured automatically from previous MCO checkouts) or paste one manually.
3. Choose **Transaction Action** (`Purchase` or `$0.00 Card Verification`) and **Crypt Type** (`7`, `1`, or `2`), then click **Pay with Saved Data Key**.

---

## 5. Forward Callbacks to Local `wfwp-platform`
Switch to the **Local Backend Callback (`wfwp-platform`)** tab to inspect or replay backend webhooks step by step (`01` → `05`):

- **Step `01` (Target & Context)**: Choose tenant (`DEV-LOCAL`), context (`save_card` or `cart`), and target container (`127.0.0.1:8099`).
- **Step `02` (DB Entities & UUIDv5)**: Click **Auto-Fill from Local DB** to load real `fare_merchants`, `passenger_accounts`, and `shopping_carts` from local PostgreSQL, or encode any raw integer ID into a Custom UUIDv5.
- **Step `03` (PSP Payload & Auth)**: Inspect the Littlepay `Event-Signature` secret or Moneris `ticket` / `shouldSaveCard` parameters, and keep **Auto-consume `billing_sale_event_transport` queue** checked.
- **Step `04` (Pre-Flight Checks `6/6`)**: Click **Run Pre-Flight Checks** to confirm all 6 checks show `[OK]` before sending a callback.
- **Step `05` (Forward & Verify DB)**: Click **Forward / Replay Callback to Local Server** to send `POST /billing/payment/callback/DEV-LOCAL` and inspect the newly persisted rows in `fare_payment_tokens`, `fare_sales`, and `shopping_carts`.

---

## 6. Inspect Logs Efficiently
In **3. SDK & Gateway Logs** (at the bottom of the Checkout Playground):
- Click any **Attempt #N** header to collapse/expand that payment attempt.
- Use **Fold Payloads** / **Fold Line** to collapse large JSON objects.
- Use **Mono Logs** for single-color terminal output, **Taller** / **Maximize** for more vertical space, or **New Tab ↗** to keep live logs open on a second monitor.
