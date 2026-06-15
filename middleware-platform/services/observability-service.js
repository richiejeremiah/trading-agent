const Metrics = require('./metrics');
const db = require('../database');

class ObservabilityService {
  static recordFinancialEvent(event) {
    Metrics.increment(`financial_event_${event.event_type}_${event.status || 'unknown'}`);
    return db.insertFinancialEvent(event);
  }

  static audit(action, details) {
    return db.writeAuditLog({
      actor_type: details.actor_type || null,
      actor_id: details.actor_id || null,
      action,
      target_type: details.target_type || null,
      target_id: details.target_id || null,
      ip: details.ip || null,
      user_agent: details.user_agent || null,
      details: details.details || {}
    });
  }

  static trackClaimLifecycle(claimId, status) {
    Metrics.increment(`claim_status_${status}`);
    db.insertFinancialEvent({
      event_type: 'claim',
      actor_type: 'patient',
      actor_id: null,
      amount: null,
      currency: null,
      rail_type: null,
      status,
      cause: 'claim_status_change',
      metadata: { claim_id: claimId }
    });
  }
}

module.exports = ObservabilityService;

