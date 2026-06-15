# Somo — Agentic Biotech Trading Agent

**Version:** 4.0.0 (trading pivot)  
**Status:** Platform shell — paper trading agent not implemented yet.

> **Healthcare front-desk platform:** [richiejeremiah/somo-platform](https://github.com/richiejeremiah/somo-platform) (Kelly voice agent, provider portal, RCM).

## Overview

Somo is an agentic trading tool focused on **healthcare and biotech equities**. Development starts with **paper trading** (Alpaca), then moves to live execution after validation.

This repository was split from the Somo healthcare front-desk platform. It contains the **agent rails**, **Pinecone vector search**, **LLM routing**, and **chat UI shell** for biotech trading research and paper execution.

## Quick start

```bash
cd middleware-platform
npm install
cp .env.example .env   # add OPENAI_API_KEY, optional PINECONE_*
npm start              # http://localhost:4000
```

- Health: `GET /health`
- Trading chat UI: `http://localhost:4000/trading/trading-chat.html`
- API stub: `POST /api/trading/chat/turn` → 501 until agent is built

## Architecture

See [docs/trading/ARCHITECTURE.md](docs/trading/ARCHITECTURE.md) and [docs/trading/LAYER_STATUS.md](docs/trading/LAYER_STATUS.md).

## Project structure

```
trading-agent/
├── middleware-platform/   # Express API, trading-rails, vector/LLM infra
├── unified-dashboard/     # trading-chat UI shell
└── docs/trading/          # Trading architecture docs
```

## Environment

See [docs/setup/ENV.md](docs/setup/ENV.md) and `middleware-platform/.env.example`.

## Contributing

Run before PR:

```bash
npm run verify:trading-shell --prefix middleware-platform
npm test --prefix middleware-platform
```
