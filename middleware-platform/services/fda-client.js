'use strict';

/**
 * fda-client — public FDA / ClinicalTrials.gov endpoints, no API key required.
 *
 * Every exported function returns { ok: true, data } | { ok: false, error: FdaClientError }.
 * They never throw. Branch on result.ok; inspect error.code for:
 *   NOT_FOUND | RATE_LIMITED | FETCH_ERROR | PARSE_ERROR
 *
 * openFDA enforces ~40 requests/minute for unauthenticated callers.
 * _fdaFetch() retries once after a 429, honouring Retry-After when present.
 */

const OPENFDA_BASE    = 'https://api.fda.gov';
const FDA_RSS_URL     = 'https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/press-announcements/rss.xml';
const CT_BASE         = 'https://clinicaltrials.gov/api/v2';
const TIMEOUT_MS      = 10_000;
const RETRY_AFTER_MS  = 62_000; // fallback when Retry-After header is absent

// -- Typed error -------------------------------------------------------------

class FdaClientError extends Error {
  constructor(code, message, httpStatus = null) {
    super(message);
    this.name = 'FdaClientError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

const err = (code, msg, status = null) => ({ ok: false, error: new FdaClientError(code, msg, status) });

// -- Internal helpers --------------------------------------------------------

function _abortFetch(url, headers = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  return fetch(url, { signal: ctrl.signal, headers })
    .then(res => { clearTimeout(t); return res; })
    .catch(e => { clearTimeout(t); throw e; });
}

/**
 * Fetch JSON from openFDA with one automatic retry on 429.
 * Returns { ok, data } | { ok, error }.
 */
async function _fdaFetch(url) {
  let res;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      res = await _abortFetch(url, {
        'User-Agent': 'Mozilla/5.0 (compatible; fda-client/1.0)',
        Accept: 'application/json',
      });
    } catch (e) {
      return err('FETCH_ERROR', e && e.name === 'AbortError'
        ? `Timed out after ${TIMEOUT_MS}ms`
        : `Network error: ${e && e.message}`);
    }

    if (res.status === 429) {
      if (attempt === 0) {
        const retryAfter = res.headers.get('Retry-After');
        const waitMs = retryAfter ? Number(retryAfter) * 1000 : RETRY_AFTER_MS;
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      return err('RATE_LIMITED', 'openFDA rate limit exceeded (HTTP 429)', 429);
    }

    if (res.status === 404) return err('NOT_FOUND', `openFDA returned 404 for: ${url}`, 404);
    if (!res.ok) return err('FETCH_ERROR', `HTTP ${res.status} from openFDA`, res.status);

    let body;
    try { body = await res.json(); }
    catch (e) { return err('PARSE_ERROR', `JSON parse failed: ${e && e.message}`); }

    return { ok: true, data: body };
  }
  /* unreachable, but satisfies linters */
  return err('FETCH_ERROR', 'Unexpected retry loop exit');
}

/** Generic JSON fetch for non-openFDA endpoints (no retry logic needed). */
async function _jsonFetch(url) {
  let res;
  try {
    res = await _abortFetch(url, {
      'User-Agent': 'Mozilla/5.0 (compatible; fda-client/1.0)',
      Accept: 'application/json',
    });
  } catch (e) {
    return err('FETCH_ERROR', e && e.name === 'AbortError'
      ? `Timed out after ${TIMEOUT_MS}ms`
      : `Network error: ${e && e.message}`);
  }
  if (res.status === 429) return err('RATE_LIMITED', 'Rate limit (HTTP 429)', 429);
  if (res.status === 404) return err('NOT_FOUND', `Resource not found: ${url}`, 404);
  if (!res.ok) {
    let snippet = '';
    try {
      const text = await res.text();
      snippet = text.slice(0, 200);
    } catch (_) { /* ignore body-read errors */ }
    return err('FETCH_ERROR',
      `HTTP ${res.status} from ${url}${snippet ? ` — ${snippet}` : ''}`,
      res.status);
  }
  try { return { ok: true, data: await res.json() }; }
  catch (e) { return err('PARSE_ERROR', `JSON parse failed: ${e && e.message}`); }
}

/** Minimal RSS → item array parser (no external dependency). */
function _parseRssItems(xml) {
  const items = [];
  const itemRx = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRx.exec(xml)) !== null) {
    const block = m[1];
    const tag = (name) => {
      const t = new RegExp(`<${name}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${name}>|<${name}[^>]*>([^<]*)<\\/${name}>`);
      const r = t.exec(block);
      return r ? (r[1] ?? r[2] ?? '').trim() : null;
    };
    items.push({
      title:        tag('title'),
      link:         tag('link'),
      published_at: tag('pubDate') ? new Date(tag('pubDate')).toISOString() : null,
      description:  tag('description'),
      source:       'fda.gov/press-announcements',
      raw_company:  tag('title'), // FDA press titles carry the company/product name
    });
  }
  return items;
}

// -- Public API --------------------------------------------------------------

/**
 * Drug enforcement (recall) actions from openFDA.
 * @param {number} [sinceDays=30]  Look-back window in calendar days.
 * @returns {{ ok: true, data: RecallItem[] } | { ok: false, error: FdaClientError }}
 *
 * RecallItem: { id, source, published_at, raw_company, product_description,
 *               reason, classification, status, recall_number }
 */
async function getRecentRecalls(sinceDays = 30) {
  const days = Math.max(1, Math.floor(Number(sinceDays) || 30));
  const since = new Date(Date.now() - days * 86_400_000);
  // openFDA date format: YYYYMMDD
  const sinceStr = since.toISOString().slice(0, 10).replace(/-/g, '');
  const url = `${OPENFDA_BASE}/drug/enforcement.json?search=report_date:[${sinceStr}+TO+99991231]&limit=100&sort=report_date:desc`;

  const result = await _fdaFetch(url);
  if (!result.ok) return result;

  try {
    const results = result.data.results;
    if (!Array.isArray(results) || results.length === 0) {
      return { ok: true, data: [] };
    }
    const items = results.map(r => ({
      id:                  r.recall_number || null,
      source:              'api.fda.gov/drug/enforcement',
      published_at:        r.report_date
                             ? new Date(
                                 r.report_date.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3')
                               ).toISOString()
                             : null,
      raw_company:         r.recalling_firm || null,
      product_description: r.product_description || null,
      reason:              r.reason_for_recall || null,
      classification:      r.classification || null,   // Class I / II / III
      status:              r.status || null,
      recall_number:       r.recall_number || null,
    }));
    return { ok: true, data: items };
  } catch (e) {
    return err('PARSE_ERROR', `Could not parse recall results: ${e && e.message}`);
  }
}

/**
 * FDA press announcements from the official RSS feed.
 * @returns {{ ok: true, data: PressItem[] } | { ok: false, error: FdaClientError }}
 *
 * PressItem: { title, link, published_at, description, source, raw_company }
 */
async function getPressAnnouncements() {
  let res;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    res = await fetch(FDA_RSS_URL, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; fda-client/1.0)',
        Accept: 'application/rss+xml, application/xml, text/xml',
      },
    });
    clearTimeout(t);
  } catch (e) {
    return err('FETCH_ERROR', e && e.name === 'AbortError'
      ? `Timed out after ${TIMEOUT_MS}ms`
      : `Network error: ${e && e.message}`);
  }

  if (res.status === 429) return err('RATE_LIMITED', 'FDA RSS rate limit (HTTP 429)', 429);
  if (!res.ok) return err('FETCH_ERROR', `FDA RSS HTTP ${res.status}`, res.status);

  let xml;
  try { xml = await res.text(); }
  catch (e) { return err('PARSE_ERROR', `Could not read RSS body: ${e && e.message}`); }

  try {
    const items = _parseRssItems(xml);
    return { ok: true, data: items };
  } catch (e) {
    return err('PARSE_ERROR', `RSS parse failed: ${e && e.message}`);
  }
}

/**
 * Clinical trial status changes (Terminated / Withdrawn / Suspended) from ClinicalTrials.gov v2.
 * @param {string} sponsorName  Lead sponsor name to filter on.
 * @param {number} [sinceDays=90]  Look-back window in calendar days.
 * @returns {{ ok: true, data: TrialItem[] } | { ok: false, error: FdaClientError }}
 *
 * TrialItem: { nct_id, source, published_at, raw_company, title, status, phase, conditions }
 */
async function getTrialStatusChanges(sponsorName, sinceDays = 90) {
  const sponsor = String(sponsorName || '').trim();
  if (!sponsor) return err('NOT_FOUND', 'sponsorName is required');

  const days = Math.max(1, Math.floor(Number(sinceDays) || 90));
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

  const params = new URLSearchParams({
    'query.spons': sponsor,
    'filter.advanced': `AREA[LastUpdatePostDate]RANGE[${since},MAX]`,
    'fields': 'NCTId,BriefTitle,OverallStatus,Phase,Condition,LeadSponsorName,LastUpdatePostDate',
    'pageSize': '100',
    'format': 'json',
  });
  // The API wants a comma-separated list here, not a repeated parameter — the
  // opposite of what it wants for filter.advanced. Tested, not assumed.
  params.append('filter.overallStatus', 'TERMINATED,WITHDRAWN,SUSPENDED');
  const url = `${CT_BASE}/studies?${params.toString()}`;

  const result = await _jsonFetch(url);
  if (!result.ok) return result;

  try {
    const studies = result.data.studies;
    if (!Array.isArray(studies) || studies.length === 0) {
      return { ok: true, data: [] };
    }
    const items = studies.map(s => {
      const proto  = s.protocolSection || {};
      const id     = proto.identificationModule || {};
      const status = proto.statusModule || {};
      const design = proto.designModule || {};
      const sponsor_mod = proto.sponsorCollaboratorsModule || {};
      return {
        nct_id:       id.nctId || null,
        source:       'clinicaltrials.gov/api/v2',
        published_at: status.lastUpdatePostDateStruct?.date
                        ? new Date(status.lastUpdatePostDateStruct.date).toISOString()
                        : null,
        raw_company:  sponsor_mod.leadSponsor?.name || sponsor,
        title:        id.briefTitle || null,
        status:       status.overallStatus || null,
        phase:        design.phases?.[0] || null,
        conditions:   proto.conditionsModule?.conditions || [],
      };
    });
    return { ok: true, data: items };
  } catch (e) {
    return err('PARSE_ERROR', `Could not parse trial results: ${e && e.message}`);
  }
}

module.exports = { FdaClientError, getRecentRecalls, getPressAnnouncements, getTrialStatusChanges };
