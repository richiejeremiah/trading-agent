# Layer status tracker

| Layer | Component | Status | Notes |
|-------|-----------|--------|-------|
| L1 | Pinecone `biotech-news` namespace | Not started | Reuse `doctorlittle` index |
| L1 | News scraper (RSS, SEC, FDA) | Not started | |
| L2 | `biotech-rag-service` | Not started | |
| L2 | Signal LLM judge (JSON) | Not started | |
| L2 | Strategy PEAD / FDA → PROPOSED_ACTION | Done (paper) | Arithmetic SUE; FDA stub map; `runStrategies` |
| L3 | `trading-rails/` lanes | Skeleton | Propose-only allowlists; `propose-only-guard` |
| L3 | LangGraph checkpointer | Wired | Postgres or MemorySaver |
| L4 | PaperBroker + execution service | Done (paper) | Proposal → policy/risk → submit; reconcile |
| L4 | Alpaca live adapter | Stub | `AlpacaBroker` throws `NOT_WIRED` |
| L4 | Risk / policy engines | Done | Kill switch, penny/OTC, size caps |
| L5 | `POST /api/trading/chat/turn` | Stub 501 | |
| L5 | Portfolio/history APIs | Not started | |
| L6 | `trading/trading-chat.html` | Shell | Disclaimer + disabled chat |
| L7 | Cloud Scheduler | Not started | |
| L7 | Telegram paper wallet | Done (paper) | Fund/withdraw + confirm; allowlist auth |
| L7 | Eval harness (paper pipeline) | Done | `__tests__/eval-pipeline.test.js` |
| L7 | LangSmith | Configured | `utils/langsmith-config.js` |

**Hard rule:** LLM tools never call broker submit — only `PROPOSED_ACTION`; execution service owns `getBroker().submitOrder` after ALLOW.

**Build order (after cleanup):** L1 minimal → L4 parallel → L3 → L2 → L5/L6 → L7
