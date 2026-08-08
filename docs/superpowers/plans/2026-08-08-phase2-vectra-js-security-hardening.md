# Phase 2 — vectra-js Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the security gaps identified in Phase 2 of the design spec for vectra-js: enforce the guardrails schema at runtime (currently decorative), add a max-file-size ingestion limit, wire dependency vulnerability scanning into CI, correct the drifted telemetry documentation, and publish a SECURITY.md.

**Architecture:** Adds one new module (`src/guardrails.js`) with pure, independently-testable check functions, called once at the top of `queryRAG`. Adds one new CI workflow file. All other changes are small, targeted edits to existing files — no restructuring.

**Tech Stack:** Node.js, Jest (already set up from Phase 1), GitHub Actions.

## Global Constraints

- SQL-identifier sanitization is explicitly OUT of scope for this plan — it was already hardened with adversarial test coverage in Phase 1 (`src/backends/postgres_store.js`'s and `prisma_store.js`'s `isSafeIdentifier`/`quoteIdentifier`/`quoteTableName`, tested in `test/backends/sqlIdentifier.test.js`). Do not re-touch it.
- No direct-to-master commits, no force-push, no skipped hooks.
- Every task ends with `npx jest` passing before moving to the next task.
- Guardrail violations throw a plain `Error` with a message prefixed `GuardrailViolation:` — callers catch it like any other error from `queryRAG`; this plan does not add a special error class or HTTP-status mapping.
- PII/content-filter detection is regex/keyword-based, not ML-based — this is a real, working baseline (a query with a detectable email/phone/SSN/long-digit-run is rejected when `blockPii` is on; a query containing a small seed list of clearly harmful phrases is rejected when `contentFilter` is on), not a comprehensive moderation system. Document this limitation in code comments, don't oversell it.

---

### Task 1: Guardrails module — maxQueryLength and blockPii

**Files:**
- Create: `src/guardrails.js`
- Create: `test/guardrails.test.js`

**Interfaces:**
- Produces: `checkGuardrails(query, guardrailsConfig)` — throws `Error` on violation, returns `undefined` silently otherwise. `guardrailsConfig` is the parsed `GuardrailConfigSchema` shape from `src/config.js:81-87` (`{ blockPii, blockOffTopic, maxQueryLength, contentFilter, hallucinationCheck }`). This task implements `maxQueryLength` and `blockPii` only; Task 2 adds `contentFilter`. `blockOffTopic`/`hallucinationCheck` stay unenforced — they need semantic/LLM-based classification, which is Phase 3 feature work, not this security-hardening pass.

- [ ] **Step 1: Write the failing tests**

Create `test/guardrails.test.js`:

```js
const { checkGuardrails } = require('../src/guardrails');

describe('checkGuardrails - maxQueryLength', () => {
  it('allows a query at or under the limit', () => {
    expect(() => checkGuardrails('a'.repeat(2000), { maxQueryLength: 2000 })).not.toThrow();
  });

  it('rejects a query over the limit', () => {
    expect(() => checkGuardrails('a'.repeat(2001), { maxQueryLength: 2000 }))
      .toThrow('GuardrailViolation: query exceeds maxQueryLength');
  });

  it('does nothing when maxQueryLength is not set', () => {
    expect(() => checkGuardrails('a'.repeat(100000), {})).not.toThrow();
  });
});

describe('checkGuardrails - blockPii', () => {
  it('allows an ordinary query when blockPii is off', () => {
    expect(() => checkGuardrails('contact me at john@example.com', { blockPii: false })).not.toThrow();
  });

  it('rejects a query containing an email address when blockPii is on', () => {
    expect(() => checkGuardrails('contact me at john@example.com', { blockPii: true }))
      .toThrow('GuardrailViolation: possible PII detected');
  });

  it('rejects a query containing a phone number when blockPii is on', () => {
    expect(() => checkGuardrails('call me at 555-123-4567', { blockPii: true }))
      .toThrow('GuardrailViolation: possible PII detected');
  });

  it('rejects a query containing an SSN-shaped number when blockPii is on', () => {
    expect(() => checkGuardrails('my ssn is 123-45-6789', { blockPii: true }))
      .toThrow('GuardrailViolation: possible PII detected');
  });

  it('rejects a query containing a long digit run (credit-card-shaped) when blockPii is on', () => {
    expect(() => checkGuardrails('card number 4111111111111111', { blockPii: true }))
      .toThrow('GuardrailViolation: possible PII detected');
  });

  it('allows a query with no PII when blockPii is on', () => {
    expect(() => checkGuardrails('what is the refund policy?', { blockPii: true })).not.toThrow();
  });

  it('does nothing when guardrailsConfig is undefined', () => {
    expect(() => checkGuardrails('anything', undefined)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run and verify they fail**

Run: `npx jest test/guardrails.test.js`
Expected: FAIL — `Cannot find module '../src/guardrails'`.

- [ ] **Step 3: Write the implementation**

Create `src/guardrails.js`:

```js
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

function checkGuardrails(query, guardrailsConfig) {
  if (!guardrailsConfig) return;
  const cfg = guardrailsConfig;
  const text = String(query || '');

  if (cfg.maxQueryLength && text.length > cfg.maxQueryLength) {
    throw new Error(`GuardrailViolation: query exceeds maxQueryLength (${text.length} > ${cfg.maxQueryLength})`);
  }

  if (cfg.blockPii) {
    for (const { name, regex } of PII_PATTERNS) {
      if (regex.test(text)) {
        throw new Error(`GuardrailViolation: possible PII detected (${name})`);
      }
    }
  }
}

module.exports = { checkGuardrails, PII_PATTERNS };
```

- [ ] **Step 4: Run and verify they pass**

Run: `npx jest test/guardrails.test.js -v`
Expected: 10 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/guardrails.js test/guardrails.test.js
git commit -m "feat: enforce maxQueryLength and blockPii guardrails"
```

---

### Task 2: Guardrails module — contentFilter, then wire into queryRAG

**Files:**
- Modify: `src/guardrails.js`
- Modify: `test/guardrails.test.js`
- Modify: `src/core.js:1` (add require), `src/core.js:748` (call at top of `queryRAG`)
- Create: `test/core.guardrails.test.js`

**Interfaces:**
- Consumes: `checkGuardrails` from Task 1.
- Produces: `VectraClient.queryRAG` now throws synchronously (before any embedding/LLM call) when a guardrail is violated.

- [ ] **Step 1: Write the failing contentFilter tests**

Append to `test/guardrails.test.js`:

```js
describe('checkGuardrails - contentFilter', () => {
  it('allows an ordinary query when contentFilter is off', () => {
    expect(() => checkGuardrails('how do I make a sandwich', { contentFilter: false })).not.toThrow();
  });

  it('rejects a query matching a blocked term when contentFilter is on', () => {
    expect(() => checkGuardrails('how to make a bomb at home', { contentFilter: true }))
      .toThrow('GuardrailViolation: query blocked by content filter');
  });

  it('is case-insensitive', () => {
    expect(() => checkGuardrails('HOW TO MAKE A BOMB', { contentFilter: true }))
      .toThrow('GuardrailViolation: query blocked by content filter');
  });

  it('allows an unrelated query when contentFilter is on', () => {
    expect(() => checkGuardrails('what vector stores does this SDK support?', { contentFilter: true })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run and verify they fail**

Run: `npx jest test/guardrails.test.js`
Expected: the 4 new tests FAIL (contentFilter not yet implemented — `checkGuardrails` doesn't reject the bomb-making query).

- [ ] **Step 3: Add contentFilter to the guardrails module**

Edit `src/guardrails.js`, add after the `PII_PATTERNS` array:

```js
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
```

Then edit the `checkGuardrails` function, adding after the `blockPii` block (before the closing `}`):

```js
  if (cfg.contentFilter) {
    const lower = text.toLowerCase();
    for (const term of DEFAULT_BLOCKED_TERMS) {
      if (lower.includes(term)) {
        throw new Error('GuardrailViolation: query blocked by content filter');
      }
    }
  }
```

Update the `module.exports` line to also export `DEFAULT_BLOCKED_TERMS`:

```js
module.exports = { checkGuardrails, PII_PATTERNS, DEFAULT_BLOCKED_TERMS };
```

- [ ] **Step 4: Run and verify all guardrails.test.js tests pass**

Run: `npx jest test/guardrails.test.js -v`
Expected: 14 tests pass.

- [ ] **Step 5: Write the failing integration test for queryRAG**

Create `test/core.guardrails.test.js`:

```js
const { VectraClient, ProviderType } = require('../src/core');

function makeConfig(guardrails) {
  return {
    embedding: { provider: ProviderType.OPENAI, apiKey: 'test-key' },
    llm: { provider: ProviderType.OPENAI, apiKey: 'test-key', modelName: 'gpt-4o-mini' },
    database: { type: 'chroma', clientInstance: { getOrCreateCollection: jest.fn() } },
    guardrails,
  };
}

describe('VectraClient.queryRAG guardrail enforcement', () => {
  it('rejects an over-length query before any embedding call', async () => {
    const client = new VectraClient(makeConfig({ maxQueryLength: 10 }));
    client.embedder.embedQuery = jest.fn();
    await expect(client.queryRAG('this query is way too long for the limit'))
      .rejects.toThrow('GuardrailViolation: query exceeds maxQueryLength');
    expect(client.embedder.embedQuery).not.toHaveBeenCalled();
  });

  it('rejects a query with PII before any embedding call when blockPii is on', async () => {
    const client = new VectraClient(makeConfig({ blockPii: true }));
    client.embedder.embedQuery = jest.fn();
    await expect(client.queryRAG('email me at test@example.com'))
      .rejects.toThrow('GuardrailViolation: possible PII detected');
    expect(client.embedder.embedQuery).not.toHaveBeenCalled();
  });

  it('does not interfere with a normal query when guardrails are unset', async () => {
    const client = new VectraClient(makeConfig(undefined));
    client.embedder.embedQuery = jest.fn().mockResolvedValue([0.1, 0.2]);
    client.vectorStore.similaritySearch = jest.fn().mockResolvedValue([]);
    client.llm.generate = jest.fn().mockResolvedValue('an answer');
    await expect(client.queryRAG('what is this SDK?')).resolves.toBeDefined();
  });
});
```

- [ ] **Step 6: Run and verify the first two pass, the third may fail for unrelated reasons**

Run: `npx jest test/core.guardrails.test.js -v`
Expected: the first two tests FAIL (`checkGuardrails` not yet called from `queryRAG`, so no throw happens and the mocked `embedQuery` gets called). The third test's outcome doesn't matter yet — it's here to confirm the wiring doesn't break the normal path once added in the next step; if it fails for a different reason at this point, that's expected and will be resolved when guardrails are wired in.

- [ ] **Step 7: Wire checkGuardrails into queryRAG**

Edit `src/core.js` near the top of the file (find the other `require(...)` lines, typically within the first ~20 lines), add:

```js
const { checkGuardrails } = require('./guardrails');
```

Edit `src/core.js:748`, change:

```js
  async queryRAG(query, filter = null, stream = false, sessionId = null) {
    const traceId = uuidv4();
```

to:

```js
  async queryRAG(query, filter = null, stream = false, sessionId = null) {
    checkGuardrails(query, this.config.guardrails);
    const traceId = uuidv4();
```

- [ ] **Step 8: Run and verify all three tests pass**

Run: `npx jest test/core.guardrails.test.js -v`
Expected: 3 tests pass.

- [ ] **Step 9: Run the full suite**

Run: `npx jest`
Expected: all tests pass (Phase 1's 48 plus this task's 14 + 3 = 65 total).

- [ ] **Step 10: Commit**

```bash
git add src/guardrails.js test/guardrails.test.js src/core.js test/core.guardrails.test.js
git commit -m "feat: enforce contentFilter guardrail and wire all guardrails into queryRAG"
```

---

### Task 3: Ingestion file-size limit

**Files:**
- Modify: `src/config.js:109`
- Modify: `src/core.js:284-299` (`_validateFile`)
- Create: `test/ingestionLimits.test.js`

**Interfaces:**
- Produces: `config.ingestion.maxFileSizeBytes` (Zod schema field, default `52428800` = 50MB). `VectraClient.prototype._validateFile(filePath, stats)` now throws before hashing if `stats.size` exceeds the configured limit.

- [ ] **Step 1: Add the config field**

Edit `src/config.js` line 109, change:

```js
  ingestion: z.object({ rateLimitEnabled: z.boolean().default(false), concurrencyLimit: z.number().default(5) }).optional(),
```

to:

```js
  ingestion: z.object({ rateLimitEnabled: z.boolean().default(false), concurrencyLimit: z.number().default(5), maxFileSizeBytes: z.number().default(52428800) }).optional(),
```

- [ ] **Step 2: Write the failing test**

Create `test/ingestionLimits.test.js`:

```js
const { VectraClient, ProviderType } = require('../src/core');

function makeClient(maxFileSizeBytes) {
  return new VectraClient({
    embedding: { provider: ProviderType.OPENAI, apiKey: 'test-key' },
    llm: { provider: ProviderType.OPENAI, apiKey: 'test-key', modelName: 'gpt-4o-mini' },
    database: { type: 'chroma', clientInstance: { getOrCreateCollection: jest.fn() } },
    ingestion: maxFileSizeBytes !== undefined ? { maxFileSizeBytes } : undefined,
  });
}

describe('_validateFile file-size limit', () => {
  it('rejects a file over the configured limit', async () => {
    const client = makeClient(1000);
    await expect(client._validateFile('/tmp/big.txt', { size: 1001, mtimeMs: Date.now() }))
      .rejects.toThrow('File exceeds maximum allowed size');
  });

  it('accepts a file at the configured limit', async () => {
    const client = makeClient(1000);
    // A file at exactly the limit will proceed to hash — point at a real small file so fs.createReadStream succeeds.
    await expect(client._validateFile(__filename, { size: 1000, mtimeMs: Date.now() })).resolves.toBeDefined();
  });

  it('uses the default 50MB limit when not configured', async () => {
    const client = makeClient(undefined);
    await expect(client._validateFile('/tmp/huge.txt', { size: 52428801, mtimeMs: Date.now() }))
      .rejects.toThrow('File exceeds maximum allowed size');
  });
});
```

- [ ] **Step 3: Run and verify it fails**

Run: `npx jest test/ingestionLimits.test.js`
Expected: FAIL — no size check exists yet, so `_validateFile` proceeds to `fs.createReadStream('/tmp/big.txt')`, which throws a file-not-found error instead of the expected message (or the "at the limit" test may hang/fail differently). Either way, none of the three assertions about the specific "File exceeds maximum allowed size" message currently pass.

- [ ] **Step 4: Add the size check**

Edit `src/core.js`, inside `_validateFile` (starts at line 284), change:

```js
  async _validateFile(filePath, stats) {
    const absPath = path.resolve(filePath);
    const size = stats.size || 0;
    const mtime = Math.floor(stats.mtimeMs || Date.now());
```

to:

```js
  async _validateFile(filePath, stats) {
    const absPath = path.resolve(filePath);
    const size = stats.size || 0;
    const maxSize = (this.config.ingestion && this.config.ingestion.maxFileSizeBytes) || 52428800;
    if (size > maxSize) {
      throw new Error(`File exceeds maximum allowed size: ${filePath} (${size} bytes > ${maxSize} bytes limit)`);
    }
    const mtime = Math.floor(stats.mtimeMs || Date.now());
```

- [ ] **Step 5: Run and verify all pass**

Run: `npx jest test/ingestionLimits.test.js -v`
Expected: 3 tests pass.

- [ ] **Step 6: Run the full suite**

Run: `npx jest`
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/config.js src/core.js test/ingestionLimits.test.js
git commit -m "feat: add configurable max file size limit for ingestion"
```

---

### Task 4: Dependency vulnerability scanning in CI

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: a GitHub Actions workflow that runs on every push and pull request against `master`, running `npm test` and `npm audit --audit-level=high`.

- [ ] **Step 1: Create the workflow**

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [master]
  pull_request:
    branches: [master]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm install
      - run: npm test
      - run: npm audit --audit-level=high
```

- [ ] **Step 2: Validate the YAML is well-formed**

Run: `node -e "require('js-yaml') && console.log('js-yaml not installed, skipping parse check')" 2>/dev/null || python -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))" 2>/dev/null || echo "No YAML parser available locally — visually verify indentation is consistent (2 spaces) and the file was pasted exactly as given above."
Expected: no parse error if a YAML parser is available; otherwise a manual visual check is sufficient since the content above is copied verbatim.

- [ ] **Step 3: Run the full local suite one more time to confirm nothing else broke**

Run: `npx jest`
Expected: all tests pass (this task doesn't touch source code, this is a sanity check).

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run tests and npm audit on every push and pull request"
```

---

### Task 5: Correct telemetry documentation drift and publish SECURITY.md

**Files:**
- Modify: `README.md:549-550`
- Create: `SECURITY.md`

**Interfaces:**
- Produces: README's telemetry event list matches the actual fields sent (verified against every `telemetry.track(...)` call site in `src/core.js`, `src/webconfig_server.js`, and `bin/vectra.js`). `SECURITY.md` gives a responsible-disclosure contact.

- [ ] **Step 1: Fix the telemetry documentation drift**

Edit `README.md` lines 549-550, change:

```
    * `ingest_started/completed`: Source type, chunking strategy, duration bucket, chunk count bucket.
    * `query_executed`: Retrieval strategy, query mode (rag), result count, latency bucket.
```

to:

```
    * `ingest_batch_started`: File count, ingestion mode.
    * `ingest_batch_completed`: File count, chunk count, duration in milliseconds.
    * `query_executed`: Retrieval strategy, query mode (rag), reranking enabled, streaming, memory used, result count. No latency is currently tracked on this event.
```

(This corrects two inaccuracies found during Phase 2 review: the actual event names are `ingest_batch_started`/`ingest_batch_completed`, not `ingest_started/completed`; the code sends raw `duration_ms` and `chunk_count`, not "buckets"; and `query_executed` has no latency field at all despite the README previously claiming one.)

- [ ] **Step 2: Create SECURITY.md**

Create `SECURITY.md`:

```markdown
# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in vectra-js, please report it privately rather than opening a public GitHub issue.

Email: astroabhi.abhi@gmail.com

Please include:
- A description of the vulnerability and its potential impact
- Steps to reproduce (a minimal example is ideal)
- The version of vectra-js affected

We aim to acknowledge reports within 5 business days. Once a fix is available, we'll coordinate on a disclosure timeline with you before making details public.

## Supported Versions

Only the latest published version on npm receives security fixes.

## Scope

This SDK orchestrates calls to external vector databases and LLM providers that you configure and supply credentials for — it does not host or store your data itself. Vulnerabilities in this repo's own code (e.g. SQL construction, input validation, dependency issues) are in scope. Misconfiguration of the external services you connect it to is not.
```

- [ ] **Step 3: Run the full suite one last time**

Run: `npx jest`
Expected: all tests pass (this task only touches documentation).

- [ ] **Step 4: Commit**

```bash
git add README.md SECURITY.md
git commit -m "docs: correct telemetry event documentation, add SECURITY.md"
```

---

## Self-Review Notes

- **Spec coverage:** guardrails enforcement (Tasks 1-2), ingestion limits (Task 3), dependency scanning in CI (Task 4), telemetry payload documentation (Task 5), SECURITY.md (Task 5) — all Phase 2 vectra-js items from the design spec are covered. SQL-identifier hardening is explicitly out of scope here since Phase 1 already did it.
- **Placeholder scan:** no TBD/TODO; every step has runnable code.
- **Type consistency:** `checkGuardrails(query, guardrailsConfig)` signature is identical across Tasks 1, 2, and its call site in `queryRAG`. `DEFAULT_BLOCKED_TERMS` and `PII_PATTERNS` names match between implementation and exports.
- **Known limitation, stated honestly in Global Constraints and in code comments:** PII/content-filter detection is regex/keyword-based, not semantic. This is a real, working baseline appropriate for a security-hardening pass, not a claim of comprehensive content moderation.
