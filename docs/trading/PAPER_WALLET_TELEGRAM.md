# Design: Paper-wallet funding & withdrawal via Telegram

**Status:** Design only — not implemented  
**Scope:** `trading-agent` repo only (`middleware-platform`)  
**Mode:** Paper money exclusively — no live broker path

---

## 1. Problem

Operators need to set and adjust **paper cash** from Telegram (deposit / withdraw) so later paper trades have a real buying-power number. Today this repo has:

- No Telegram bot
- No cash / wallet table
- `paper_orders` / `paper_positions` schema stubs with **zero writers**
- No fund/withdraw commands or tools

This doc defines commands, auth (hard gate), single-writer balance, audit, and limits before any code ships.

---

## 2. Current code path (identity) — factual

### Telegram

| Question | Answer |
|----------|--------|
| Does a Telegram bot exist in this repo? | **No** — no `telegram-bot.js` (or any Telegram handler). |
| L7 status | `docs/trading/LAYER_STATUS.md`: “Telegram alerts \| **Not started**” |
| Sender identity check on Telegram commands? | **Does not exist** — there is no command surface to check. |

**Hard prerequisite:** Before `/fund` or `/withdraw` ship, Telegram ingress **must** gate on an allowlisted Telegram `user_id` (and optionally `chat_id`). Shipping balance mutation without this is a ship-blocker, not a nice-to-have.

### Closest existing “command” path (HTTP chat — not Telegram)

The only agent message entry today is HTTP chat:

| Step | File | Function | What it checks |
|------|------|----------|----------------|
| Route | `middleware-platform/routes/trading-chat.js` | `registerTradingChatRoutes` | Registers `POST /api/trading/chat/turn` |
| Handler | `middleware-platform/services/trading-chat-service.js` | `handleTradingChatMessage` | `TRADING_AGENT_ENABLED === '1'` → else **501**; requires non-empty `message` |
| Turn | `middleware-platform/services/trading-turn-resolver.js` | `runTradingTurn` | Orchestration |
| Stub | `middleware-platform/services/trading-rails/execute-turn.js` | `executeTurn` | Writes session + history only |

**Plain statement:** `handleTradingChatMessage` does **not** verify who the sender is. It accepts a client-supplied `session_id` / `X-Trading-Session` and a message. There is no JWT, no Telegram `user_id`, no allowlist, no `assertCaller`. The only gate is the feature flag `TRADING_AGENT_ENABLED`.

```4:33:middleware-platform/services/trading-chat-service.js
const AGENT_ENABLED = String(process.env.TRADING_AGENT_ENABLED || '').trim() === '1';

async function handleTradingChatMessage(req) {
  // ...
  if (!AGENT_ENABLED) { return { status: 501, ... }; }
  // ...
  const out = await runTradingTurn({
    sessionId: sessionId || `sess-${Date.now()}`,
    message,
    channel: 'chat',
  });
```

**Implication for this design:** Do **not** reuse the open chat turn path to mutate cash. Fund/withdraw must go through a **dedicated Telegram command handler** with identity checks, never through free-form LLM tool calls alone.

---

## 3. Commands (exact UX)

### Primary commands

| Intent | Command | Example |
|--------|---------|---------|
| Deposit (credit paper cash) | `/fund <amount>` | `/fund 1000` |
| Withdraw (debit paper cash) | `/withdraw <amount>` | `/withdraw 500` |
| Balance (read-only) | `/balance` | `/balance` |
| Cancel pending confirm | `/cancel` | `/cancel` |

**Amount rules**

- USD paper units, decimal allowed (e.g. `1000`, `1000.50`)
- Must parse as finite number `> 0`
- Max 2 decimal places
- Reject scientific notation / negatives / NaN with a clear reply (no side effects)

### Confirmation (required — never single-message mutate)

Balance **must not** change on the first message alone.

**Happy path — fund**

1. User: `/fund 1000`
2. Bot (after auth + limit pre-check):  
   `Confirm paper DEPOSIT of $1,000.00?`  
   `Current balance: $X.XX → after: $Y.YY`  
   `Reply /confirm_fund within 60s, or /cancel`
3. User: `/confirm_fund`
4. Bot runs single-writer credit; replies with new balance + ledger id

**Happy path — withdraw**

1. User: `/withdraw 500`
2. Bot:  
   `Confirm paper WITHDRAWAL of $500.00?`  
   `Current balance: $X.XX → after: $Z.ZZ`  
   `Reply /confirm_withdraw within 60s, or /cancel`
3. User: `/confirm_withdraw`
4. Bot runs single-writer debit (rejects if insufficient cash); replies with new balance + ledger id

**Rules**

- Pending confirm is **one-shot**, stored keyed by `(telegram_user_id, pending_kind)` with TTL **60 seconds**
- Wrong confirm verb (`/confirm_fund` when withdraw pending) → reject, clear pending
- Second `/fund` while pending → replace pending or reject (prefer **replace + new TTL** and say so)
- `/confirm_*` with no pending → “Nothing to confirm”
- LLM free-text (“fund me 1000”) **must not** mutate balance; only slash commands above

### Optional aliases (same semantics)

- `/deposit <amount>` → same flow as `/fund` (confirm still `/confirm_fund`)
- Inline buttons (Telegram `callback_query`) may mirror `/confirm_*` / `/cancel` but must hit the **same** auth + writer path

---

## 4. Authorization (hard prerequisite)

### Who may issue fund/withdraw

| Role | Allowed? |
|------|----------|
| Telegram `user_id` listed in `TELEGRAM_ALLOWED_USER_IDS` (comma-separated) | **Yes** |
| Anyone else, including other chats | **No** — silent ignore or fixed “unauthorized” (prefer fixed reply to allowed chat only) |
| HTTP `/api/trading/chat/turn` | **No** for balance mutation |
| Scheduler / strategies / eval | **No** for fund/withdraw (they may later debit via **order fill writer** only — see §5) |

### Env (new)

| Variable | Purpose |
|----------|---------|
| `TELEGRAM_BOT_TOKEN` | Bot API token |
| `TELEGRAM_ALLOWED_USER_IDS` | Comma-separated numeric user ids (required non-empty to enable money commands) |
| `TELEGRAM_ALLOWED_CHAT_IDS` | Optional chat allowlist (if set, message chat_id must match) |
| `PAPER_WALLET_ID` | Default wallet id (e.g. `default`) until multi-wallet exists |

### Required code shape (to build — does not exist today)

```text
telegram update
  → parseCommand(text)
  → assertTelegramCaller(update)   // HARD GATE
       - extract from.id (user_id), chat.id
       - require user_id ∈ TELEGRAM_ALLOWED_USER_IDS
       - if TELEGRAM_ALLOWED_CHAT_IDS set, require chat_id ∈ set
       - else reject; do not call writer
  → if /fund|/withdraw → stagePending(...)
  → if /confirm_* → PaperWalletWriter.applyFund|applyWithdraw(...)
```

**Ship rule:** If `TELEGRAM_ALLOWED_USER_IDS` is empty/unset, **disable** `/fund` and `/withdraw` entirely (bot may still answer `/balance` as “wallet disabled” or refuse money commands).

---

## 5. Where the balance lives (SSOT + single writer)

### What exists today (not sufficient)

| Store | Role today | Cash? |
|-------|------------|-------|
| `paper_orders` | Schema only; **no readers/writers in code** | No — notional on orders only |
| `paper_positions` | Schema only; ticker PK, qty, avg_cost | No — positions, not cash |
| `trading_session_projection` / `trading_conversation_history` | Session + chat text via `database.js` | No |

There is **no** `wallets` table and **no** cash column anywhere.  
`TradingToolExecutor.execute` throws `TRADING_TOOL_NOT_IMPLEMENTED` for all tools including named `paper_submit_order` / `get_portfolio`.

### Proposed source of truth

**New table: `paper_wallets`** (cash SSOT)

| Column | Type | Notes |
|--------|------|-------|
| `wallet_id` | TEXT PK | e.g. `default` |
| `cash_balance` | REAL NOT NULL | Paper USD; never negative |
| `updated_at` | TEXT | ISO / sqlite datetime |
| `updated_by` | TEXT | e.g. `telegram:12345` or `system:order_fill` |

**Do not** store cash on `paper_positions` or invent balance by summing orders without a wallet row.

### Single writer module

**One module only** mutates `paper_wallets.cash_balance`, e.g.:

`middleware-platform/services/paper-wallet-writer.js`

| Method | Allowed callers |
|--------|-----------------|
| `applyFund({ amount, actor, reason, idempotencyKey })` | Telegram confirm handler only (v1) |
| `applyWithdraw({ amount, actor, reason, idempotencyKey })` | Telegram confirm handler only (v1) |
| `applyTradeCashDelta({ amount, actor, orderId, side, ... })` | **Future** paper order fill path only (buy debits / sell credits) — not Telegram |

**Forbidden (v1 and after):**

- Scheduler, PEAD/FDA strategies, eval harness, LangGraph nodes, LLM tools calling SQL/`UPDATE paper_wallets` directly
- `executeTurn` writing cash
- Dual writes to Alpaca buying power **and** local wallet for the same fund event

**Concurrency:** All mutations in a single SQLite transaction:  
`BEGIN` → read balance → check limits/funds → insert ledger row → update wallet → `COMMIT`.  
Use idempotency key unique index so double `/confirm_fund` cannot double-credit.

### Future order fills

When `paper_submit_order` is implemented, it must call `PaperWalletWriter.applyTradeCashDelta` inside the **same** transaction as inserting/updating `paper_orders` / `paper_positions`. Strategies/scheduler only enqueue signals; they never touch cash.

---

## 6. Audit trail

### New table: `paper_wallet_ledger` (append-only)

Every successful fund/withdraw (and later trade cash delta) inserts **one** row. No updates/deletes in app code.

| Column | Fund/withdraw content |
|--------|------------------------|
| `id` | INTEGER PK |
| `wallet_id` | e.g. `default` |
| `event_type` | `fund` \| `withdraw` \| (later `trade_debit` / `trade_credit` / `adjust`) |
| `amount` | Absolute amount (> 0); sign implied by `event_type` |
| `balance_before` | REAL |
| `balance_after` | REAL |
| `actor_type` | `telegram` |
| `actor_id` | Telegram `user_id` string |
| `chat_id` | Telegram `chat_id` |
| `command` | e.g. `/fund` + confirm |
| `idempotency_key` | UNIQUE — e.g. `tg:{user_id}:{pending_id}` |
| `request_message_id` | Telegram message id of confirm (if available) |
| `created_at` | Timestamp (server) |
| `meta_json` | Optional JSON (pending amount, limits snapshot) |

### Also write (non-authoritative)

| Where | What |
|-------|------|
| App logger (`services/logger.js` / secure-logger) | Structured log: event_type, actor_id, amount, balance_after, ledger id — **no secrets** |
| Telegram reply | Human summary + ledger `id` |

Conversation history is **not** the audit SSOT (easy to spoof/omit).

### Pending confirm store

Ephemeral table or memory with TTL is fine for pending; **must not** credit until confirm. Prefer SQLite `paper_wallet_pending` so multi-instance bots don’t lose pending, with `expires_at` and unique `(wallet_id, actor_id)`.

---

## 7. Limits

Configurable via env (defaults below). Checked at **stage** and again at **confirm** (balance/limits can change).

| Limit | Default | Env |
|-------|---------|-----|
| Max deposit per command | **$50,000** | `PAPER_FUND_MAX_PER_CMD` |
| Max withdraw per command | **$50,000** | `PAPER_WITHDRAW_MAX_PER_CMD` |
| Max deposit per UTC day (sum of successful `fund`) | **$100,000** | `PAPER_FUND_MAX_PER_DAY` |
| Max withdraw per UTC day | **$100,000** | `PAPER_WITHDRAW_MAX_PER_DAY` |
| Max successful money commands per user per hour | **20** | `PAPER_WALLET_MAX_CMDS_PER_HOUR` |
| Min balance after withdraw | **0** | (hard) |
| Confirm TTL | **60s** | `PAPER_WALLET_CONFIRM_TTL_SEC` |

**Velocity:** Count from `paper_wallet_ledger` by `actor_id` + `created_at` window — not from chat logs.

On limit hit: reply with reason; **no** ledger row; clear or keep pending per product choice (prefer clear).

---

## 8. Explicit non-goals

1. **No live broker connection** for fund/withdraw. Do not call Alpaca (or any broker) deposit/withdraw APIs. Local `paper_wallets` is the only cash moved by these commands.
2. **No real-money rails** (Stripe, bank ACH, crypto rails). “Fund” means credit **paper** cash in SQLite.
3. **No LLM-initiated balance changes** without the slash + confirm protocol.
4. **No multi-user wallets in v1** — single `PAPER_WALLET_ID=default` unless explicitly extended later.
5. **Out of scope:** PEAD/FDA signal generation, order placement UX, blanko Flow UI.

### Paper vs live conflation flags (today)

| Item | Risk |
|------|------|
| `TRADING_MODE` defaults to `paper`; `live` documented in ENV | Label only — **no executor** places live orders today. Still: fund/withdraw code must **ignore** `TRADING_MODE` for broker calls and refuse if someone later wires live by accident (`if (mode === 'live') throw` on these commands). |
| `APCA_*` in `.env.example` (“Alpaca paper — not wired yet”) | Future **broker paper** buying power ≠ local Telegram credits. Do **not** treat Alpaca account cash as SSOT for `/fund`. If an Alpaca adapter is added later, document sync explicitly; default remains local ledger. |
| Table prefix `paper_*` | Good. Keep wallet/ledger named `paper_wallets` / `paper_wallet_ledger` — never `wallets` shared with a live concept. |
| Healthcare/Stripe leftovers | Removed per cleanup docs; none found on this money path. |

---

## 9. Acceptance criteria (when implementing later)

- [ ] `assertTelegramCaller` rejects non-allowlisted `user_id` before any pending or ledger write
- [ ] Empty `TELEGRAM_ALLOWED_USER_IDS` → money commands disabled
- [ ] `/fund 1000` alone does **not** change `cash_balance`
- [ ] `/confirm_fund` within TTL credits once; replay with same idempotency key is no-op
- [ ] Only `PaperWalletWriter` updates `paper_wallets.cash_balance`
- [ ] Every success inserts `paper_wallet_ledger` with actor, timestamp, amount, balance_before/after
- [ ] Per-command and daily limits enforced
- [ ] No Alpaca/Stripe/broker calls on this path
- [ ] Tests: unauthorized user, missing confirm, double confirm, overdraft withdraw, daily cap

---

## 10. Suggested implementation order (later)

1. Migration: `paper_wallets` + `paper_wallet_ledger` (+ optional pending)
2. `PaperWalletWriter` + unit tests (no Telegram yet)
3. Telegram bot skeleton + **`assertTelegramCaller`**
4. `/balance`, then `/fund`/`/withdraw` + confirm
5. Wire `/balance` into future `get_portfolio` **read** path (read-only)

---

## 11. Doc history

| Date | Note |
|------|------|
| 2026-08-07 | Initial design grounded in trading-agent shell (no Telegram, no cash writers) |
