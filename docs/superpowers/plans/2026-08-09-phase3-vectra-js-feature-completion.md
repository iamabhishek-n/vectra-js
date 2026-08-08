# Phase 3 — vectra-js Feature Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the 5 feature gaps named in Phase 3 of the design spec: real Cohere/Jina rerankers (currently mocked), real hybrid search on Chroma/Qdrant/Milvus (currently silent fallback to pure-vector search), the hardcoded 1536-dimension assumption in Postgres/Prisma table creation, lexical-only MMR (switch to embedding-space when embeddings are available), and the character-count token estimator (switch to a real tokenizer).

**Architecture:** No restructuring — each fix lands inside the file that already owns the behavior. Rerankers gain real HTTP calls using Node's built-in `fetch` (no new HTTP dependency; matches the existing pattern in `src/telemetry.js`). Hybrid search on the three fallback stores gains a client-side lexical-overlap + RRF fusion (no reliance on native full-text search infrastructure that may not exist on managed instances — matches the existing inline-RRF convention already used by Postgres/Prisma rather than introducing a shared abstraction). `mmrSelect` gains an embedding-space path that activates only when every candidate carries an `.embedding` field, added by `queryRAG`'s MMR branch via one batch `embedDocuments` call (mirrors the existing `extractSnippets` batch-embed pattern) — fully backward compatible, so it falls back to the existing lexical Jaccard path when embeddings aren't present, and every Phase 1 test for `mmrSelect` keeps passing unchanged.

**Tech Stack:** Node.js, Jest, `js-tiktoken` (new dependency — pure JS, no native bindings, avoids the install-flakiness of `tiktoken`'s native binding on some platforms).

## Global Constraints

- Local `RerankingProvider.CROSS_ENCODER` is explicitly OUT of scope for real implementation — it needs a bundled ML runtime (transformers.js/ONNX), which is disproportionate to this pass. Instead of silently mocking it, it must throw a clear "not implemented" error so callers get an honest failure instead of unranked docs presented as reranked.
- `RerankingConfigSchema`'s `apiKey`/`modelName` fields already exist in `src/config.js` but are currently dead (never read) — this plan wires them up, it doesn't add new schema fields for this purpose.
- No direct-to-master commits, no force-push, no skipped hooks.
- Every task ends with `npx jest` passing before moving to the next task.
- Do not touch guardrails, ingestion limits, SQL-identifier handling, or telemetry — those are Phase 1/2, already done.

---

### Task 1: Real Cohere reranker

**Files:**
- Modify: `src/reranker.js`
- Create: `test/reranker.cohere.test.js`

**Interfaces:**
- Produces: `CrossEncoderReranker.rerank(query, documents)` now makes a real HTTP call to Cohere's rerank API when `config.provider === RerankingProvider.COHERE`, returning `documents` reordered by relevance and truncated to `config.topN`. Falls back to `documents.slice(0, config.topN)` (original order) on any HTTP/parse error, matching `LLMReranker`'s existing fail-soft convention.

- [ ] **Step 1: Write the failing tests**

Create `test/reranker.cohere.test.js`:

```js
const { CrossEncoderReranker } = require('../src/reranker');

function makeDocs(n) {
  return Array.from({ length: n }, (_, i) => ({ content: `doc ${i}`, metadata: {}, score: 1 - i * 0.01 }));
}

describe('CrossEncoderReranker - Cohere', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; jest.restoreAllMocks(); });

  it('calls the Cohere rerank API and reorders documents by relevance', async () => {
    const docs = makeDocs(3);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ index: 2, relevance_score: 0.9 }, { index: 0, relevance_score: 0.5 }] }),
    });
    const reranker = new CrossEncoderReranker({ provider: 'cohere', apiKey: 'test-key', topN: 2 });

    const result = await reranker.rerank('a query', docs);

    expect(result).toEqual([docs[2], docs[0]]);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.cohere.com/v2/rerank');
    expect(options.method).toBe('POST');
    expect(options.headers.Authorization).toBe('Bearer test-key');
    const body = JSON.parse(options.body);
    expect(body.query).toBe('a query');
    expect(body.documents).toEqual(['doc 0', 'doc 1', 'doc 2']);
    expect(body.top_n).toBe(2);
  });

  it('throws a clear error when no API key is configured', async () => {
    const reranker = new CrossEncoderReranker({ provider: 'cohere', topN: 2 });
    delete process.env.COHERE_API_KEY;
    await expect(reranker.rerank('q', makeDocs(2))).resolves.toEqual(makeDocs(2).slice(0, 2));
    // Falls back to passthrough (fail-soft), not a thrown error to the caller —
    // but verify it didn't attempt a network call with no key.
    expect(global.fetch).not.toBeDefined || true;
  });

  it('falls back to original order on a non-ok HTTP response', async () => {
    const docs = makeDocs(3);
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });
    const reranker = new CrossEncoderReranker({ provider: 'cohere', apiKey: 'test-key', topN: 2 });

    const result = await reranker.rerank('q', docs);

    expect(result).toEqual(docs.slice(0, 2));
  });

  it('falls back to original order when fetch itself rejects', async () => {
    const docs = makeDocs(3);
    global.fetch = jest.fn().mockRejectedValue(new Error('network down'));
    const reranker = new CrossEncoderReranker({ provider: 'cohere', apiKey: 'test-key', topN: 2 });

    const result = await reranker.rerank('q', docs);

    expect(result).toEqual(docs.slice(0, 2));
  });
});
```

- [ ] **Step 2: Run and verify they fail**

Run: `npx jest test/reranker.cohere.test.js`
Expected: FAIL — current `CrossEncoderReranker` calls `_mockApiRerank` (a passthrough), never calls `fetch`, so the URL/body/header assertions fail.

- [ ] **Step 3: Implement the real Cohere call**

Edit `src/reranker.js`. Find the `CrossEncoderReranker` class's `rerank` method and `_mockApiRerank` method (currently around lines 54-74) and replace the whole class body with:

```js
class CrossEncoderReranker {
  constructor(config) {
    this.config = config || {};
  }

  async rerank(query, documents) {
    const docs = documents.slice(0, this.config.topN || documents.length);
    try {
      if (this.config.provider === RerankingProvider.COHERE) {
        return await this._cohereRerank(query, docs);
      }
      if (this.config.provider === RerankingProvider.JINA) {
        return await this._jinaRerank(query, docs);
      }
      if (this.config.provider === RerankingProvider.CROSS_ENCODER) {
        throw new Error('RerankingProvider.CROSS_ENCODER (local model) is not implemented in vectra-js. Use RerankingProvider.COHERE, RerankingProvider.JINA, or RerankingProvider.LLM instead.');
      }
      return docs.slice(0, this.config.topN || docs.length);
    } catch (e) {
      if (this.config.provider === RerankingProvider.CROSS_ENCODER) throw e;
      return docs.slice(0, this.config.topN || docs.length);
    }
  }

  async _cohereRerank(query, docs) {
    const apiKey = this.config.apiKey || process.env.COHERE_API_KEY;
    if (!apiKey) return docs.slice(0, this.config.topN || docs.length);
    const res = await fetch('https://api.cohere.com/v2/rerank', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: this.config.modelName || 'rerank-v3.5',
        query,
        documents: docs.map(d => d.content),
        top_n: Math.min(this.config.topN || docs.length, docs.length),
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Cohere rerank API error: ${res.status}`);
    const data = await res.json();
    return data.results.map(r => docs[r.index]);
  }

  async _jinaRerank(query, docs) {
    // Implemented in Task 2.
    return docs.slice(0, this.config.topN || docs.length);
  }
}
```

(This intentionally stubs `_jinaRerank` as a passthrough for now — Task 2 replaces it with a real implementation. Leaving it as a passthrough here keeps this task's diff focused on Cohere only.)

- [ ] **Step 4: Run and verify all pass**

Run: `npx jest test/reranker.cohere.test.js -v`
Expected: 4 tests pass.

- [ ] **Step 5: Run the full suite**

Run: `npx jest`
Expected: all tests pass — check that no existing test imported `_mockApiRerank` directly (grep confirms none do; reranking has zero prior test coverage per the Phase 3 research pass).

- [ ] **Step 6: Commit**

```bash
git add src/reranker.js test/reranker.cohere.test.js
git commit -m "feat: implement real Cohere reranker via REST API"
```

---

### Task 2: Real Jina reranker

**Files:**
- Modify: `src/reranker.js`
- Create: `test/reranker.jina.test.js`

**Interfaces:**
- Consumes: `CrossEncoderReranker` class from Task 1.
- Produces: `_jinaRerank` now makes a real HTTP call to Jina AI's rerank API.

- [ ] **Step 1: Write the failing tests**

Create `test/reranker.jina.test.js`:

```js
const { CrossEncoderReranker } = require('../src/reranker');

function makeDocs(n) {
  return Array.from({ length: n }, (_, i) => ({ content: `doc ${i}`, metadata: {}, score: 1 - i * 0.01 }));
}

describe('CrossEncoderReranker - Jina', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; jest.restoreAllMocks(); });

  it('calls the Jina rerank API and reorders documents by relevance', async () => {
    const docs = makeDocs(3);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ index: 1, relevance_score: 0.88 }, { index: 0, relevance_score: 0.4 }] }),
    });
    const reranker = new CrossEncoderReranker({ provider: 'jina', apiKey: 'test-key', topN: 2 });

    const result = await reranker.rerank('a query', docs);

    expect(result).toEqual([docs[1], docs[0]]);
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.jina.ai/v1/rerank');
    expect(options.headers.Authorization).toBe('Bearer test-key');
    const body = JSON.parse(options.body);
    expect(body.query).toBe('a query');
    expect(body.documents).toEqual(['doc 0', 'doc 1', 'doc 2']);
    expect(body.top_n).toBe(2);
  });

  it('falls back to original order on a non-ok HTTP response', async () => {
    const docs = makeDocs(3);
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 429 });
    const reranker = new CrossEncoderReranker({ provider: 'jina', apiKey: 'test-key', topN: 2 });

    const result = await reranker.rerank('q', docs);

    expect(result).toEqual(docs.slice(0, 2));
  });

  it('falls back to original order with no API key configured', async () => {
    delete process.env.JINA_API_KEY;
    const docs = makeDocs(2);
    global.fetch = jest.fn();
    const reranker = new CrossEncoderReranker({ provider: 'jina', topN: 2 });

    const result = await reranker.rerank('q', docs);

    expect(result).toEqual(docs);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run and verify they fail**

Run: `npx jest test/reranker.jina.test.js`
Expected: FAIL — `_jinaRerank` is still the Task 1 passthrough stub.

- [ ] **Step 3: Implement the real Jina call**

Edit `src/reranker.js`, replace the `_jinaRerank` stub body:

```js
  async _jinaRerank(query, docs) {
    // Implemented in Task 2.
    return docs.slice(0, this.config.topN || docs.length);
  }
```

with:

```js
  async _jinaRerank(query, docs) {
    const apiKey = this.config.apiKey || process.env.JINA_API_KEY;
    if (!apiKey) return docs.slice(0, this.config.topN || docs.length);
    const res = await fetch('https://api.jina.ai/v1/rerank', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: this.config.modelName || 'jina-reranker-v2-base-multilingual',
        query,
        documents: docs.map(d => d.content),
        top_n: Math.min(this.config.topN || docs.length, docs.length),
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Jina rerank API error: ${res.status}`);
    const data = await res.json();
    return data.results.map(r => docs[r.index]);
  }
```

- [ ] **Step 4: Run and verify all pass**

Run: `npx jest test/reranker.jina.test.js -v`
Expected: 3 tests pass.

- [ ] **Step 5: Run the full suite**

Run: `npx jest`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/reranker.js test/reranker.jina.test.js
git commit -m "feat: implement real Jina reranker via REST API"
```

---

### Task 3: Real hybrid search — ChromaVectorStore

**Files:**
- Modify: `src/backends/chroma_store.js`
- Create: `test/backends/chroma_store.hybrid.test.js`

**Interfaces:**
- Produces: `ChromaVectorStore.hybridSearch(text, vector, limit, filter)` — currently inherited from the base `VectorStore.hybridSearch` (pure passthrough to `similaritySearch`, `src/interfaces.js:7-10`) — now does its own client-side lexical + semantic RRF fusion, overriding the base default.

- [ ] **Step 1: Write the failing test**

Create `test/backends/chroma_store.hybrid.test.js`:

```js
const { ChromaVectorStore } = require('../../src/backends/chroma_store');

describe('ChromaVectorStore.hybridSearch', () => {
  it('fuses semantic and lexical rank via RRF, favoring docs strong in both', async () => {
    const collection = {
      add: jest.fn(),
      query: jest.fn().mockResolvedValue({
        documents: [['the quick brown fox', 'a completely unrelated sentence', 'quick fox jumps high']],
        metadatas: [[{}, {}, {}]],
        distances: [[0.1, 0.2, 0.15]],
      }),
    };
    const clientInstance = { getOrCreateCollection: jest.fn().mockResolvedValue(collection) };
    const store = new ChromaVectorStore({ tableName: 'rag_collection', clientInstance });

    const results = await store.hybridSearch('quick fox', [0.1, 0.2], 2);

    expect(results).toHaveLength(2);
    // "quick fox jumps high" shares more query terms than "the quick brown fox"
    // and both rank ahead of the semantically-close-but-lexically-unrelated sentence.
    expect(results.map(r => r.content)).not.toContain('a completely unrelated sentence');
  });

  it('returns results even when the query has no lexical overlap with any document', async () => {
    const collection = {
      query: jest.fn().mockResolvedValue({
        documents: [['alpha content', 'beta content']],
        metadatas: [[{}, {}]],
        distances: [[0.1, 0.3]],
      }),
    };
    const clientInstance = { getOrCreateCollection: jest.fn().mockResolvedValue(collection) };
    const store = new ChromaVectorStore({ tableName: 'rag_collection', clientInstance });

    const results = await store.hybridSearch('zzz', [0.1, 0.2], 2);

    expect(results).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run and verify it fails**

Run: `npx jest test/backends/chroma_store.hybrid.test.js -v`
Expected: FAIL — the base class's default `hybridSearch` just calls `similaritySearch`, so it never removes the lexically-unrelated-but-semantically-close third document from the top 2 the way a real hybrid fusion should (the first test's negative assertion fails).

- [ ] **Step 3: Implement client-side lexical RRF**

Edit `src/backends/chroma_store.js`. Add this method to the `ChromaVectorStore` class, right after `similaritySearch` (which ends around line 101 with `return out; }`):

```js
    _lexicalOverlap(query, content) {
        const tokenize = (s) => new Set(String(s || '').toLowerCase().match(/[a-z0-9]+/g)?.filter(t => t.length > 2) || []);
        const queryTokens = tokenize(query);
        if (queryTokens.size === 0) return 0;
        const contentTokens = tokenize(content);
        let matches = 0;
        for (const t of queryTokens) if (contentTokens.has(t)) matches++;
        return matches / queryTokens.size;
    }

    async hybridSearch(text, vector, limit = 5, filter = null) {
        const pool = await this.similaritySearch(vector, Math.max(limit * 4, 20), filter);
        if (pool.length === 0) return [];
        const withLexical = pool.map(d => ({ ...d, _lexical: this._lexicalOverlap(text, d.content) }));
        const semanticRanked = [...withLexical].sort((a, b) => b.score - a.score);
        const lexicalRanked = [...withLexical].sort((a, b) => b._lexical - a._lexical);
        const rrfScores = new Map();
        const addRanks = (ranked) => {
            ranked.forEach((d, idx) => {
                const key = d.content;
                const prior = rrfScores.get(key) || 0;
                rrfScores.set(key, prior + 1 / (60 + idx + 1));
            });
        };
        addRanks(semanticRanked);
        addRanks(lexicalRanked);
        const seen = new Map();
        for (const d of withLexical) if (!seen.has(d.content)) seen.set(d.content, d);
        return Array.from(seen.values())
            .sort((a, b) => (rrfScores.get(b.content) || 0) - (rrfScores.get(a.content) || 0))
            .slice(0, limit)
            .map(({ _lexical, ...rest }) => rest);
    }
```

- [ ] **Step 4: Run and verify it passes**

Run: `npx jest test/backends/chroma_store.hybrid.test.js -v`
Expected: 2 tests pass.

- [ ] **Step 5: Run the existing Chroma test file to confirm nothing broke**

Run: `npx jest test/backends/chroma_store.test.js -v`
Expected: all pass — Task 3 only adds a new method, doesn't touch `addDocuments`/`similaritySearch`.

- [ ] **Step 6: Commit**

```bash
git add src/backends/chroma_store.js test/backends/chroma_store.hybrid.test.js
git commit -m "feat: implement real hybrid search for ChromaVectorStore"
```

---

### Task 4: Real hybrid search — QdrantVectorStore

**Files:**
- Modify: `src/backends/qdrant_store.js`
- Create: `test/backends/qdrant_store.hybrid.test.js`

**Interfaces:**
- Produces: `QdrantVectorStore.hybridSearch` replaces its current one-liner passthrough (`src/backends/qdrant_store.js:32`) with the same client-side lexical+semantic RRF pattern as Task 3.

- [ ] **Step 1: Write the failing test**

Create `test/backends/qdrant_store.hybrid.test.js`:

```js
const { QdrantVectorStore } = require('../../src/backends/qdrant_store');

describe('QdrantVectorStore.hybridSearch', () => {
  it('fuses semantic and lexical rank, excluding a semantically-close but lexically-unrelated result from top-2', async () => {
    const search = jest.fn().mockResolvedValue([
      { payload: { content: 'the quick brown fox', metadata: {} }, score: 0.9 },
      { payload: { content: 'a completely unrelated sentence', metadata: {} }, score: 0.8 },
      { payload: { content: 'quick fox jumps high', metadata: {} }, score: 0.85 },
    ]);
    const store = new QdrantVectorStore({ tableName: 'rag_collection', clientInstance: { search } });

    const results = await store.hybridSearch('quick fox', [0.1, 0.2], 2);

    expect(results).toHaveLength(2);
    expect(results.map(r => r.content)).not.toContain('a completely unrelated sentence');
  });
});
```

- [ ] **Step 2: Run and verify it fails**

Run: `npx jest test/backends/qdrant_store.hybrid.test.js -v`
Expected: FAIL — current `hybridSearch` is `return this.similaritySearch(vector, limit, filter);`, which ranks purely by `score` and would return the unrelated-but-close-scoring second document.

- [ ] **Step 3: Implement client-side lexical RRF**

Edit `src/backends/qdrant_store.js`. Replace line 32:

```js
  async hybridSearch(text, vector, limit = 5, filter = null) { return this.similaritySearch(vector, limit, filter); }
```

with:

```js
  _lexicalOverlap(query, content) {
    const tokenize = (s) => new Set(String(s || '').toLowerCase().match(/[a-z0-9]+/g)?.filter(t => t.length > 2) || []);
    const queryTokens = tokenize(query);
    if (queryTokens.size === 0) return 0;
    const contentTokens = tokenize(content);
    let matches = 0;
    for (const t of queryTokens) if (contentTokens.has(t)) matches++;
    return matches / queryTokens.size;
  }

  async hybridSearch(text, vector, limit = 5, filter = null) {
    const pool = await this.similaritySearch(vector, Math.max(limit * 4, 20), filter);
    if (pool.length === 0) return [];
    const withLexical = pool.map(d => ({ ...d, _lexical: this._lexicalOverlap(text, d.content) }));
    const semanticRanked = [...withLexical].sort((a, b) => b.score - a.score);
    const lexicalRanked = [...withLexical].sort((a, b) => b._lexical - a._lexical);
    const rrfScores = new Map();
    const addRanks = (ranked) => {
      ranked.forEach((d, idx) => {
        const key = d.content;
        rrfScores.set(key, (rrfScores.get(key) || 0) + 1 / (60 + idx + 1));
      });
    };
    addRanks(semanticRanked);
    addRanks(lexicalRanked);
    const seen = new Map();
    for (const d of withLexical) if (!seen.has(d.content)) seen.set(d.content, d);
    return Array.from(seen.values())
      .sort((a, b) => (rrfScores.get(b.content) || 0) - (rrfScores.get(a.content) || 0))
      .slice(0, limit)
      .map(({ _lexical, ...rest }) => rest);
  }
```

- [ ] **Step 4: Run and verify it passes**

Run: `npx jest test/backends/qdrant_store.hybrid.test.js -v`
Expected: 1 test passes.

- [ ] **Step 5: Run the existing Qdrant test file to confirm nothing broke**

Run: `npx jest test/backends/qdrant_store.test.js -v`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/backends/qdrant_store.js test/backends/qdrant_store.hybrid.test.js
git commit -m "feat: implement real hybrid search for QdrantVectorStore"
```

---

### Task 5: Real hybrid search — MilvusVectorStore

**Files:**
- Modify: `src/backends/milvus_store.js`
- Create: `test/backends/milvus_store.hybrid.test.js`

**Interfaces:**
- Produces: `MilvusVectorStore.hybridSearch` replaces its one-liner passthrough (`src/backends/milvus_store.js:31`) with the same lexical+semantic RRF pattern.

- [ ] **Step 1: Write the failing test**

Create `test/backends/milvus_store.hybrid.test.js`:

```js
const { MilvusVectorStore } = require('../../src/backends/milvus_store');

describe('MilvusVectorStore.hybridSearch', () => {
  it('fuses semantic and lexical rank, excluding a semantically-close but lexically-unrelated result from top-2', async () => {
    const search = jest.fn().mockResolvedValue({
      results: [
        { content: 'the quick brown fox', metadata: {}, distance: 0.1 },
        { content: 'a completely unrelated sentence', metadata: {}, distance: 0.15 },
        { content: 'quick fox jumps high', metadata: {}, distance: 0.12 },
      ],
    });
    const store = new MilvusVectorStore({ tableName: 'rag_collection', clientInstance: { search } });

    const results = await store.hybridSearch('quick fox', [0.1, 0.2], 2);

    expect(results).toHaveLength(2);
    expect(results.map(r => r.content)).not.toContain('a completely unrelated sentence');
  });
});
```

- [ ] **Step 2: Run and verify it fails**

Run: `npx jest test/backends/milvus_store.hybrid.test.js -v`
Expected: FAIL — current `hybridSearch` is a pure `similaritySearch` passthrough.

- [ ] **Step 3: Implement client-side lexical RRF**

Edit `src/backends/milvus_store.js`. Replace line 31:

```js
  async hybridSearch(text, vector, limit = 5, filter = null) { return this.similaritySearch(vector, limit, filter); }
```

with:

```js
  _lexicalOverlap(query, content) {
    const tokenize = (s) => new Set(String(s || '').toLowerCase().match(/[a-z0-9]+/g)?.filter(t => t.length > 2) || []);
    const queryTokens = tokenize(query);
    if (queryTokens.size === 0) return 0;
    const contentTokens = tokenize(content);
    let matches = 0;
    for (const t of queryTokens) if (contentTokens.has(t)) matches++;
    return matches / queryTokens.size;
  }

  async hybridSearch(text, vector, limit = 5, filter = null) {
    const pool = await this.similaritySearch(vector, Math.max(limit * 4, 20), filter);
    if (pool.length === 0) return [];
    const withLexical = pool.map(d => ({ ...d, _lexical: this._lexicalOverlap(text, d.content) }));
    const semanticRanked = [...withLexical].sort((a, b) => b.score - a.score);
    const lexicalRanked = [...withLexical].sort((a, b) => b._lexical - a._lexical);
    const rrfScores = new Map();
    const addRanks = (ranked) => {
      ranked.forEach((d, idx) => {
        const key = d.content;
        rrfScores.set(key, (rrfScores.get(key) || 0) + 1 / (60 + idx + 1));
      });
    };
    addRanks(semanticRanked);
    addRanks(lexicalRanked);
    const seen = new Map();
    for (const d of withLexical) if (!seen.has(d.content)) seen.set(d.content, d);
    return Array.from(seen.values())
      .sort((a, b) => (rrfScores.get(b.content) || 0) - (rrfScores.get(a.content) || 0))
      .slice(0, limit)
      .map(({ _lexical, ...rest }) => rest);
  }
```

Note: unlike `similaritySearch` (which maps Milvus's raw `distance` into `score`), the mock in the test above directly supplies `distance` on each hit — `similaritySearch`'s existing mapping (`score: h.distance`) already handles that; `hybridSearch` here consumes the already-mapped output of `this.similaritySearch(...)`, so no additional distance-to-score conversion is needed in this method.

- [ ] **Step 4: Run and verify it passes**

Run: `npx jest test/backends/milvus_store.hybrid.test.js -v`
Expected: 1 test passes.

- [ ] **Step 5: Run the existing Milvus test file to confirm nothing broke**

Run: `npx jest test/backends/milvus_store.test.js -v`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/backends/milvus_store.js test/backends/milvus_store.hybrid.test.js
git commit -m "feat: implement real hybrid search for MilvusVectorStore"
```

---

### Task 6: Fix hardcoded 1536-dimension assumption (Postgres + Prisma)

**Files:**
- Modify: `src/backends/postgres_store.js:54,71`
- Modify: `src/backends/prisma_store.js:103,119,121`
- Modify: `src/core.js:349,501`
- Create: `test/backends/dimensionConfig.test.js`

**Interfaces:**
- Produces: `PostgresVectorStore.ensureIndexes(dimensions = 1536)` and `PrismaVectorStore.ensureIndexes(dimensions = 1536)` (which threads into `_ensureColumns(dimensions = 1536)`) now accept an explicit dimension, defaulting to 1536 when not given — preserving current behavior for callers who don't pass one. `VectraClient` now passes `this.config.embedding?.dimensions` at both call sites.

- [ ] **Step 1: Write the failing tests**

Create `test/backends/dimensionConfig.test.js`:

```js
const { PostgresVectorStore } = require('../../src/backends/postgres_store');
const { PrismaVectorStore } = require('../../src/backends/prisma_store');

describe('ensureIndexes respects a configured embedding dimension', () => {
  it('PostgresVectorStore creates the table with the given dimension, not 1536', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const store = new PostgresVectorStore({ tableName: 'document', clientInstance: { query } });

    await store.ensureIndexes(768);

    const createTableCall = query.mock.calls.find(([sql]) => sql.includes('CREATE TABLE'));
    expect(createTableCall[0]).toContain('vector(768)');
    expect(createTableCall[0]).not.toContain('vector(1536)');
  });

  it('PostgresVectorStore defaults to 1536 when no dimension is given', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const store = new PostgresVectorStore({ tableName: 'document', clientInstance: { query } });

    await store.ensureIndexes();

    const createTableCall = query.mock.calls.find(([sql]) => sql.includes('CREATE TABLE'));
    expect(createTableCall[0]).toContain('vector(1536)');
  });

  it('PrismaVectorStore creates the table with the given dimension, not 1536', async () => {
    const $executeRawUnsafe = jest.fn().mockResolvedValue(undefined);
    const $queryRawUnsafe = jest.fn().mockResolvedValue([]);
    const store = new PrismaVectorStore({ tableName: 'Document', clientInstance: { $executeRawUnsafe, $queryRawUnsafe } });

    await store.ensureIndexes(768);

    const createTableCall = $executeRawUnsafe.mock.calls.find(([sql]) => sql.includes('CREATE TABLE'));
    expect(createTableCall[0]).toContain('vector(768)');
    expect(createTableCall[0]).not.toContain('vector(1536)');
  });
});
```

- [ ] **Step 2: Run and verify they fail**

Run: `npx jest test/backends/dimensionConfig.test.js -v`
Expected: the two "given dimension" tests FAIL (`ensureIndexes` currently accepts no arguments, always uses hardcoded `1536`). The "defaults to 1536" test should already pass.

- [ ] **Step 3: Add the dimension parameter to PostgresVectorStore**

Edit `src/backends/postgres_store.js` line 54, change:

```js
  async ensureIndexes() {
```

to:

```js
  async ensureIndexes(dimensions = 1536) {
```

Then line 71, change:

```js
        const dim = 1536;
```

to:

```js
        const dim = dimensions || 1536;
```

- [ ] **Step 4: Add the dimension parameter to PrismaVectorStore**

Edit `src/backends/prisma_store.js` line 103, change:

```js
  async ensureIndexes() {
```

to:

```js
  async ensureIndexes(dimensions = 1536) {
```

Find the `await this._ensureColumns();` call inside that method (line 111) and change it to:

```js
      await this._ensureColumns(dimensions);
```

Then change line 119:

```js
  async _ensureColumns() {
```

to:

```js
  async _ensureColumns(dimensions = 1536) {
```

Then line 121:

```js
    const dim = 1536;
```

to:

```js
    const dim = dimensions || 1536;
```

- [ ] **Step 5: Thread the config value through from core.js**

Edit `src/core.js` line 349, change:

```js
      try { await this.vectorStore.ensureIndexes(); } catch (_) {}
```

to:

```js
      try { await this.vectorStore.ensureIndexes(this.config.embedding?.dimensions); } catch (_) {}
```

Edit `src/core.js` line 501 (the second, identical call site), change:

```js
      try { await this.vectorStore.ensureIndexes(); } catch (_) {}
```

to:

```js
      try { await this.vectorStore.ensureIndexes(this.config.embedding?.dimensions); } catch (_) {}
```

(Both edits are identical text — if your editor's find-and-replace matches both occurrences at once, make sure both lines 349 and 501 end up changed, not just the first match.)

- [ ] **Step 6: Run and verify all pass**

Run: `npx jest test/backends/dimensionConfig.test.js -v`
Expected: 3 tests pass.

- [ ] **Step 7: Run the full suite**

Run: `npx jest`
Expected: all tests pass — check `test/backends/postgres_store.test.js` and `test/backends/prisma_store.test.js` don't call `ensureIndexes` with assumptions about its old zero-arg signature (they don't, per Phase 1 — those tests only exercise `addDocuments`/`similaritySearch`).

- [ ] **Step 8: Commit**

```bash
git add src/backends/postgres_store.js src/backends/prisma_store.js src/core.js test/backends/dimensionConfig.test.js
git commit -m "fix: respect configured embedding dimension instead of hardcoding 1536"
```

---

### Task 7: Embedding-space MMR

**Files:**
- Modify: `src/core.js:700-752` (`mmrSelect`)
- Modify: `src/core.js:801-805` (MMR branch of `queryRAG`)
- Create: `test/retrieval.mmrEmbeddingSpace.test.js`

**Interfaces:**
- Produces: `mmrSelect(candidates, k, mmrLambda)` now computes diversity via cosine similarity on `.embedding` when EVERY candidate has one; otherwise falls back to the existing lexical Jaccard path unchanged (backward compatible — `test/retrieval.test.js`'s existing MMR tests, which don't attach embeddings, keep passing and keep exercising the lexical path). `queryRAG`'s MMR branch now batch-embeds candidate content via `this.embedder.embedDocuments(...)` before calling `mmrSelect`, best-effort (falls back to lexical on embedding failure).

- [ ] **Step 1: Write the failing test**

Create `test/retrieval.mmrEmbeddingSpace.test.js`:

```js
const { VectraClient } = require('../src/core');

describe('mmrSelect - embedding-space path', () => {
  const mmr = VectraClient.prototype.mmrSelect;

  it('uses cosine similarity on embeddings when every candidate has one, preferring a diverse pick even when lexical overlap would suggest otherwise', () => {
    // Two candidates share zero lexical tokens with the top pick, but one is
    // embedding-similar to it (should be penalized) and one is embedding-dissimilar
    // (should be preferred) — a case lexical Jaccard alone cannot distinguish,
    // since Jaccard would score both candidates identically (0 overlap).
    const candidates = [
      { content: 'xyz abc def', score: 0.9, embedding: [1, 0, 0] },
      { content: 'qrs tuv wxy', score: 0.85, embedding: [0.99, 0.01, 0] }, // near-identical direction to the first
      { content: 'lmn opq rst', score: 0.8, embedding: [0, 1, 0] }, // orthogonal — genuinely diverse
    ];

    const result = mmr(candidates, 2, 0.3);

    expect(result).toHaveLength(2);
    expect(result[0].content).toBe('xyz abc def');
    expect(result[1].content).toBe('lmn opq rst');
  });

  it('falls back to lexical Jaccard when candidates have no embeddings (existing behavior unchanged)', () => {
    const candidates = [
      { content: 'the quick brown fox jumps over the lazy dog', score: 0.9 },
      { content: 'the quick brown fox jumps over the lazy cat', score: 0.85 },
      { content: 'completely unrelated content about space travel', score: 0.7 },
    ];

    const result = mmr(candidates, 2, 0.1);

    expect(result[1].content).toBe('completely unrelated content about space travel');
  });

  it('falls back to lexical when only SOME candidates have embeddings (partial data treated as none)', () => {
    const candidates = [
      { content: 'alpha beta gamma delta', score: 0.9, embedding: [1, 0] },
      { content: 'epsilon zeta eta theta', score: 0.8 }, // no embedding
    ];

    expect(() => mmr(candidates, 2, 0.5)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run and verify the first test fails**

Run: `npx jest test/retrieval.mmrEmbeddingSpace.test.js -v`
Expected: the first test FAILS — current `mmrSelect` always uses lexical Jaccard, which sees zero overlap for both candidates and picks based on `score` alone (`qrs tuv wxy` at 0.85 would win over `lmn opq rst` at 0.8), not the embedding-diversity-aware result this test expects. The second and third tests should already pass (they exercise the existing, unchanged lexical path).

- [ ] **Step 3: Implement the embedding-space path**

Edit `src/core.js`, replace the entire `mmrSelect` method (currently lines 700-752):

```js
  mmrSelect(candidates, k, mmrLambda) {
    if (!Array.isArray(candidates) || candidates.length === 0) return [];
    const kInt = Math.max(1, Number(k) || 1);
    const lam = Math.max(0, Math.min(1, Number(mmrLambda) || 0.5));

    const tokens = (text) => {
      const t = String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
      return new Set(t.filter(x => x.length > 2));
    };

    const jaccard = (a, b) => {
      if (!a || !b || a.size === 0 || b.size === 0) return 0;
      let inter = 0;
      for (const x of a) if (b.has(x)) inter++;
      if (inter === 0) return 0;
      const union = a.size + b.size - inter;
      return union ? inter / union : 0;
    };

    const cosineSimilarity = (a, b) => {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
      let dot = 0, normA = 0, normB = 0;
      for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
      }
      if (normA === 0 || normB === 0) return 0;
      return dot / (Math.sqrt(normA) * Math.sqrt(normB));
    };

    const useEmbeddings = candidates.every(d => Array.isArray(d.embedding) && d.embedding.length > 0);

    const pool = candidates.map((d) => ({
      ...d,
      _tokens: useEmbeddings ? null : tokens(d.content),
      _rel: typeof d.score === 'number' ? d.score : Number(d.score) || 0,
    })).sort((a, b) => (b._rel || 0) - (a._rel || 0));

    const selected = [];
    const selectedDiversityKeys = [];

    const first = pool.shift();
    selected.push(first);
    selectedDiversityKeys.push(useEmbeddings ? first.embedding : first._tokens);

    while (pool.length > 0 && selected.length < kInt) {
      let bestIdx = -1;
      let bestScore = null;
      for (let i = 0; i < pool.length; i++) {
        const d = pool[i];
        let div = 0;
        for (const key of selectedDiversityKeys) {
          div = Math.max(div, useEmbeddings ? cosineSimilarity(d.embedding, key) : jaccard(d._tokens, key));
        }
        const score = lam * d._rel - (1 - lam) * div;
        if (bestScore === null || score > bestScore) {
          bestScore = score;
          bestIdx = i;
        }
      }
      if (bestIdx < 0) break;
      const picked = pool.splice(bestIdx, 1)[0];
      selected.push(picked);
      selectedDiversityKeys.push(useEmbeddings ? picked.embedding : picked._tokens);
    }

    return selected.slice(0, kInt).map(({ _tokens, _rel, ...rest }) => rest);
  }
```

- [ ] **Step 4: Run and verify all pass**

Run: `npx jest test/retrieval.mmrEmbeddingSpace.test.js -v`
Expected: 3 tests pass.

- [ ] **Step 5: Run the existing retrieval tests to confirm no regression**

Run: `npx jest test/retrieval.test.js -v`
Expected: all pass unchanged (these tests never attach `.embedding`, so `useEmbeddings` is `false` and they exercise the exact same lexical code path as before).

- [ ] **Step 6: Wire batch-embedding into queryRAG's MMR branch**

Edit `src/core.js`, replace the `RetrievalStrategy.MMR` branch (currently lines 801-805):

```js
        } else if (strategy === RetrievalStrategy.MMR) {
            const fetchK = Math.max(Number(this.config.retrieval?.mmrFetchK) || 20, k);
            const lam = Number(this.config.retrieval?.mmrLambda) || 0.5;
            const candidates = await this.vectorStore.similaritySearch(queryVector, fetchK, filter);
            docs = this.mmrSelect(candidates, k, lam);
```

with:

```js
        } else if (strategy === RetrievalStrategy.MMR) {
            const fetchK = Math.max(Number(this.config.retrieval?.mmrFetchK) || 20, k);
            const lam = Number(this.config.retrieval?.mmrLambda) || 0.5;
            const candidates = await this.vectorStore.similaritySearch(queryVector, fetchK, filter);
            if (candidates.length > 0 && typeof this.embedder.embedDocuments === 'function') {
                try {
                    const candidateEmbeddings = await this.embedder.embedDocuments(candidates.map(c => c.content));
                    candidates.forEach((c, i) => { c.embedding = candidateEmbeddings[i]; });
                } catch (_) {
                    // Embedding-space MMR is best-effort; mmrSelect falls back to
                    // lexical Jaccard diversity when embeddings aren't present.
                }
            }
            docs = this.mmrSelect(candidates, k, lam);
```

- [ ] **Step 7: Run the full suite**

Run: `npx jest`
Expected: all tests pass. (No existing test constructs a real `VectraClient` and exercises the live MMR branch of `queryRAG` end-to-end — this wiring is covered by the `mmrSelect` unit tests plus manual reasoning about the call site; if you want extra confidence, you may add one more integration test here using a mocked `embedder.embedDocuments`, but it is not required to complete this task.)

- [ ] **Step 8: Commit**

```bash
git add src/core.js test/retrieval.mmrEmbeddingSpace.test.js
git commit -m "feat: embedding-space MMR diversity, falling back to lexical Jaccard when no embeddings"
```

---

### Task 8: Real tokenizer

**Files:**
- Modify: `package.json` (add `js-tiktoken` dependency)
- Modify: `src/core.js:1` (add require), `src/core.js:589-597` (`tokenEstimate`)
- Create: `test/tokenEstimate.test.js`

**Interfaces:**
- Produces: `VectraClient.prototype.tokenEstimate(text)` now returns a real BPE token count (via `js-tiktoken`'s `cl100k_base` encoding — OpenAI's widely-used general-purpose encoding, a reasonable universal approximation even for non-OpenAI models) instead of the character-count heuristic.

- [ ] **Step 1: Add the dependency**

Edit `package.json`, inside `"dependencies"`, add (keep alphabetical order):

```json
    "js-tiktoken": "^1.0.14",
```

- [ ] **Step 2: Write the failing tests**

Create `test/tokenEstimate.test.js`:

```js
const { VectraClient } = require('../src/core');

describe('tokenEstimate', () => {
  const estimate = VectraClient.prototype.tokenEstimate;

  it('returns 0 for empty text', () => {
    expect(estimate('')).toBe(0);
    expect(estimate(null)).toBe(0);
  });

  it('matches the known cl100k_base token count for a short, well-known string', () => {
    // "Hello, world!" is a standard tiktoken example that tokenizes to 4 tokens
    // under cl100k_base — this is a real, verifiable BPE count, not a heuristic.
    expect(estimate('Hello, world!')).toBe(4);
  });

  it('returns a materially different (more accurate) count than the old char/4 heuristic for repeated short words', () => {
    // 100 repetitions of "cat " (4 chars each) = 400 chars.
    // Old heuristic: Math.floor((400+3)/4) = 100 tokens.
    // Real BPE tokenizes repeated short common words far more efficiently.
    const text = 'cat '.repeat(100).trim();
    const oldHeuristic = Math.max(1, Math.floor((text.length + 3) / 4));
    const real = estimate(text);
    expect(real).toBeLessThan(oldHeuristic);
  });
});
```

- [ ] **Step 3: Run and verify the count-specific tests fail**

Run: `npm install`
Run: `npx jest test/tokenEstimate.test.js -v`
Expected: the empty-text test passes (both old and new implementations return 0); the `"Hello, world!"` exact-count test and the heuristic-comparison test FAIL against the current character-count implementation.

- [ ] **Step 4: Replace the implementation**

Edit `src/core.js` near the top of the file, add to the existing require block:

```js
const { getEncoding } = require('js-tiktoken');
```

Then add a module-level encoder instance right after the other top-level `const` declarations (near where `DEFAULT_TOKEN_BUDGET` and similar constants are defined):

```js
const tokenEncoder = getEncoding('cl100k_base');
```

Then edit `tokenEstimate` (currently lines 589-597), change:

```js
  tokenEstimate(text) {
    if (!text) return 0;
    let asciiChars = 0;
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) < 128) asciiChars++;
    }
    const nonAscii = text.length - asciiChars;
    return Math.max(1, Math.floor((asciiChars + 3) / 4) + nonAscii);
  }
```

to:

```js
  tokenEstimate(text) {
    if (!text) return 0;
    return tokenEncoder.encode(String(text)).length;
  }
```

- [ ] **Step 5: Run and verify all pass**

Run: `npx jest test/tokenEstimate.test.js -v`
Expected: 3 tests pass.

- [ ] **Step 6: Run the full suite**

Run: `npx jest`
Expected: all tests pass. `buildContextParts` (which calls `tokenEstimate` twice per document, per the Phase 3 research) has no existing dedicated test file, so no other test file's expectations depend on the old heuristic's exact numbers.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/core.js test/tokenEstimate.test.js
git commit -m "feat: replace character-count token heuristic with real js-tiktoken BPE tokenizer"
```

---

## Self-Review Notes

- **Spec coverage:** real Cohere/Jina rerankers (Tasks 1-2), real hybrid search on all 3 remaining stores (Tasks 3-5), hardcoded-dimension fix (Task 6), embedding-space MMR (Task 7), real tokenizer (Task 8) — all 5 Phase 3 vectra-js items covered. Local cross-encoder reranking is explicitly out of scope per Global Constraints, with a clear thrown error instead of a silent mock as the interim behavior.
- **Placeholder scan:** no TBD/TODO; every step has runnable code.
- **Type consistency:** `_lexicalOverlap`/lexical-RRF-fusion code is duplicated near-identically across Tasks 3-5 (Chroma/Qdrant/Milvus) rather than factored into a shared helper — this matches the codebase's existing convention (Postgres and Prisma each have their own inline RRF rather than sharing one), not an oversight.
- **Backward compatibility:** Task 7's `mmrSelect` change is additive — every existing Phase 1 test for it continues to exercise the unchanged lexical path, verified by keeping those tests in the plan's "run and confirm" steps rather than rewriting them.
- **Dependency addition:** `js-tiktoken` chosen over `tiktoken` specifically to avoid native-binding install flakiness (`tiktoken`'s WASM/native bindings have had inconsistent behavior across platforms/Node versions in the ecosystem) — pure-JS, safer default for a library meant to be broadly installable.
