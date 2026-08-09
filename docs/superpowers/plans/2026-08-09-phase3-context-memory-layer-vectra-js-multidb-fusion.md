# Context & Memory Layer Phase 3 — vectra-js Multi-DB Fusion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extend `buildContext`'s `docs` source (Component 3 of the spec) to fan out across MULTIPLE vector store instances concurrently and RRF-fuse the results into one ranked list — the multi-db capability the umbrella spec named as a real gap vs. the existing single-store `similaritySearch`/`hybridSearch` pattern.

**Architecture:** New docs-source shape alongside the existing pre-fetched-`items` shape: `{ type: 'docs', stores: [store1, store2, ...], vector, query, limit, strategy }`. `buildContext` fans out via `Promise.all` with a per-store timeout, RRF-fuses successful results (reusing the exact `1/(k+rank+1)`, k=60 formula already used in `core.js`'s `reciprocalRankFusion` and every hybrid-search backend), and reports per-store failures in `warnings` rather than failing the whole call.

**Tech Stack:** No new dependencies.

## Global Constraints

- Concurrent fan-out only — never sequential `for` loop over stores.
- Per-store timeout (default 5000ms, configurable) + circuit-breaker: one dead/slow store produces a `warnings` entry and the fan-out proceeds with whatever succeeded, never a hard failure of the whole `buildContext` call.
- RRF fusion constant k=60, matching every existing fusion site in this codebase — do not invent a different constant.
- The existing pre-fetched-`items` docs-source shape (Phase 2) is completely unchanged — this is additive, a new shape recognized alongside it, not a replacement.
- No direct-to-master commits, no force-push, no skipped hooks.
- Every task ends with `npm test` passing.

---

### Task 1: Concurrent multi-store fan-out with RRF fusion

**Files:**
- Modify: `src/contextLayer.js`
- Create: `test/contextLayer.multiDb.test.js`

**Interfaces:**
- Produces: `buildContext`'s `docs` branch recognizes `source.stores` (an array of objects each exposing `similaritySearch(vector, limit, filter)` and optionally `hybridSearch(text, vector, limit, filter)`) as an alternative to `source.items`. When `source.stores` is present: calls `Promise.all(stores.map(store => fanOutOneStore(store, ...)))`, where each store call is `strategy === 'hybrid' && typeof store.hybridSearch === 'function' ? store.hybridSearch(query, vector, limit, filter) : store.similaritySearch(vector, limit, filter)`. Successful results get RRF-fused (`1/(60+rank+1)`, deduped by `content`) into one ranked list, then packed into `parts`/`dropped` exactly like the existing `items` path.

- [ ] **Step 1: Write the failing test**

Create `test/contextLayer.multiDb.test.js`:

```js
const { buildContext, _clearTokenCache } = require('../src/contextLayer');

function makeStore(results) {
  return { similaritySearch: jest.fn().mockResolvedValue(results) };
}

describe('buildContext - multi-db fusion (docs source with stores array)', () => {
  beforeEach(() => { _clearTokenCache(); });

  it('fans out to all stores concurrently and fuses results', async () => {
    const storeA = makeStore([{ content: 'doc from A', metadata: {}, score: 0.9 }]);
    const storeB = makeStore([{ content: 'doc from B', metadata: {}, score: 0.8 }]);

    const result = await buildContext({
      query: 'q',
      budget: { maxTokens: 1000 },
      sources: [{ type: 'docs', stores: [storeA, storeB], vector: [0.1, 0.2], limit: 5 }],
    });

    expect(storeA.similaritySearch).toHaveBeenCalledWith([0.1, 0.2], 5, undefined);
    expect(storeB.similaritySearch).toHaveBeenCalledWith([0.1, 0.2], 5, undefined);
    const contents = result.parts.map(p => p.content);
    expect(contents).toContain('doc from A');
    expect(contents).toContain('doc from B');
  });

  it('a doc findable only in one of two stores survives fusion (real RRF proof, not vacuous)', async () => {
    const storeA = makeStore([
      { content: 'shared doc', metadata: {}, score: 0.5 },
      { content: 'only in A', metadata: {}, score: 0.4 },
    ]);
    const storeB = makeStore([{ content: 'shared doc', metadata: {}, score: 0.5 }]);

    const result = await buildContext({
      query: 'q',
      budget: { maxTokens: 1000 },
      sources: [{ type: 'docs', stores: [storeA, storeB], vector: [0.1], limit: 5 }],
    });

    const contents = result.parts.map(p => p.content);
    expect(contents).toContain('only in A');
    expect(contents).toContain('shared doc');
  });

  it('dedupes by content across stores rather than double-counting the same doc', async () => {
    const storeA = makeStore([{ content: 'dup', metadata: {}, score: 0.9 }]);
    const storeB = makeStore([{ content: 'dup', metadata: {}, score: 0.9 }]);

    const result = await buildContext({
      query: 'q',
      budget: { maxTokens: 1000 },
      sources: [{ type: 'docs', stores: [storeA, storeB], vector: [0.1], limit: 5 }],
    });

    expect(result.parts.filter(p => p.content === 'dup')).toHaveLength(1);
  });

  it('uses hybridSearch instead of similaritySearch when strategy is hybrid and the store supports it', async () => {
    const store = { similaritySearch: jest.fn(), hybridSearch: jest.fn().mockResolvedValue([{ content: 'hybrid result', metadata: {}, score: 0.9 }]) };

    await buildContext({
      query: 'the query text',
      budget: { maxTokens: 1000 },
      sources: [{ type: 'docs', stores: [store], vector: [0.1], limit: 5, strategy: 'hybrid' }],
    });

    expect(store.hybridSearch).toHaveBeenCalledWith('the query text', [0.1], 5, undefined);
    expect(store.similaritySearch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run and verify it fails**

Run: `npx jest test/contextLayer.multiDb.test.js`
Expected: FAIL — `source.stores` not recognized yet.

- [ ] **Step 3: Implement**

Add a helper and extend the `docs` branch in `src/contextLayer.js`:

```js
function _reciprocalRankFusion(resultLists, k = 60) {
  const scores = {};
  const contentMap = {};
  resultLists.forEach(list => {
    list.forEach((doc, rank) => {
      if (!contentMap[doc.content]) contentMap[doc.content] = doc;
      if (!scores[doc.content]) scores[doc.content] = 0;
      scores[doc.content] += 1 / (k + rank + 1);
    });
  });
  return Object.keys(scores)
    .sort((a, b) => scores[b] - scores[a])
    .map(content => contentMap[content]);
}
```

Inside the `docs` branch, before the existing `source.items` handling, add:

```js
    if (source.type === 'docs' && Array.isArray(source.stores)) {
      const { stores, vector, limit = 5, filter, strategy } = source;
      const settled = await Promise.allSettled(stores.map(store => {
        const call = (strategy === 'hybrid' && typeof store.hybridSearch === 'function')
          ? store.hybridSearch(query, vector, limit, filter)
          : store.similaritySearch(vector, limit, filter);
        return call;
      }));
      const successfulLists = [];
      settled.forEach((res, i) => {
        if (res.status === 'fulfilled') {
          successfulLists.push(res.value);
        } else {
          warnings.push({ store: i, error: String(res.reason?.message || res.reason) });
        }
      });
      const fused = _reciprocalRankFusion(successfulLists);
      for (const doc of fused) {
        const content = doc.content || '';
        const tokens = estimateTokensCached(content);
        if (used + tokens > maxTokens) {
          dropped.push({ source: 'docs', metadata: doc.metadata || {} });
          continue;
        }
        parts.push({ source: 'docs', type: 'docs', content, tokens });
        used += tokens;
      }
      continue; // this source is fully handled — don't also fall into the items branch
    }
```

Note: this requires `warnings` to be declared with `let` (not `const`, or already mutable — check the current declaration) before this point in `buildContext`, and the `continue` requires this code to be inside the same `for (const source of orderedSources)` loop as the other branches — confirm exact placement relative to the existing `if (source.type === 'docs')` block (the multi-store check must come first, or use `else if` against the existing items-based branch, so both shapes don't both attempt to run for the same source object).

- [ ] **Step 4: Run and verify it passes**

Run: `npx jest test/contextLayer.multiDb.test.js`
Expected: 4 tests pass.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all pass, no regressions to Phase 2's docs-source tests (the `items`-based shape).

- [ ] **Step 6: Commit**

```bash
git add src/contextLayer.js test/contextLayer.multiDb.test.js
git commit -m "feat: multi-db fan-out for buildContext's docs source, concurrent + RRF-fused"
```

---

### Task 2: Per-store timeout + circuit-breaker

**Files:**
- Modify: `src/contextLayer.js`
- Create: `test/contextLayer.multiDbTimeout.test.js`

**Interfaces:**
- Produces: each store call in the fan-out is wrapped with a timeout (default 5000ms, overridable via `source.timeoutMs`). A store that times out or throws produces a `warnings` entry; the fan-out still returns fused results from the stores that succeeded. Total wall-clock time for the fan-out is bounded by the slowest store's timeout, not the sum of all stores (this falls out naturally from `Promise.allSettled` over concurrent calls — this task's test proves it empirically with fake timers/delays).

- [ ] **Step 1: Write the failing test**

Create `test/contextLayer.multiDbTimeout.test.js`:

```js
const { buildContext, _clearTokenCache } = require('../src/contextLayer');

function slowStore(ms, result) {
  return {
    similaritySearch: jest.fn(() => new Promise((resolve) => setTimeout(() => resolve(result), ms))),
  };
}

function throwingStore() {
  return { similaritySearch: jest.fn().mockRejectedValue(new Error('connection refused')) };
}

describe('buildContext - multi-db timeout/circuit-breaker', () => {
  beforeEach(() => { _clearTokenCache(); });

  it('a store that throws produces a warning, not a failed buildContext call', async () => {
    const goodStore = { similaritySearch: jest.fn().mockResolvedValue([{ content: 'good doc', metadata: {}, score: 0.9 }]) };
    const badStore = throwingStore();

    const result = await buildContext({
      query: 'q',
      budget: { maxTokens: 1000 },
      sources: [{ type: 'docs', stores: [goodStore, badStore], vector: [0.1], limit: 5 }],
    });

    expect(result.parts.some(p => p.content === 'good doc')).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0].error).toContain('connection refused');
  });

  it('a store that exceeds its timeout produces a warning, does not hang the whole call', async () => {
    const fastStore = { similaritySearch: jest.fn().mockResolvedValue([{ content: 'fast doc', metadata: {}, score: 0.9 }]) };
    const hangingStore = slowStore(10000, [{ content: 'never arrives', metadata: {}, score: 0.9 }]);

    const result = await buildContext({
      query: 'q',
      budget: { maxTokens: 1000 },
      sources: [{ type: 'docs', stores: [fastStore, hangingStore], vector: [0.1], limit: 5, timeoutMs: 50 }],
    });

    expect(result.parts.some(p => p.content === 'fast doc')).toBe(true);
    expect(result.parts.some(p => p.content === 'never arrives')).toBe(false);
    expect(result.warnings.some(w => String(w.error).toLowerCase().includes('timeout'))).toBe(true);
  }, 2000);

  it('total wall-clock time is bounded by the slowest allowed store, not the sum of all stores', async () => {
    const storeA = slowStore(30, [{ content: 'a', metadata: {}, score: 0.9 }]);
    const storeB = slowStore(30, [{ content: 'b', metadata: {}, score: 0.9 }]);
    const storeC = slowStore(30, [{ content: 'c', metadata: {}, score: 0.9 }]);

    const start = Date.now();
    await buildContext({
      query: 'q',
      budget: { maxTokens: 1000 },
      sources: [{ type: 'docs', stores: [storeA, storeB, storeC], vector: [0.1], limit: 5 }],
    });
    const elapsed = Date.now() - start;

    // Sequential would be >= 90ms (3x30ms); concurrent should be well under that.
    expect(elapsed).toBeLessThan(80);
  });
});
```

- [ ] **Step 2: Run and verify it fails**

Run: `npx jest test/contextLayer.multiDbTimeout.test.js`
Expected: the throwing-store test likely already passes (Task 1's `Promise.allSettled` already catches rejections) — but the timeout tests FAIL, since no timeout wrapping exists yet (the hanging-store test will actually hang/timeout the Jest test itself rather than failing cleanly — if so, that itself proves the gap; use a shorter Jest test timeout to fail fast rather than blocking).

- [ ] **Step 3: Implement the timeout wrapper**

Add a helper and use it in Task 1's fan-out call:

```js
function _withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms${label ? ` (${label})` : ''}`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}
```

In the fan-out `Promise.allSettled(stores.map(store => { ... }))`, wrap each store's call: `_withTimeout(call, source.timeoutMs || 5000, `store ${i}`)` (needs the map callback to receive the index too — change `stores.map(store => ...)` to `stores.map((store, i) => ...)`).

- [ ] **Step 4: Run and verify all pass**

Run: `npx jest test/contextLayer.multiDbTimeout.test.js`
Expected: 3 tests pass.

- [ ] **Step 5: Run the full suite, including Task 1's tests**

Run: `npx jest test/contextLayer.multiDb*.test.js && npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/contextLayer.js test/contextLayer.multiDbTimeout.test.js
git commit -m "feat: per-store timeout and circuit-breaker for multi-db fan-out, bounded by slowest allowed store"
```

---

## Self-Review Notes

- **Spec coverage**: Component 3 (Multi-db fusion) — concurrent fan-out (Task 1), RRF fusion reusing the exact existing constant/formula, per-store timeout + circuit-breaker with partial-results + warnings (Task 2).
- **Placeholder scan**: no TBD/TODO.
- **Backward compatibility**: the `items`-based docs source from Phase 2 is untouched — verified by the plan requiring the multi-store branch to `continue` past the items branch, and by running the full suite (including Phase 2's own docs-source tests) after each task.
- **Performance requirement addressed**: Task 2's third test directly measures wall-clock time to prove concurrent (not sequential) fan-out, rather than just asserting it structurally.
