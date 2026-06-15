# Layer status tracker

| Layer | Component | Status | Notes |
|-------|-----------|--------|-------|
| L1 | Pinecone `biotech-news` namespace | Not started | Reuse `doctorlittle` index |
| L1 | News scraper (RSS, SEC, FDA) | Not started | |
| L2 | `biotech-rag-service` | Not started | |
| L2 | Signal LLM judge (JSON) | Not started | |
| L3 | `trading-rails/` lanes | Skeleton | Empty research/signal/execute/review/guard |
| L3 | LangGraph checkpointer | Wired | Postgres or MemorySaver |
| L4 | Alpaca paper adapter | Not started | |
| L4 | Risk guard rules | Not started | |
| L5 | `POST /api/trading/chat/turn` | Stub 501 | |
| L5 | Portfolio/history APIs | Not started | |
| L6 | `trading/trading-chat.html` | Shell | Disclaimer + disabled chat |
| L7 | Cloud Scheduler | Not started | |
| L7 | Telegram alerts | Not started | |
| L7 | LangSmith | Configured | `utils/langsmith-config.js` |

**Build order (after cleanup):** L1 minimal → L4 parallel → L3 → L2 → L5/L6 → L7
