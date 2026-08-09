# Context & Memory Layer Phase 4 — vectra-js New Vector Store Backend (Pinecone) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Pinecone as a new pluggable vector store backend (Component 4 of the spec) — the first of the candidate backends named in the design spec (Pinecone, Weaviate, LanceDB, SurrealDB). This plan ships Pinecone only; the other three are explicitly deferred as same-pattern follow-ups (not silently dropped — noted in Self-Review below), given the scope already delivered across Phases 1-3 tonight.

**Architecture:** New `src/backends/pinecone_store.js`, `class PineconeVectorStore extends VectorStore`, implementing the exact same interface contract every existing backend (Chroma/Qdrant/Milvus/Postgres/Prisma) already implements: `addDocuments`, `upsertDocuments`, `similaritySearch`, `hybridSearch` (client-side lexical-overlap + RRF, matching the existing pattern in `qdrant_store.js`/`chroma_store.js`/`milvus_store.js` exactly — Pinecone has no native full-text search), `listDocuments`, `deleteDocuments`, `fileExists`. Wired into `createVectorStore`'s dispatcher in `core.js` with `type: 'pinecone'`.

**Tech Stack:** Matches the real `@pinecone-database/pinecone` client's documented API shape: `index.upsert([{id, values, metadata}])`, `index.query({vector, topK, filter, includeMetadata: true})` → `{matches: [{id, score, metadata}]}`. Pinecone has no separate "content" field — content is stored inside `metadata.content` (the same bundling every other backend already does for its own content/metadata split, just Pinecone requires it explicitly since it only has one metadata bag).

## Global Constraints

- Match the EXACT interface contract of the existing 5 backends — no new method names, no divergent parameter order. Read `src/backends/qdrant_store.js` in full before writing anything, and mirror its shape precisely (it's the closest analog: a hosted API-based, non-SQL store).
- `hybridSearch` uses the same `_lexicalOverlap` + RRF (k=60, `1/(60+rank+1)`) client-side pattern already implemented identically in `chroma_store.js`/`qdrant_store.js`/`milvus_store.js` — copy that exact code, don't reinvent it.
- Native indexes only — Pinecone's own ANN index is used via `index.query`, no brute-force client-side fallback.
- No new dependency added to `package.json` unless verified necessary — the client is passed in via `config.clientInstance` (same pattern as every other backend: the SDK never imports/requires a specific vendor client library itself, the caller constructs and injects it).
- No direct-to-master commits, no force-push, no skipped hooks.
- Every task ends with `npm test` passing.

---

### Task 1: `PineconeVectorStore` — core CRUD + similarity search

**Files:**
- Create: `src/backends/pinecone_store.js`
- Create: `test/backends/pinecone_store.test.js`

**Interfaces:**
- Produces: `class PineconeVectorStore extends VectorStore` with constructor `(config)` — `this.client = config.clientInstance` (a Pinecone `Index` object, already scoped to the target index by the caller — matches Qdrant's `config.clientInstance` convention), `this.namespace = config.tableName || undefined` (Pinecone's closest analog to a "table" is a namespace within an index). `addDocuments`, `upsertDocuments` (alias to addDocuments, Pinecone upsert is idempotent so both map to the same call), `similaritySearch(vector, limit, filter)`.

- [ ] **Step 1: Read `qdrant_store.js` in full for the pattern to mirror**

Read `src/backends/qdrant_store.js` completely before writing any code.

- [ ] **Step 2: Write the failing tests**

Create `test/backends/pinecone_store.test.js`:

```js
const { PineconeVectorStore } = require('../../src/backends/pinecone_store');

function makeConfig(client) {
  return { clientInstance: client, tableName: 'my-namespace' };
}

describe('PineconeVectorStore', () => {
  it('addDocuments upserts vectors with content bundled into metadata', async () => {
    const client = { upsert: jest.fn().mockResolvedValue() };
    const store = new PineconeVectorStore(makeConfig(client));

    await store.addDocuments([
      { id: 'doc-1', content: 'hello world', embedding: [0.1, 0.2], metadata: { source: 'a.md' } },
    ]);

    expect(client.upsert).toHaveBeenCalledTimes(1);
    const [vectors] = client.upsert.mock.calls[0];
    expect(vectors[0].id).toBe('doc-1');
    expect(vectors[0].values).toEqual([0.1, 0.2]);
    expect(vectors[0].metadata.content).toBe('hello world');
    expect(vectors[0].metadata.source).toBe('a.md');
  });

  it('upsertDocuments behaves the same as addDocuments (Pinecone upsert is idempotent)', async () => {
    const client = { upsert: jest.fn().mockResolvedValue() };
    const store = new PineconeVectorStore(makeConfig(client));

    await store.upsertDocuments([{ id: 'doc-1', content: 'x', embedding: [0.1], metadata: {} }]);

    expect(client.upsert).toHaveBeenCalledTimes(1);
  });

  it('similaritySearch queries and unbundles content back out of metadata', async () => {
    const client = {
      query: jest.fn().mockResolvedValue({
        matches: [
          { id: 'doc-1', score: 0.95, metadata: { content: 'hello world', source: 'a.md' } },
        ],
      }),
    };
    const store = new PineconeVectorStore(makeConfig(client));

    const results = await store.similaritySearch([0.1, 0.2], 5, { source: 'a.md' });

    expect(client.query).toHaveBeenCalledWith(expect.objectContaining({
      vector: [0.1, 0.2],
      topK: 5,
      includeMetadata: true,
    }));
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('hello world');
    expect(results[0].metadata.source).toBe('a.md');
    expect(results[0].score).toBe(0.95);
    expect(results[0].metadata.content).toBeUndefined(); // unbundled, not duplicated into metadata
  });
});
```

- [ ] **Step 3: Run and verify they fail**

Run: `npx jest test/backends/pinecone_store.test.js`
Expected: FAIL — `src/backends/pinecone_store.js` doesn't exist yet.

- [ ] **Step 4: Implement**

Create `src/backends/pinecone_store.js`:

```js
const { VectorStore } = require('../interfaces');

class PineconeVectorStore extends VectorStore {
  constructor(config) {
    super();
    this.config = config;
    this.client = config.clientInstance;
    this.namespace = config.tableName || undefined;
  }

  async addDocuments(documents) {
    const vectors = documents.map(doc => ({
      id: doc.id,
      values: doc.embedding,
      metadata: { ...doc.metadata, content: doc.content },
    }));
    await this.client.upsert(vectors, this.namespace ? { namespace: this.namespace } : undefined);
  }

  async upsertDocuments(documents) {
    return this.addDocuments(documents);
  }

  async similaritySearch(vector, limit = 5, filter = null) {
    const queryOpts = { vector, topK: limit, includeMetadata: true };
    if (filter) queryOpts.filter = filter;
    if (this.namespace) queryOpts.namespace = this.namespace;
    const res = await this.client.query(queryOpts);
    return (res.matches || []).map(m => {
      const { content, ...metadata } = m.metadata || {};
      return { content: content || '', metadata, score: m.score };
    });
  }
}

module.exports = { PineconeVectorStore };
```

Note: `client.upsert(vectors, opts)` call signature above assumes a specific arg shape for namespace passthrough — before finalizing, check whether the REAL `@pinecone-database/pinecone` SDK's `index.upsert()` takes namespace as a second positional arg, as part of the vectors array wrapper, or via a namespaced sub-client (`index.namespace(ns).upsert(...)`) — since this plan is written without live access to install and inspect the real package, use your best verified knowledge of the current Pinecone Node SDK's actual method signature (check its published TypeScript types/README if you have any way to verify, otherwise document the assumption clearly in a comment and keep the test's mock consistent with whatever shape you choose — the test doesn't have to match a specific real signature since `client` is fully mocked, but code comments should flag this as unverified-against-the-real-SDK).

- [ ] **Step 5: Run and verify all pass**

Run: `npx jest test/backends/pinecone_store.test.js`
Expected: 3 tests pass.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/backends/pinecone_store.js test/backends/pinecone_store.test.js
git commit -m "feat: add PineconeVectorStore backend - core CRUD and similarity search"
```

---

### Task 2: Hybrid search, listDocuments, deleteDocuments, fileExists

**Files:**
- Modify: `src/backends/pinecone_store.js`
- Create: `test/backends/pinecone_store.hybrid.test.js`

**Interfaces:**
- Produces: `hybridSearch(text, vector, limit, filter)` — copy the exact `_lexicalOverlap` + RRF pattern from `qdrant_store.js` verbatim, operating on `similaritySearch`'s pool. `listDocuments`, `deleteDocuments`, `fileExists` following the same method signatures as every other backend.

- [ ] **Step 1: Write the failing tests**

Create `test/backends/pinecone_store.hybrid.test.js`:

```js
const { PineconeVectorStore } = require('../../src/backends/pinecone_store');

function makeConfig(client) {
  return { clientInstance: client, tableName: 'ns' };
}

describe('PineconeVectorStore hybrid/CRUD', () => {
  it('hybridSearch fuses semantic and lexical rank, filtering out lexically-unrelated high-score matches', async () => {
    const client = {
      query: jest.fn().mockResolvedValue({
        matches: [
          { id: '1', score: 0.9, metadata: { content: 'the quick brown fox' } },
          { id: '2', score: 0.85, metadata: { content: 'a completely unrelated sentence' } },
          { id: '3', score: 0.8, metadata: { content: 'quick fox jumps high' } },
        ],
      }),
    };
    const store = new PineconeVectorStore(makeConfig(client));

    const results = await store.hybridSearch('quick fox', [0.1, 0.2], 2);

    expect(results).toHaveLength(2);
    const contents = results.map(r => r.content);
    expect(contents).not.toContain('a completely unrelated sentence');
  });

  it('deleteDocuments deletes by ids', async () => {
    const client = { deleteMany: jest.fn().mockResolvedValue() };
    const store = new PineconeVectorStore(makeConfig(client));

    await store.deleteDocuments({ ids: ['doc-1', 'doc-2'] });

    expect(client.deleteMany).toHaveBeenCalled();
  });

  it('fileExists queries by metadata filter and returns a boolean', async () => {
    const client = {
      query: jest.fn().mockResolvedValue({ matches: [{ id: '1', score: 1, metadata: {} }] }),
    };
    const store = new PineconeVectorStore(makeConfig(client));

    const exists = await store.fileExists('abc123', 100, 12345);

    expect(exists).toBe(true);
  });

  it('fileExists returns false when no match found', async () => {
    const client = { query: jest.fn().mockResolvedValue({ matches: [] }) };
    const store = new PineconeVectorStore(makeConfig(client));

    const exists = await store.fileExists('abc123', 100, 12345);

    expect(exists).toBe(false);
  });
});
```

- [ ] **Step 2: Run and verify they fail**

Run: `npx jest test/backends/pinecone_store.hybrid.test.js`
Expected: FAIL — methods not implemented.

- [ ] **Step 3: Implement**

Add to `PineconeVectorStore`:

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

  async listDocuments({ filter = null, limit = 100, cursor = null } = {}) {
    throw new Error('listDocuments is not supported for Pinecone — the API has no arbitrary listing/scroll endpoint. Use fileExists or similaritySearch with a broad query instead.');
  }

  async deleteDocuments({ ids = null, filter = null } = {}) {
    if (Array.isArray(ids) && ids.length > 0) {
      await this.client.deleteMany(ids);
      return;
    }
    if (filter) {
      await this.client.deleteMany({ filter });
      return;
    }
    throw new Error('deleteDocuments requires ids or filter');
  }

  async fileExists(sha256, size, lastModified) {
    try {
      const res = await this.client.query({
        vector: new Array(1).fill(0), // dummy vector — metadata-filter-only existence check
        topK: 1,
        filter: { fileSHA256: sha256, fileSize: size, lastModified },
        includeMetadata: false,
      });
      return (res.matches || []).length > 0;
    } catch (_) {
      return false;
    }
  }
```

Note the `fileExists` dummy-vector approach is a real limitation of Pinecone's query-only API (no pure metadata-filter listing without a vector) — document this honestly rather than pretending it's equivalent to the SQL-backed stores' exact `COUNT`-based check; the dummy vector of the right dimensionality is a hack if the real index has a fixed dimension other than 1, so this needs the caller's embedding dimension — check `this.config.dimensions` if available and default the dummy vector's length accordingly, or read the actual query vector length requirement from context; if genuinely unavailable at this layer, document the limitation clearly in a code comment rather than guessing a dimension that will error against a real index.

- [ ] **Step 4: Run and verify all pass**

Run: `npx jest test/backends/pinecone_store.hybrid.test.js`
Expected: 4 tests pass.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/backends/pinecone_store.js test/backends/pinecone_store.hybrid.test.js
git commit -m "feat: PineconeVectorStore hybrid search, delete, and fileExists"
```

---

### Task 3: Wire into `createVectorStore`

**Files:**
- Modify: `src/core.js`
- Create: `test/core.pineconeWiring.test.js`

**Interfaces:**
- Produces: `createVectorStore({ type: 'pinecone', ... })` returns a `PineconeVectorStore` instance.

- [ ] **Step 1: Read `createVectorStore`'s current dispatcher**

Read the exact current if/else chain in `core.js`'s `createVectorStore` method before editing.

- [ ] **Step 2: Write the failing test**

Create `test/core.pineconeWiring.test.js`:

```js
const { VectraClient, ProviderType } = require('../src/core');

describe('createVectorStore - pinecone', () => {
  it('returns a PineconeVectorStore for type "pinecone"', () => {
    const client = new VectraClient({
      embedding: { provider: ProviderType.OPENAI, apiKey: 'test-key' },
      llm: { provider: ProviderType.OPENAI, apiKey: 'test-key', modelName: 'gpt-4o-mini' },
      database: { type: 'pinecone', clientInstance: { query: jest.fn(), upsert: jest.fn() } },
    });

    expect(client.vectorStore.constructor.name).toBe('PineconeVectorStore');
  });
});
```

- [ ] **Step 3: Run and verify it fails**

Run: `npx jest test/core.pineconeWiring.test.js`
Expected: FAIL — `Unsupported vector store type: pinecone`.

- [ ] **Step 4: Implement**

Add `const { PineconeVectorStore } = require('./backends/pinecone_store');` to `core.js`'s imports, and add `if (t === 'pinecone') return new PineconeVectorStore(dbConfig);` to `createVectorStore`'s if-chain.

- [ ] **Step 5: Run and verify it passes**

Run: `npx jest test/core.pineconeWiring.test.js`
Expected: 1 test passes.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/core.js test/core.pineconeWiring.test.js
git commit -m "feat: wire PineconeVectorStore into createVectorStore"
```

---

## Self-Review Notes

- **Spec coverage**: Component 4 (New vector store backends) — Pinecone shipped as the first of four named candidates (Pinecone, Weaviate, LanceDB, SurrealDB). **Weaviate, LanceDB, and SurrealDB are explicitly deferred, not silently dropped** — same-pattern follow-up work (copy this plan's structure: CRUD + hybrid + wiring, 3 tasks each) given the scope already delivered across Phases 1-3 in this session.
- **Placeholder scan**: no TBD/TODO; the two genuinely-unverifiable-without-live-SDK-access items (exact `upsert` namespace signature, `fileExists`'s dummy-vector dimensionality) are explicitly flagged as assumptions needing verification against the real `@pinecone-database/pinecone` package, not silently guessed.
- **Interface consistency**: matches the existing 5 backends' method names/signatures exactly, verified against `qdrant_store.js` as the closest analog.
