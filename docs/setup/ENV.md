# Environment — Somo Trading Agent

## Required for agent (later)

| Variable | Purpose |
|----------|---------|
| `OPENAI_API_KEY` | Embeddings + LLM |
| `TRADING_MODE` | `paper` (default) or `live` |
| `TRADING_AGENT_ENABLED` | `1` to enable chat turn handler (stub reply) |

## Optional

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Primary LLM via `llm-router` |
| `GROQ_API_KEY` | Fallback LLM |
| `PINECONE_API_KEY` | Vector search |
| `PINECONE_INDEX_HOST` | Pinecone data plane host |
| `PINECONE_NAMESPACE` | Namespace (e.g. `biotech-news`) |
| `VECTOR_SEARCH_BACKEND` | `pinecone` |
| `EMBEDDING_PROVIDER` | `openai` |
| `LANGSMITH_API_KEY` | Tracing |
| `LANGSMITH_PROJECT` | Trace project name |
| `POSTGRES_URL` | LangGraph Postgres checkpointer |
| `TRADING_DB_PATH` | SQLite path (default `data/trading.sqlite`) |
| `PORT` | HTTP port (default `4000`) |

## Paper trading (not wired yet)

```
# APCA_API_KEY=
# APCA_SECRET_KEY=
# APCA_BASE_URL=https://paper-api.alpaca.markets
```
