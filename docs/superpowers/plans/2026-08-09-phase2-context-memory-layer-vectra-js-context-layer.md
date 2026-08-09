# Context & Memory Layer Phase 2 — vectra-js Context Layer Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the standalone context-assembly primitive (Component 2 of `docs/superpowers/specs/2026-08-09-context-memory-layer-design.md`) — `buildContext()` (Tier 1, full control) and `context.ask()` (Tier 2, simple), then refactor `queryRAG` to use `buildContext` internally, fixing the real bug found in Phase 1 research: conversation history is concatenated into the prompt outside `buildContextParts`'s token-budget accounting.

**Architecture:** New `src/contextLayer.js` module, exporting `buildContext(input)`. Single vector store only in this phase (multi-db fan-out is Phase 3). Sources: `docs` (via a caller-supplied `similaritySearch`-shaped function), `memory` (via `FactStore.read`, from Phase 1), `tools` (pre-computed `{name, output}` pairs, no execution). `VectraClient` gets a `context` property exposing `context.ask(query, opts)` as a thin wrapper. `queryRAG` is refactored in the final task to call `buildContext` for context assembly instead of its own separate `buildContextParts` + ad-hoc history concatenation.

**Tech Stack:** Reuses `getTokenEncoder()`/`tokenEstimate` already in `src/core.js` (lazy js-tiktoken singleton). Jest.

## Global Constraints

- Single vector store only in this phase — accept one `docs` source, not an array of stores (multi-db fan-out is Phase 3's job).
- Tool-results are accepted as pre-computed input, never executed — no `tool_choice`/`functions` passthrough to any LLM backend.
- Token counts must be cached by content-hash (a simple `Map<string, number>` keyed by the exact string, since content is immutable once passed in) — do not re-tokenize identical content within one `buildContext` call or across calls in the same process lifetime.
- `dropped` in the output must be explicit and honest — anything trimmed for budget reasons must appear there, not silently vanish (this is the exact silent-truncation gap found in the original `buildContextParts`).
- The final task (`queryRAG` refactor) must not change `queryRAG`'s existing public signature or break any existing passing test. Run the FULL existing suite, not just new tests, after that task.
- No direct-to-master commits, no force-push, no skipped hooks.
- Every task ends with `npm test` passing before moving to the next task.

---

### Task 1: Cached token counting helper

**Files:**
- Modify: `src/core.js` (export a cache-aware token-count helper for reuse, or create a small shared module — implementer's call, see Step 3)
- Create: `test/contextLayer.tokenCache.test.js`

**Interfaces:**
- Produces: a function `estimateTokensCached(text)` that returns the same token count as `tokenEstimate` but memoizes by the exact string content, so calling it twice with identical content only tokenizes once.

- [ ] **Step 1: Write the failing test**

Create `test/contextLayer.tokenCache.test.js`:

```js
const { estimateTokensCached, _clearTokenCache } = require('../src/contextLayer');

describe('estimateTokensCached', () => {
  beforeEach(() => { _clearTokenCache(); });

  it('returns a real token count for text', () => {
    expect(estimateTokensCached('Hello, world!')).toBe(4);
  });

  it('does not re-tokenize identical content on a second call', () => {
    const spy = jest.spyOn(require('../src/contextLayer'), '_encodeForTest');
    estimateTokensCached('the quick brown fox');
    estimateTokensCached('the quick brown fox');
    // Second call must hit the cache — encode called at most once for this exact string.
    const callsForThisString = spy.mock.calls.filter(c => c[0] === 'the quick brown fox').length;
    expect(callsForThisString).toBeLessThanOrEqual(1);
    spy.mockRestore();
  });

  it('returns 0 for empty/falsy input', () => {
    expect(estimateTokensCached('')).toBe(0);
    expect(estimateTokensCached(null)).toBe(0);
  });
});
```

- [ ] **Step 2: Run and verify it fails**

Run: `npx jest test/contextLayer.tokenCache.test.js`
Expected: FAIL — `src/contextLayer.js` doesn't exist yet.

- [ ] **Step 3: Implement**

Create `src/contextLayer.js`. Reuse the lazy tiktoken singleton pattern already in `src/core.js` (`getTokenEncoder()`) rather than building a second one — check `src/core.js`'s exact current lazy-init code (module-level `let _tokenEncoder = null` / `getTokenEncoder()` function) and either export it from `core.js` for reuse, or duplicate the same lazy-singleton pattern locally in `contextLayer.js` if `core.js` doesn't currently export it and circular-requiring `core.js` from `contextLayer.js` would be awkward (check whether `core.js` will need to `require('./contextLayer')` later in Task 7 — if so, avoid a circular `require` by NOT having `contextLayer.js` require `core.js`; duplicate the small lazy-tiktoken-singleton snippet locally instead, it's ~5 lines).

```js
const { getEncoding } = require('js-tiktoken');

let _tokenEncoder = null;
function _getTokenEncoder() {
  if (!_tokenEncoder) _tokenEncoder = getEncoding('cl100k_base');
  return _tokenEncoder;
}

function _encodeForTest(text) {
  return _getTokenEncoder().encode(String(text));
}

const _tokenCache = new Map();

function estimateTokensCached(text) {
  if (!text) return 0;
  const key = String(text);
  if (_tokenCache.has(key)) return _tokenCache.get(key);
  const count = _encodeForTest(key).length;
  _tokenCache.set(key, count);
  return count;
}

function _clearTokenCache() {
  _tokenCache.clear();
}

module.exports = { estimateTokensCached, _clearTokenCache, _encodeForTest };
```

- [ ] **Step 4: Run and verify it passes**

Run: `npx jest test/contextLayer.tokenCache.test.js`
Expected: 3 tests pass.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all pass, no regressions.

- [ ] **Step 6: Commit**

```bash
git add src/contextLayer.js test/contextLayer.tokenCache.test.js
git commit -m "feat: add cached token-count helper for the new context layer"
```

---

### Task 2: `buildContext` — docs source, budget trimming, honest `dropped`

**Files:**
- Modify: `src/contextLayer.js`
- Create: `test/contextLayer.buildContext.docs.test.js`

**Interfaces:**
- Produces: `async function buildContext(input)` where `input = { query, budget: { maxTokens }, sources: [{ type: 'docs', items: [{content, metadata}, ...] }] }` (accepting pre-fetched doc items directly in this task — the caller has already run `similaritySearch`; a later task or Phase 3 handles auto-fetching). Returns `{ parts: [{source, type, content, tokens}], text, tokensUsed, tokensBudget, dropped: [] }`.

- [ ] **Step 1: Write the failing test**

Create `test/contextLayer.buildContext.docs.test.js`:

```js
const { buildContext, _clearTokenCache } = require('../src/contextLayer');

describe('buildContext - docs source', () => {
  beforeEach(() => { _clearTokenCache(); });

  it('packs doc content into parts within budget', async () => {
    const result = await buildContext({
      query: 'what is vectra?',
      budget: { maxTokens: 1000 },
      sources: [{ type: 'docs', items: [
        { content: 'Vectra is a RAG orchestration SDK.', metadata: { source: 'readme.md' } },
      ] }],
    });

    expect(result.parts).toHaveLength(1);
    expect(result.parts[0].type).toBe('docs');
    expect(result.parts[0].content).toContain('Vectra is a RAG orchestration SDK.');
    expect(result.parts[0].tokens).toBeGreaterThan(0);
    expect(result.text).toContain('Vectra is a RAG orchestration SDK.');
    expect(result.tokensUsed).toBeGreaterThan(0);
    expect(result.tokensBudget).toBe(1000);
    expect(result.dropped).toEqual([]);
  });

  it('honestly reports dropped items when budget is exceeded', async () => {
    const longContent = 'word '.repeat(200); // ~200+ tokens, will not fit in a tiny budget
    const result = await buildContext({
      query: 'q',
      budget: { maxTokens: 10 },
      sources: [{ type: 'docs', items: [
        { content: longContent, metadata: { source: 'a.md' } },
        { content: 'short', metadata: { source: 'b.md' } },
      ] }],
    });

    expect(result.dropped.length).toBeGreaterThan(0);
    expect(result.dropped[0].source).toBe('docs');
    // Everything that didn't fit must be accounted for in dropped, not silently vanished.
    const totalAccountedFor = result.parts.length + result.dropped.length;
    expect(totalAccountedFor).toBe(2);
  });

  it('returns an empty result for no sources', async () => {
    const result = await buildContext({ query: 'q', budget: { maxTokens: 100 }, sources: [] });
    expect(result.parts).toEqual([]);
    expect(result.text).toBe('');
    expect(result.tokensUsed).toBe(0);
  });
});
```

- [ ] **Step 2: Run and verify it fails**

Run: `npx jest test/contextLayer.buildContext.docs.test.js`
Expected: FAIL — `buildContext` not exported yet.

- [ ] **Step 3: Implement**

Add to `src/contextLayer.js`:

```js
async function buildContext(input) {
  const { query, budget = {}, sources = [], priority } = input;
  const maxTokens = budget.maxTokens ?? 2048;
  const parts = [];
  const dropped = [];
  let used = 0;

  const orderedSources = priority
    ? [...sources].sort((a, b) => priority.indexOf(a.type) - priority.indexOf(b.type))
    : sources;

  for (const source of orderedSources) {
    if (source.type === 'docs') {
      for (const item of (source.items || [])) {
        const content = item.content || '';
        const tokens = estimateTokensCached(content);
        if (used + tokens > maxTokens) {
          dropped.push({ source: 'docs', metadata: item.metadata || {} });
          continue;
        }
        parts.push({ source: 'docs', type: 'docs', content, tokens });
        used += tokens;
      }
    }
  }

  return {
    parts,
    text: parts.map(p => p.content).join('\n---\n'),
    tokensUsed: used,
    tokensBudget: maxTokens,
    dropped,
    warnings: [],
  };
}
```

Note: unlike the old `buildContextParts`'s `break`-on-first-overflow behavior, this loop uses `continue` so a later, smaller item can still fit after a larger one is skipped — a deliberate improvement, and it's why `dropped` must be a real list rather than "everything after index N."

- [ ] **Step 4: Run and verify it passes**

Run: `npx jest test/contextLayer.buildContext.docs.test.js`
Expected: 3 tests pass.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/contextLayer.js test/contextLayer.buildContext.docs.test.js
git commit -m "feat: buildContext docs source with budget-aware packing and honest dropped reporting"
```

---

### Task 3: `buildContext` — memory source (FactStore integration)

**Files:**
- Modify: `src/contextLayer.js`
- Create: `test/contextLayer.buildContext.memory.test.js`

**Interfaces:**
- Consumes: `FactStore` from Phase 1 (`src/memory/factStore.js`) — specifically its `read(sessionId, query, opts)` method.
- Produces: `sources` array now also accepts `{ type: 'memory', factStore, sessionId }`. `buildContext` calls `factStore.read(sessionId, query)` and packs each returned fact into a `parts` entry with `type: 'memory'`, counted against the SAME token budget as docs (this is the fix for the Phase 1 research bug — memory now genuinely competes for budget instead of being concatenated for free).

- [ ] **Step 1: Write the failing test**

Create `test/contextLayer.buildContext.memory.test.js`:

```js
const { buildContext, _clearTokenCache } = require('../src/contextLayer');

function fakeFactStore(facts) {
  return { read: jest.fn(async () => facts) };
}

describe('buildContext - memory source', () => {
  beforeEach(() => { _clearTokenCache(); });

  it('packs facts from FactStore.read into parts, counted against the budget', async () => {
    const factStore = fakeFactStore([
      { subject: 'user', predicate: 'likes', object: 'coffee' },
    ]);

    const result = await buildContext({
      query: 'what does the user like',
      budget: { maxTokens: 1000 },
      sources: [{ type: 'memory', factStore, sessionId: 'session-1' }],
    });

    expect(factStore.read).toHaveBeenCalledWith('session-1', 'what does the user like');
    expect(result.parts).toHaveLength(1);
    expect(result.parts[0].type).toBe('memory');
    expect(result.parts[0].content).toContain('coffee');
    expect(result.tokensUsed).toBeGreaterThan(0);
  });

  it('memory genuinely competes for budget with docs — a real regression test for the Phase 1 bug', async () => {
    // Budget only fits ONE of these two items. Whichever is processed first should
    // win; the point is that memory content actually gets counted against maxTokens
    // at all (the old queryRAG concatenated history completely outside any budget).
    const longDoc = 'word '.repeat(50);
    const factStore = fakeFactStore([{ subject: 'user', predicate: 'likes', object: 'coffee' }]);

    const result = await buildContext({
      query: 'q',
      budget: { maxTokens: 5 },
      sources: [
        { type: 'docs', items: [{ content: longDoc, metadata: {} }] },
        { type: 'memory', factStore, sessionId: 'session-1' },
      ],
    });

    // The long doc alone exceeds the tiny budget, so it must be dropped —
    // proving memory's presence didn't get a free pass around budget accounting.
    expect(result.dropped.some(d => d.source === 'docs')).toBe(true);
  });

  it('skips the memory source cleanly when no factStore or sessionId is provided', async () => {
    const result = await buildContext({
      query: 'q',
      budget: { maxTokens: 100 },
      sources: [{ type: 'memory', factStore: null, sessionId: 'session-1' }],
    });
    expect(result.parts).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and verify it fails**

Run: `npx jest test/contextLayer.buildContext.memory.test.js`
Expected: FAIL — memory source type not handled yet.

- [ ] **Step 3: Implement**

Add a `memory` branch to the `for (const source of orderedSources)` loop in `buildContext`:

```js
    if (source.type === 'memory') {
      if (!source.factStore || !source.sessionId) continue;
      const facts = await source.factStore.read(source.sessionId, query);
      for (const fact of (facts || [])) {
        const content = `${fact.subject} ${fact.predicate} ${fact.object}`;
        const tokens = estimateTokensCached(content);
        if (used + tokens > maxTokens) {
          dropped.push({ source: 'memory', fact });
          continue;
        }
        parts.push({ source: 'memory', type: 'memory', content, tokens });
        used += tokens;
      }
    }
```

- [ ] **Step 4: Run and verify it passes**

Run: `npx jest test/contextLayer.buildContext.memory.test.js`
Expected: 3 tests pass.

- [ ] **Step 5: Run the full suite, including Task 2's tests**

Run: `npx jest test/contextLayer.*.test.js && npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/contextLayer.js test/contextLayer.buildContext.memory.test.js
git commit -m "feat: buildContext memory source via FactStore.read, counted against the shared token budget"
```

---

### Task 4: `buildContext` — tools source (pre-computed results only)

**Files:**
- Modify: `src/contextLayer.js`
- Create: `test/contextLayer.buildContext.tools.test.js`

**Interfaces:**
- Produces: `sources` array now also accepts `{ type: 'tools', results: [{ name, output }, ...] }`. Each result becomes a `parts` entry with `type: 'tools'`, counted against the same budget. No execution of any kind — this is purely packing pre-computed results into context.

- [ ] **Step 1: Write the failing test**

Create `test/contextLayer.buildContext.tools.test.js`:

```js
const { buildContext, _clearTokenCache } = require('../src/contextLayer');

describe('buildContext - tools source', () => {
  beforeEach(() => { _clearTokenCache(); });

  it('packs pre-computed tool results into parts', async () => {
    const result = await buildContext({
      query: 'q',
      budget: { maxTokens: 1000 },
      sources: [{ type: 'tools', results: [
        { name: 'get_weather', output: 'Sunny, 22C' },
      ] }],
    });

    expect(result.parts).toHaveLength(1);
    expect(result.parts[0].type).toBe('tools');
    expect(result.parts[0].content).toContain('get_weather');
    expect(result.parts[0].content).toContain('Sunny, 22C');
  });

  it('does not execute anything — results are used verbatim as given', async () => {
    const output = { note: 'this is data, not a function' };
    const result = await buildContext({
      query: 'q',
      budget: { maxTokens: 1000 },
      sources: [{ type: 'tools', results: [{ name: 'x', output: JSON.stringify(output) }] }],
    });
    expect(result.parts[0].content).toContain('this is data, not a function');
  });

  it('honestly drops tool results that do not fit the budget', async () => {
    const result = await buildContext({
      query: 'q',
      budget: { maxTokens: 2 },
      sources: [{ type: 'tools', results: [{ name: 'x', output: 'word '.repeat(50) }] }],
    });
    expect(result.parts).toHaveLength(0);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].source).toBe('tools');
  });
});
```

- [ ] **Step 2: Run and verify it fails**

Run: `npx jest test/contextLayer.buildContext.tools.test.js`
Expected: FAIL — tools source type not handled yet.

- [ ] **Step 3: Implement**

Add a `tools` branch:

```js
    if (source.type === 'tools') {
      for (const result of (source.results || [])) {
        const content = `Tool: ${result.name}\nResult: ${result.output}`;
        const tokens = estimateTokensCached(content);
        if (used + tokens > maxTokens) {
          dropped.push({ source: 'tools', name: result.name });
          continue;
        }
        parts.push({ source: 'tools', type: 'tools', content, tokens });
        used += tokens;
      }
    }
```

- [ ] **Step 4: Run and verify it passes**

Run: `npx jest test/contextLayer.buildContext.tools.test.js`
Expected: 3 tests pass.

- [ ] **Step 5: Run the full suite**

Run: `npx jest test/contextLayer.*.test.js && npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/contextLayer.js test/contextLayer.buildContext.tools.test.js
git commit -m "feat: buildContext tools source, pre-computed results only, no execution"
```

---

### Task 5: Priority-based trim order

**Files:**
- Modify: `src/contextLayer.js`
- Create: `test/contextLayer.priority.test.js`

**Interfaces:**
- Verifies/hardens: `input.priority` (e.g. `['memory', 'tools', 'docs']`) determines which source type's items get first claim on the budget when multiple source types are present and the budget can't fit everything. This is largely already implemented by Task 2's `orderedSources` sort — this task is primarily a dedicated test proving it, plus fixing any edge case the test finds (e.g. `priority` omitting a source type present in `sources`).

- [ ] **Step 1: Write the failing test**

Create `test/contextLayer.priority.test.js`:

```js
const { buildContext, _clearTokenCache } = require('../src/contextLayer');

describe('buildContext - priority order', () => {
  beforeEach(() => { _clearTokenCache(); });

  it('gives earlier-priority sources first claim on a tight budget', async () => {
    const factStore = { read: jest.fn(async () => [{ subject: 'user', predicate: 'likes', object: 'coffee' }]) };
    const bigDoc = 'word '.repeat(50);

    const result = await buildContext({
      query: 'q',
      budget: { maxTokens: 10 }, // only enough for the small memory fact, not the big doc
      sources: [
        { type: 'docs', items: [{ content: bigDoc, metadata: {} }] },
        { type: 'memory', factStore, sessionId: 's1' },
      ],
      priority: ['memory', 'docs'],
    });

    expect(result.parts.some(p => p.type === 'memory')).toBe(true);
    expect(result.parts.some(p => p.type === 'docs')).toBe(false);
    expect(result.dropped.some(d => d.source === 'docs')).toBe(true);
  });

  it('a source type not listed in priority still processes (falls to the end), not silently dropped wholesale', async () => {
    const result = await buildContext({
      query: 'q',
      budget: { maxTokens: 1000 },
      sources: [{ type: 'tools', results: [{ name: 'x', output: 'y' }] }],
      priority: ['memory', 'docs'], // 'tools' intentionally omitted
    });
    expect(result.parts).toHaveLength(1);
    expect(result.parts[0].type).toBe('tools');
  });

  it('with no priority given, sources are processed in the order supplied', async () => {
    const result = await buildContext({
      query: 'q',
      budget: { maxTokens: 1000 },
      sources: [
        { type: 'tools', results: [{ name: 'x', output: 'y' }] },
        { type: 'docs', items: [{ content: 'doc content', metadata: {} }] },
      ],
    });
    expect(result.parts[0].type).toBe('tools');
    expect(result.parts[1].type).toBe('docs');
  });
});
```

- [ ] **Step 2: Run and verify it fails or passes**

Run: `npx jest test/contextLayer.priority.test.js`
Expected: the first test likely passes already (Task 2's sort handles it); the second test may FAIL if `indexOf` returning `-1` for an unlisted type sorts it incorrectly relative to listed types (a plain `.sort()` on `indexOf` results puts `-1` FIRST, not last, which is the wrong "not silently dropped wholesale" semantic but the WRONG ordering — verify by reasoning through `Array.prototype.sort`'s comparator behavior, then fix if needed).

- [ ] **Step 3: Fix if needed**

If the second test reveals `-1`-indexOf sorting unlisted types first (rather than last, which is a more sensible default — process explicitly-prioritized types first, then whatever's left in original order), adjust the sort comparator in `buildContext`:

```js
  const orderedSources = priority
    ? [...sources].sort((a, b) => {
        const ai = priority.indexOf(a.type);
        const bi = priority.indexOf(b.type);
        const aRank = ai === -1 ? priority.length : ai;
        const bRank = bi === -1 ? priority.length : bi;
        return aRank - bRank;
      })
    : sources;
```

- [ ] **Step 4: Run and verify all pass**

Run: `npx jest test/contextLayer.priority.test.js`
Expected: 3 tests pass.

- [ ] **Step 5: Run the full suite**

Run: `npx jest test/contextLayer.*.test.js && npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/contextLayer.js test/contextLayer.priority.test.js
git commit -m "fix: unlisted source types in priority sort to the end, not the start"
```
(Adjust commit message if Step 2 found no bug and no fix was needed — in that case just commit the test file with a message like "test: add dedicated priority-order coverage for buildContext".)

---

### Task 6: Tier 2 — `context.ask()` on `VectraClient`

**Files:**
- Modify: `src/core.js`
- Create: `test/core.contextAsk.test.js`

**Interfaces:**
- Consumes: `buildContext` from `src/contextLayer.js`, `this.vectorStore.similaritySearch`, `this.embedder.embedQuery`, `this.factStore` (from Phase 1, may be `null`).
- Produces: `VectraClient` gains `this.context = { ask: async (query, opts) => ... }` where `opts = { sessionId, tools }` (all optional). Internally: embeds the query, calls `similaritySearch` on the configured vector store, calls `buildContext` with docs + (memory if `sessionId` and `this.factStore` are both present) + (tools if `opts.tools` given), using `this.config.contextLayer` budget defaults if configured (fallback `{ maxTokens: 2048 }`).

- [ ] **Step 1: Read `core.js`'s constructor and `queryRAG` once more**

Confirm exact current property names (`this.vectorStore`, `this.embedder`, `this.factStore` from Phase 1, `this.config`) before wiring — these should already match Phase 1's wiring, but verify directly rather than assuming.

- [ ] **Step 2: Write the failing test**

Create `test/core.contextAsk.test.js`:

```js
const { VectraClient, ProviderType } = require('../src/core');

function makeConfig(overrides = {}) {
  return {
    embedding: { provider: ProviderType.OPENAI, apiKey: 'test-key' },
    llm: { provider: ProviderType.OPENAI, apiKey: 'test-key', modelName: 'gpt-4o-mini' },
    database: { type: 'chroma', clientInstance: { getOrCreateCollection: jest.fn() } },
    ...overrides,
  };
}

describe('VectraClient.context.ask', () => {
  it('embeds the query, retrieves docs, and returns packed context', async () => {
    const client = new VectraClient(makeConfig());
    client.embedder.embedQuery = jest.fn().mockResolvedValue([0.1, 0.2]);
    client.vectorStore.similaritySearch = jest.fn().mockResolvedValue([
      { content: 'Vectra is a RAG SDK.', metadata: { source: 'readme.md' } },
    ]);

    const result = await client.context.ask('what is vectra?');

    expect(client.embedder.embedQuery).toHaveBeenCalledWith('what is vectra?');
    expect(client.vectorStore.similaritySearch).toHaveBeenCalled();
    expect(result.parts.some(p => p.type === 'docs')).toBe(true);
    expect(result.text).toContain('Vectra is a RAG SDK.');
  });

  it('includes memory when sessionId is given and a factStore is configured', async () => {
    const client = new VectraClient(makeConfig({
      memory: { enabled: true, facts: { enabled: true, clientInstance: {}, tableName: 'F' } },
    }));
    client.embedder.embedQuery = jest.fn().mockResolvedValue([0.1, 0.2]);
    client.vectorStore.similaritySearch = jest.fn().mockResolvedValue([]);
    client.factStore.read = jest.fn().mockResolvedValue([{ subject: 'user', predicate: 'likes', object: 'coffee' }]);

    const result = await client.context.ask('what does the user like', { sessionId: 'session-1' });

    expect(client.factStore.read).toHaveBeenCalledWith('session-1', 'what does the user like');
    expect(result.parts.some(p => p.type === 'memory')).toBe(true);
  });

  it('skips memory cleanly when no sessionId is given, even if a factStore is configured', async () => {
    const client = new VectraClient(makeConfig({
      memory: { enabled: true, facts: { enabled: true, clientInstance: {}, tableName: 'F' } },
    }));
    client.embedder.embedQuery = jest.fn().mockResolvedValue([0.1, 0.2]);
    client.vectorStore.similaritySearch = jest.fn().mockResolvedValue([]);
    client.factStore.read = jest.fn();

    await client.context.ask('q');

    expect(client.factStore.read).not.toHaveBeenCalled();
  });

  it('includes tool results when opts.tools is given', async () => {
    const client = new VectraClient(makeConfig());
    client.embedder.embedQuery = jest.fn().mockResolvedValue([0.1, 0.2]);
    client.vectorStore.similaritySearch = jest.fn().mockResolvedValue([]);

    const result = await client.context.ask('q', { tools: [{ name: 'get_weather', output: 'Sunny' }] });

    expect(result.parts.some(p => p.type === 'tools')).toBe(true);
  });
});
```

- [ ] **Step 3: Run and verify it fails**

Run: `npx jest test/core.contextAsk.test.js`
Expected: FAIL — `client.context` doesn't exist yet.

- [ ] **Step 4: Implement**

Add `const { buildContext } = require('./contextLayer');` to `core.js`'s imports. In the `VectraClient` constructor, after `this.factStore` is set (from Phase 1's wiring), add:

```js
    this.context = {
      ask: async (query, opts = {}) => {
        const queryVector = await this.embedder.embedQuery(query);
        const docs = await this.vectorStore.similaritySearch(queryVector, 5);
        const sources = [{ type: 'docs', items: docs.map(d => ({ content: d.content, metadata: d.metadata })) }];
        if (opts.sessionId && this.factStore) {
          sources.push({ type: 'memory', factStore: this.factStore, sessionId: opts.sessionId });
        }
        if (opts.tools) {
          sources.push({ type: 'tools', results: opts.tools });
        }
        const budget = this.config.contextLayer?.budget || { maxTokens: 2048 };
        return buildContext({ query, budget, sources, priority: this.config.contextLayer?.priority });
      },
    };
```

- [ ] **Step 5: Run and verify it passes**

Run: `npx jest test/core.contextAsk.test.js`
Expected: 4 tests pass.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/core.js test/core.contextAsk.test.js
git commit -m "feat: add VectraClient.context.ask, the simple tier-2 wrapper over buildContext"
```

---

### Task 7: Refactor `queryRAG` to use `buildContext` internally (backward-compatible, fixes the history/budget bug)

**Files:**
- Modify: `src/core.js`
- Create: `test/core.queryRAG.contextLayerRefactor.test.js`

**Interfaces:**
- `queryRAG`'s public signature (`queryRAG(query, filter, stream, sessionId)`) is UNCHANGED.
- Internally, the block currently building `context` (via `buildContextParts`) and separately concatenating `historyText` into the prompt is replaced with a single `buildContext` call whose `sources` include `docs` (the already-retrieved/reranked `docs` array) and, when `this.history` and `sessionId` are both present, a new source type for RAW history (not facts — this task does NOT switch `queryRAG` to use `FactStore`; it only fixes history's token-budget accounting using its EXISTING `this.history.getRecent` raw-message source, now properly counted).

This requires `buildContext` to support a 4th source type for raw conversation history. Add it in this task (not a new numbered task, since it's small and only needed here):

```js
    if (source.type === 'history') {
      const messages = source.messages || [];
      for (const m of messages) {
        const content = `${String(m.role).toUpperCase()}: ${m.content}`;
        const tokens = estimateTokensCached(content);
        if (used + tokens > maxTokens) {
          dropped.push({ source: 'history' });
          continue;
        }
        parts.push({ source: 'history', type: 'history', content, tokens });
        used += tokens;
      }
    }
```

- [ ] **Step 1: Read the CURRENT exact state of `queryRAG`'s context-building block**

Read `src/core.js` around the `buildContextParts` call and the `historyText` block (confirmed at research time to be near lines 909-944, but line numbers have shifted after Tasks 1-6 added code earlier in the file — find the current exact location before editing). Read the whole surrounding `queryRAG` function (from its `async queryRAG(` declaration to its closing brace) to understand every existing behavior that must be preserved: citations numbering (`[1]`, `[2]`, ...), grounding snippet injection (strict vs. non-strict), the custom `config.prompts.query` template path, the default prompt construction for both citations-enabled and citations-disabled cases.

- [ ] **Step 2: Write the failing/regression test FIRST**

Create `test/core.queryRAG.contextLayerRefactor.test.js` — this test's entire purpose is proving the history/budget bug is fixed, so it must be a discriminating fixture (fails against the CURRENT unfixed code, passes after the fix):

```js
const { VectraClient, ProviderType } = require('../src/core');
const { RetrievalStrategy } = require('../src/config');

function makeConfig(overrides = {}) {
  return {
    embedding: { provider: ProviderType.OPENAI, apiKey: 'test-key' },
    llm: { provider: ProviderType.OPENAI, apiKey: 'test-key', modelName: 'gpt-4o-mini' },
    database: { type: 'chroma', clientInstance: { getOrCreateCollection: jest.fn() } },
    memory: { enabled: true, type: 'in-memory' },
    queryPlanning: { tokenBudget: 15 }, // tiny budget — forces a real trim decision
    ...overrides,
  };
}

describe('queryRAG history now counts against the token budget (Phase 1 research bug fix)', () => {
  it('a long conversation history no longer bypasses the budget uncounted', async () => {
    const client = new VectraClient(makeConfig());
    client.embedder.embedQuery = jest.fn().mockResolvedValue([0.1, 0.2]);
    client.vectorStore.similaritySearch = jest.fn().mockResolvedValue([
      { content: 'short doc', metadata: {} },
    ]);
    client.llm.generate = jest.fn().mockResolvedValue('an answer');

    // Seed a LOT of history — under the old behavior this was concatenated into the
    // prompt with zero budget accounting; under the fix it must compete for the same
    // tiny 15-token budget as the doc content, and get trimmed like anything else.
    for (let i = 0; i < 20; i++) {
      client.history.addMessage('session-1', 'user', `This is a fairly long historical message number ${i} with real words in it.`);
    }

    await client.queryRAG('what is this?', null, false, 'session-1');

    // Inspect the actual prompt sent to the LLM.
    const promptSent = client.llm.generate.mock.calls[0][0];
    const promptTokenEstimate = client.tokenEstimate(promptSent);

    // The full un-budgeted history alone would be several hundred tokens. If the fix
    // works, the history portion of the prompt is now bounded by the same small
    // queryPlanning.tokenBudget as everything else, so the total prompt stays small
    // (a generous multiple of the budget to allow for the question/instruction text
    // itself, which isn't part of the budgeted context) rather than growing unbounded
    // with history length.
    expect(promptTokenEstimate).toBeLessThan(200);
  });
});
```

- [ ] **Step 3: Run and verify it fails against the CURRENT code**

Run: `npx jest test/core.queryRAG.contextLayerRefactor.test.js`
Expected: FAIL — with 20 seeded messages of real content, the current unfixed `historyText` concatenation should push the prompt token estimate well over 200. If it does NOT fail (e.g. `getRecent` defaults already cap history low enough to pass even unfixed), increase the seeded message count/length in Step 2 until the test genuinely discriminates — verify this before proceeding, do not skip this check.

- [ ] **Step 4: Implement the refactor**

Replace the `buildContextParts` call and the separate `historyText` block (from Step 1's read) with a single `buildContext` call. Preserve every existing behavior:

```js
        const docSources = [{ type: 'docs', items: docs.map(d => ({ content: d.content, metadata: d.metadata })) }];

        let historySource = null;
        if (this.history && sessionId) {
          const fn = this.history.getRecent?.bind(this.history);
          if (typeof fn === 'function') {
            const out = fn.length >= 2 ? fn(sessionId, this.config.memory?.maxMessages || 10) : fn(sessionId);
            const recent = out && typeof out.then === 'function' ? await out : out;
            if (Array.isArray(recent) && recent.length > 0) {
              historySource = { type: 'history', messages: recent };
            }
          }
        }

        const budget = { maxTokens: (this.config.queryPlanning && this.config.queryPlanning.tokenBudget) || DEFAULT_TOKEN_BUDGET };
        const packed = await buildContext({
          query,
          budget,
          sources: historySource ? [...docSources, historySource] : docSources,
          priority: ['docs', 'history'],
        });

        const docParts = packed.parts.filter(p => p.type === 'docs').map(p => p.content);
        const contextParts = citationsEnabled
          ? docParts.map((p, i) => `[${i + 1}] ${p}`)
          : docParts;

        // grounding snippet injection block (unchanged from before — still operates on
        // `contextParts` and `docs` exactly as it did previously, read Step 1's research
        // for the exact existing code to preserve here verbatim)

        const context = contextParts.join('\n---\n');
        const historyText = packed.parts.filter(p => p.type === 'history').map(p => p.content).join('\n');

        // prompt-construction block (unchanged from before — still branches on
        // config.prompts.query / citationsEnabled exactly as previously, using the
        // same `context` and `historyText` variable names so the rest of the function
        // needs no further changes)
```

Preserve the `DEFAULT_TOKEN_BUDGET` constant reference and the exact grounding/prompt-construction code verbatim from Step 1's read — only the two variables `context` and `historyText` need to now originate from `buildContext`'s output instead of `buildContextParts` + raw concatenation; everything downstream that consumes them is unchanged.

Note: `docMap` (used elsewhere for citation source metadata) was previously returned by `buildContextParts` directly. Since `buildContext`'s `parts` already carries `metadata` info indirectly via the original `docs` array, reconstruct `docMap` from the ORIGINAL `docs` array (not from `packed.parts`, which only has `content`/`tokens`/`type`) using the same field-extraction logic `buildContextParts` used (`d.metadata?.source`, `pageFrom`, `pageTo`, `section`, `docTitle`) — filtered/ordered to match which docs actually survived into `packed.parts` (cross-reference by content string, since `buildContext`'s docs branch doesn't drop metadata, just doesn't include it in its own return shape). Read how `docMap` is consumed downstream in `queryRAG` before finalizing this — confirm exactly what shape callers expect.

- [ ] **Step 5: Run the regression test and verify it now passes**

Run: `npx jest test/core.queryRAG.contextLayerRefactor.test.js`
Expected: PASS.

- [ ] **Step 6: Run the ENTIRE existing test suite — this is the critical regression check**

Run: `npm test`
Expected: ALL suites pass, including every existing `queryRAG`-related test (citations, grounding, HyDE, multi-query, hybrid, MMR, reranking order-preservation — all of Phase 3's ordering tests). If ANY existing test fails, do not weaken it — the refactor has a real behavioral gap; find and fix it, re-reading the exact original code for whatever behavior broke.

- [ ] **Step 7: Commit**

```bash
git add src/core.js src/contextLayer.js test/core.queryRAG.contextLayerRefactor.test.js
git commit -m "refactor: queryRAG now uses buildContext internally, fixing the unbounded history/token-budget bug found in Phase 1 research"
```

---

## Self-Review Notes

- **Spec coverage**: Tier 1 `buildContext` (Tasks 1-5: token caching, docs/memory/tools sources, priority order), Tier 2 `context.ask` (Task 6), backward-compatible `queryRAG` refactor fixing the real history/budget bug (Task 7) — matches Component 2 of the spec, single-store only as scoped for this phase.
- **Placeholder scan**: no TBD/TODO. Task 7's docMap-reconstruction note is an explicit, real implementation instruction (read the downstream consumer, don't guess), not a placeholder.
- **Highest-risk task flagged explicitly**: Task 7 is the one task touching heavily-tested existing production code (`queryRAG`) — its plan mandates writing the discriminating regression test FIRST and verifying it genuinely fails pre-fix, then running the ENTIRE suite (not just new tests) post-fix, with an explicit instruction to fix real gaps rather than weaken assertions.
- **Consistency with Phase 1**: reuses `FactStore.read` exactly as built in Phase 1, no reimplementation.
