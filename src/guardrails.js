// Best-effort, regex-based PII detection — not a comprehensive moderation
// system. Flags emails, phone numbers, SSN-shaped numbers, and long digit
// runs (credit-card-shaped). False positives are possible on legitimate
// long numeric identifiers; that's an accepted tradeoff of a fast, local,
// no-external-dependency check.
const PII_PATTERNS = [
  { name: 'email', regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/ },
  { name: 'phone', regex: /(\+?\d{1,2}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/ },
  { name: 'ssn', regex: /\b\d{3}-\d{2}-\d{4}\b/ },
  { name: 'long_digit_run', regex: /\b(?:\d[ -]?){13,19}\b/ },
];

// Minimal seed list of clearly harmful query patterns. This is a baseline,
// not exhaustive content moderation — extend DEFAULT_BLOCKED_TERMS for your
// deployment's needs, or replace checkGuardrails' contentFilter branch with
// an LLM-based classifier if you need semantic (not just keyword) coverage.
const DEFAULT_BLOCKED_TERMS = [
  'how to make a bomb',
  'how to build a bomb',
  'how to make explosives',
  'how to synthesize a bioweapon',
];

function checkGuardrails(query, guardrailsConfig) {
  if (!guardrailsConfig) return;
  const cfg = guardrailsConfig;
  const text = String(query || '');

  if (typeof cfg.maxQueryLength === 'number' && text.length > cfg.maxQueryLength) {
    throw new Error(`GuardrailViolation: query exceeds maxQueryLength (${text.length} > ${cfg.maxQueryLength})`);
  }

  if (cfg.blockPii) {
    // The email pattern can only ever match text containing '@'; skip it
    // entirely on text with no '@' to avoid catastrophic backtracking on
    // long inputs with no match (see ReDoS fix — cheap O(n) pre-check).
    if (text.includes('@') && PII_PATTERNS[0].regex.test(text)) {
      throw new Error(`GuardrailViolation: possible PII detected (${PII_PATTERNS[0].name})`);
    }
    for (const { name, regex } of PII_PATTERNS.slice(1)) {
      if (regex.test(text)) {
        throw new Error(`GuardrailViolation: possible PII detected (${name})`);
      }
    }
  }

  if (cfg.contentFilter) {
    const lower = text.toLowerCase();
    const terms = [...DEFAULT_BLOCKED_TERMS, ...(cfg.blockedTerms || [])];
    for (const term of terms) {
      if (lower.includes(term.toLowerCase())) {
        throw new Error('GuardrailViolation: query blocked by content filter');
      }
    }
  }
}

module.exports = { checkGuardrails, PII_PATTERNS, DEFAULT_BLOCKED_TERMS };
