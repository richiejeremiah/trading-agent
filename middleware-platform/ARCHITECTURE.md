# Middleware platform — trading agent

## Entry points

| Path | Role |
|------|------|
| [`server.js`](server.js) | Express app: health, trading chat API, static UI |
| [`database.js`](database.js) | SQLite facade for trading sessions and paper orders |
| [`services/trading-rails/`](services/trading-rails/) | Lane/step orchestration + LangGraph wrapper |

## Layering

```text
HTTP routes/trading-chat.js
  → services/trading-chat-service.js
    → services/trading-turn-resolver.js
      → services/trading-rails/orchestrator.js
        → trading-rails/main-graph.js (optional LangGraph)
        → trading-rails/execute-turn.js
```

## Vector / LLM (shared infra)

- [`services/pinecone-rest.js`](services/pinecone-rest.js)
- [`services/vector-retriever.js`](services/vector-retriever.js)
- [`services/embedding-provider.js`](services/embedding-provider.js)
- [`services/llm-router.js`](services/llm-router.js)

## Healthcare archive

Full healthcare middleware lives in [richiejeremiah/somo-platform](https://github.com/richiejeremiah/somo-platform). Do not restore Kelly/Retell imports here.
