# Somo Trading Agent — Architecture

**Last updated:** 2026-06-13  
**Status:** Cleanup shell — agent logic not implemented yet.

## Product

Somo is an **agentic biotech trading tool**. Paper trading first; live execution gated behind validation.

Healthcare platform code lives in [richiejeremiah/somo-platform](https://github.com/richiejeremiah/somo-platform).

## Seven layers

| Layer | Name | Status post-cleanup |
|-------|------|---------------------|
| L1 | Data ingest (Pinecone `biotech-news`, scrapers) | Not built |
| L2 | Intelligence (RAG + signal judge) | Not built |
| L3 | Agent runtime (`trading-rails`, LangGraph) | Skeleton only |
| L4 | Execution & risk (Alpaca paper) | Not built |
| L5 | HTTP API (`/api/trading/*`) | Stub (501) |
| L6 | UI (`unified-dashboard/trading/`) | Chat shell + disclaimer |
| L7 | Ops (scheduler, Telegram, LangSmith) | LangSmith wired; rest TBD |

## Stack (kept from healthcare pivot)

- **Runtime:** Node.js 20+, Express (`middleware-platform/server.js`)
- **Agent:** `services/trading-rails/` (lane/step pattern from Kelly Rails)
- **Vectors:** `pinecone-rest.js`, `vector-retriever.js`, `embedding-provider.js`
- **LLM:** `llm-router.js` (Claude / Groq)
- **DB:** SQLite dev (`data/trading.sqlite`), optional Postgres for LangGraph checkpoints
- **Deploy:** Cloud Run API, Firebase Hosting UI (existing infra)

## Request flow (target)

```
trading-chat.html
  → POST /api/trading/chat/turn
  → trading-turn-resolver
  → trading-rails (lane routing)
  → trading-tool-executor (allowlisted tools)
  → Pinecone / Alpaca / LLM
```

## Isolation

Do not import Kelly, Retell, Stedi, FHIR, or clinical services. Those live in [somo-platform](https://github.com/richiejeremiah/somo-platform).

## Related

- [LAYER_STATUS.md](./LAYER_STATUS.md)
- [CLEANUP_CHANGELOG.md](./CLEANUP_CHANGELOG.md)
- [../middleware-platform/ARCHITECTURE.md](../../middleware-platform/ARCHITECTURE.md)
