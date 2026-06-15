# Trading pivot cleanup changelog

**Date:** 2026-06-13  
**Archive:** `archive/healthcare-v3.1` @ tag `healthcare-v3.1.0`

## Removed from `main`

### Top-level packages (deleted)

- `Knowledge/` — ICD/CPT/HCPCS, derm eval, skincare rules
- `medical-rag-api/` — Flask clinical RAG
- `case-report-service/` — clinical reports
- `livekit-agents/` — transcription workers
- `patient-app/` — Expo patient portal
- `contracts/HealthcareEscrow.sol`

### middleware-platform

- **Routes:** All voice, patient, RCM, FHIR, commerce, admin, clinical routes (~98 files). Kept: trading-chat stub, internal ops.
- **Services:** ~280 healthcare services. Kept: vector, embedding, LLM, logging, observability, trading-rails skeleton.
- **Webhooks:** `retell-websocket.js` and all voice webhooks
- **Kelly clinical:** `kelly-agent-service.js`, triage, voice, RCM, skincare, etc.
- **Migrations:** 54 healthcare migrations replaced by `001_trading_platform_init.js`
- **database.js:** Monolith replaced with thin trading facade

### unified-dashboard

- Deleted: `patients/`, `business/`, `admin/`, `insurer/`, `somo-landing/`, signup/login flows
- Added: `trading/trading-chat.html` (shell from checkout-chat pattern)

### docs

- Healthcare docs removed from `main` (preserved on archive branch)
- New: `docs/trading/*`

### todos

- All healthcare todo lists removed

## Kept / repurposed

| Was | Now |
|-----|-----|
| `kelly-rails/` | `trading-rails/` (empty lanes) |
| `patient-checkout-chat` pattern | `trading-chat` stub |
| `pinecone-rest`, `vector-retriever`, `embedding-provider` | Unchanged |
| `llm-router.js` | Unchanged |
| Cloud Run + Firebase deploy scripts | Trimmed |

## Restore healthcare

```bash
git checkout archive/healthcare-v3.1
# or
git checkout healthcare-v3.1.0
```

See `docs/archive/HEALTHCARE_PLATFORM_SNAPSHOT.md` on the archive branch.
