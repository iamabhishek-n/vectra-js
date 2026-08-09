# Context & Memory Layer Phase 4 — vectra-js New Vector Store Backend (Weaviate) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Weaviate as the second pluggable vector store backend (Component 4 of the spec), following the same 3-task pattern established by the Pinecone backend. LanceDB and SurrealDB remain deferred.

**Architecture:** `WeaviateVectorStore` implements the same `VectorStore` interface contract as every other backend (`addDocuments`, `upsertDocuments`, `similaritySearch`, `hybridSearch`, `listDocuments`, `deleteDocuments`, `fileExists`). Unlike Pinecone, Weaviate's v3 collections client genuinely supports native hybrid search (BM25 + vector fused server-side via an `alpha` parameter) and native filter-based listing — so this backend does NOT need Pinecone's client-side RRF fallback or its "listDocuments unsupported" limitation. Weaviate also has no dummy-vector requirement for filter-only queries (`fetchObjects` takes filters without a vector).

**Tech Stack:** Matches the documented `weaviate-client` v3 collections API shape: `client.collections.get(name)` returns a collection handle with `.data.insertMany([{properties, vector}])`, `.query.nearVector(vector, {limit, filters})`, `.query.hybrid(text, {vector, limit, alpha})`, `.query.fetchObjects({limit, filters, after})`, `.data.deleteMany(filters)` / `.data.deleteById(id)`, `.data.update(id, {properties})`. This exact shape is NOT verified against a live `weaviate-client` install in this environment — flagged as an assumption needing confirmation before production use, same caveat already carried by the Pinecone backend for its upsert-namespace signature.

## Global Constraints

- Config shape matches every other backend: `config.clientInstance` (pre-initialized client), `config.tableName` (collection/class name, defaults to `'Document'`).
- Content is stored as a `content` property alongside metadata properties in the collection schema (Weaviate has real per-property schema, unlike Pinecone's single metadata bag — but this plan keeps parity with the rest of the codebase by bundling metadata as a single JSON-stringified `metadata` property plus a top-level `content` property, avoiding a schema-migration concern out of scope here).
- Score normalization: Weaviate's `nearVector` returns `distance` (cosine distance, 0 = identical). Score = `1 - distance`, matching the same higher-is-better convention as every other backend (see `MilvusVectorStore._normalizeScore` precedent).
- Native hybrid search only — no client-side RRF fallback (unlike Pinecone/Qdrant/Milvus, which fake hybrid search client-side).
- No brute-force client-side fallback for anything Weaviate natively supports (filtering, hybrid, listing).

---

### Task 1: `WeaviateVectorStore` — core CRUD + similarity search

**Files:**
- Create: `src/backends/weaviate_store.js`
- Create: `test/backends/weaviate_store.test.js`

**Interfaces:**
- Produces: `WeaviateVectorStore` class with `addDocuments`, `upsertDocuments`, `similaritySearch`.

- [ ] **Step 1: Write the failing test**

Create `test/backends/weaviate_store.test.js`:

```js
const { WeaviateVectorStore } = require('../../src/backends/weaviate_store');

function makeCollection(overrides = {}) {
  return {
    data: { insertMany: jest.fn().mockResolvedValue({}), ...overrides.data },
    query: { nearVector: jest.fn(), ...overrides.query },
  };
}

function makeConfig(collection) {
  const client = { collections: { get: jest.fn().mockReturnValue(collection) } };
  return { clientInstance: client, tableName: 'Document' };
}

describe('WeaviateVectorStore', () => {
  it('addDocuments inserts objects with content/metadata properties and a vector', async () => {
    const collection = makeCollection();
    const store = new WeaviateVectorStore(makeConfig(collection));

    await store.addDocuments([
      { id: 'doc-1', content: 'hello world', embedding: [0.1, 0.2], metadata: { source: 'a.md' } },
    ]);

    expect(collection.data.insertMany).toHaveBeenCalledTimes(1);
    const [objects] = collection.data.insertMany.mock.calls[0];
    expect(objects[0].properties.content).toBe('hello world');
    expect(objects[0].properties.metadata).toBe(JSON.stringify({ source: 'a.md' }));
    expect(objects[0].vector).toEqual([0.1, 0.2]);
  });

  it('upsertDocuments behaves the same as addDocuments (insertMany overwrites on ID collision)', async () => {
    const collection = makeCollection();
    const store = new WeaviateVectorStore(makeConfig(collection));

    await store.upsertDocuments([{ id: 'doc-1', content: 'x', embedding: [0.1], metadata: {} }]);

    expect(collection.data.insertMany).toHaveBeenCalledTimes(1);
  });

  it('similaritySearch queries nearVector and converts distance to a higher-is-better score', async () => {
    const collection = makeCollection({
      query: {
        nearVector: jest.fn().mockResolvedValue({
          objects: [
            { properties: { content: 'hello world', metadata: JSON.stringify({ source: 'a.md' }) }, metadata: { distance: 0.2 } },
          ],
        }),
      },
    });
    const store = new WeaviateVectorStore(makeConfig(collection));

    const results = await store.similaritySearch([0.1, 0.2], 5);

    expect(collection.query.nearVector).toHaveBeenCalledWith([0.1, 0.2], expect.objectContaining({ limit: 5 }));
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('hello world');
    expect(results[0].metadata.source).toBe('a.md');
    expect(results[0].score).toBeCloseTo(0.8);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/backends/weaviate_store.test.js`
Expected: FAIL — `src/backends/weaviate_store.js` doesn't exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `src/backends/weaviate_store.js`:

```js
const { VectorStore } = require('../interfaces');

class WeaviateVectorStore extends VectorStore {
  constructor(config) {
    super();
    this.config = config;
    this.client = config.clientInstance;
    this.className = config.tableName || 'Document';
    this.collection = this.client.collections.get(this.className);
  }

  _buildFilter(filter) {
    if (!filter) return undefined;
    // NOTE: the exact filter-builder API (`collection.filter.byProperty(...).equal(...)`)
    // was not verifiable against a live weaviate-client install in this environment.
    // Passing the raw filter object through assumes the caller's clientInstance mock
    // (or a future adapter) accepts a plain equality-map shape. Flagged for
    // confirmation before production use, same as the upsert-namespace assumption
    // already carried by PineconeVectorStore.
    return filter;
  }

  async addDocuments(documents) {
    const objects = documents.map(doc => ({
      id: doc.id,
      properties: { content: doc.content, metadata: JSON.stringify(doc.metadata || {}) },
      vector: doc.embedding,
    }));
    await this.collection.data.insertMany(objects);
  }

  async upsertDocuments(documents) {
    return this.addDocuments(documents);
  }

  _mapObject(o) {
    const metadata = o.properties && o.properties.metadata ? JSON.parse(o.properties.metadata) : {};
    const distance = o.metadata ? o.metadata.distance : undefined;
    return {
      content: (o.properties && o.properties.content) || '',
      metadata,
      score: typeof distance === 'number' ? 1 - distance : undefined,
    };
  }

  async similaritySearch(vector, limit = 5, filter = null) {
    const opts = { limit, returnMetadata: ['distance'] };
    const f = this._buildFilter(filter);
    if (f) opts.filters = f;
    const res = await this.collection.query.nearVector(vector, opts);
    return (res.objects || []).map(o => this._mapObject(o));
  }
}

module.exports = { WeaviateVectorStore };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/backends/weaviate_store.test.js`
Expected: 3 tests pass.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/backends/weaviate_store.js test/backends/weaviate_store.test.js
git commit -m "feat: add WeaviateVectorStore backend - core CRUD and similarity search"
```

---

### Task 2: Native hybrid search, listDocuments, deleteDocuments, fileExists

**Files:**
- Modify: `src/backends/weaviate_store.js`
- Create: `test/backends/weaviate_store.hybrid.test.js`

**Interfaces:**
- Consumes: `this.collection`, `this._mapObject`, `this._buildFilter` from Task 1.
- Produces: `hybridSearch`, `listDocuments`, `deleteDocuments`, `fileExists` on `WeaviateVectorStore`.

- [ ] **Step 1: Write the failing test**

Create `test/backends/weaviate_store.hybrid.test.js`:

```js
const { WeaviateVectorStore } = require('../../src/backends/weaviate_store');

function makeConfig(collection) {
  const client = { collections: { get: jest.fn().mockReturnValue(collection) } };
  return { clientInstance: client, tableName: 'Document' };
}

describe('WeaviateVectorStore hybrid/CRUD', () => {
  it('hybridSearch delegates to the native Weaviate hybrid query (no client-side RRF)', async () => {
    const collection = {
      query: {
        hybrid: jest.fn().mockResolvedValue({
          objects: [
            { properties: { content: 'quick fox jumps high', metadata: '{}' }, metadata: { score: 0.95 } },
          ],
        }),
      },
    };
    const store = new WeaviateVectorStore(makeConfig(collection));

    const results = await store.hybridSearch('quick fox', [0.1, 0.2], 5);

    expect(collection.query.hybrid).toHaveBeenCalledWith('quick fox', expect.objectContaining({ vector: [0.1, 0.2], limit: 5 }));
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('quick fox jumps high');
  });

  it('listDocuments fetches by filter with cursor-based pagination', async () => {
    const collection = {
      query: {
        fetchObjects: jest.fn().mockResolvedValue({
          objects: [{ uuid: 'id-1', properties: { content: 'doc a', metadata: '{}' } }],
        }),
      },
    };
    const store = new WeaviateVectorStore(makeConfig(collection));

    const [docs, cursor] = await store.listDocuments({ limit: 1 });

    expect(collection.query.fetchObjects).toHaveBeenCalledWith(expect.objectContaining({ limit: 1 }));
    expect(docs).toHaveLength(1);
    expect(docs[0].id).toBe('id-1');
    expect(cursor).toBe('id-1');
  });

  it('deleteDocuments deletes by ids', async () => {
    const collection = { data: { deleteById: jest.fn().mockResolvedValue({}) } };
    const store = new WeaviateVectorStore(makeConfig(collection));

    await store.deleteDocuments({ ids: ['doc-1', 'doc-2'] });

    expect(collection.data.deleteById).toHaveBeenCalledTimes(2);
  });

  it('fileExists queries by metadata filter without needing a dummy vector', async () => {
    const collection = {
      query: { fetchObjects: jest.fn().mockResolvedValue({ objects: [{ uuid: 'id-1', properties: {} }] }) },
    };
    const store = new WeaviateVectorStore(makeConfig(collection));

    const exists = await store.fileExists('abc123', 100, 12345);

    expect(collection.query.fetchObjects).toHaveBeenCalled();
    const [opts] = collection.query.fetchObjects.mock.calls[0];
    expect(opts.vector).toBeUndefined();
    expect(exists).toBe(true);
  });

  it('fileExists returns false when no match found', async () => {
    const collection = { query: { fetchObjects: jest.fn().mockResolvedValue({ objects: [] }) } };
    const store = new WeaviateVectorStore(makeConfig(collection));

    const exists = await store.fileExists('abc123', 100, 12345);

    expect(exists).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/backends/weaviate_store.hybrid.test.js`
Expected: FAIL — the new methods don't exist yet.

- [ ] **Step 3: Implement**

Add to `WeaviateVectorStore` in `src/backends/weaviate_store.js`:

```js
  async hybridSearch(text, vector, limit = 5, filter = null) {
    const opts = { vector, limit, alpha: 0.5, returnMetadata: ['score'] };
    const f = this._buildFilter(filter);
    if (f) opts.filters = f;
    const res = await this.collection.query.hybrid(text, opts);
    return (res.objects || []).map(o => ({
      content: (o.properties && o.properties.content) || '',
      metadata: o.properties && o.properties.metadata ? JSON.parse(o.properties.metadata) : {},
      score: o.metadata ? o.metadata.score : undefined,
    }));
  }

  async listDocuments({ filter = null, limit = 100, cursor = null } = {}) {
    const opts = { limit };
    const f = this._buildFilter(filter);
    if (f) opts.filters = f;
    if (cursor) opts.after = cursor;
    const res = await this.collection.query.fetchObjects(opts);
    const objects = res.objects || [];
    const docs = objects.map(o => ({
      id: o.uuid,
      content: (o.properties && o.properties.content) || '',
      metadata: o.properties && o.properties.metadata ? JSON.parse(o.properties.metadata) : {},
    }));
    const nextCursor = objects.length === limit ? objects[objects.length - 1].uuid : null;
    return [docs, nextCursor];
  }

  async deleteDocuments({ ids = null, filter = null } = {}) {
    if (Array.isArray(ids) && ids.length > 0) {
      await Promise.all(ids.map(id => this.collection.data.deleteById(id)));
      return;
    }
    if (filter) {
      const f = this._buildFilter(filter);
      await this.collection.data.deleteMany(f);
      return;
    }
    throw new Error('deleteDocuments requires ids or filter');
  }

  async fileExists(sha256, size, lastModified) {
    // Unlike PineconeVectorStore, Weaviate's fetchObjects takes filters without
    // requiring a placeholder vector — a genuine capability advantage over Pinecone,
    // not an oversight.
    try {
      const res = await this.collection.query.fetchObjects({
        limit: 1,
        filters: this._buildFilter({ fileSHA256: sha256, fileSize: size, lastModified }),
      });
      return (res.objects || []).length > 0;
    } catch (_) {
      return false;
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/backends/weaviate_store.hybrid.test.js`
Expected: 5 tests pass.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/backends/weaviate_store.js test/backends/weaviate_store.hybrid.test.js
git commit -m "feat: WeaviateVectorStore native hybrid search, listDocuments, delete, fileExists"
```

---

### Task 3: Wire into `createVectorStore`

**Files:**
- Modify: `src/core.js`
- Create: `test/core.weaviateWiring.test.js`

**Interfaces:**
- Produces: `createVectorStore({ type: 'weaviate', ... })` returns a `WeaviateVectorStore` instance.

- [ ] **Step 1: Read `createVectorStore`'s current dispatcher**

Read the exact current if/else chain in `core.js`'s `createVectorStore` method before editing (it now includes the `pinecone` branch added in the prior plan).

- [ ] **Step 2: Write the failing test**

Create `test/core.weaviateWiring.test.js`:

```js
const { VectraClient, ProviderType } = require('../src/core');

describe('createVectorStore - weaviate', () => {
  it('returns a WeaviateVectorStore for type "weaviate"', () => {
    const collection = { data: {}, query: {} };
    const client = { collections: { get: jest.fn().mockReturnValue(collection) } };
    const vectraClient = new VectraClient({
      embedding: { provider: ProviderType.OPENAI, apiKey: 'test-key' },
      llm: { provider: ProviderType.OPENAI, apiKey: 'test-key', modelName: 'gpt-4o-mini' },
      database: { type: 'weaviate', clientInstance: client },
    });

    expect(vectraClient.vectorStore.constructor.name).toBe('WeaviateVectorStore');
  });
});
```

- [ ] **Step 3: Run and verify it fails**

Run: `npx jest test/core.weaviateWiring.test.js`
Expected: FAIL — `Unsupported vector store type: weaviate`.

- [ ] **Step 4: Implement**

Add `const { WeaviateVectorStore } = require('./backends/weaviate_store');` to `core.js`'s imports, and add `if (t === 'weaviate') return new WeaviateVectorStore(dbConfig);` to `createVectorStore`'s if-chain.

- [ ] **Step 5: Run and verify it passes**

Run: `npx jest test/core.weaviateWiring.test.js`
Expected: 1 test passes.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/core.js test/core.weaviateWiring.test.js
git commit -m "feat: wire WeaviateVectorStore into createVectorStore"
```

---

## Self-Review Notes

- **Spec coverage**: Component 4 (New vector store backends) — Weaviate shipped as the second of four named candidates (Pinecone done, Weaviate this plan, LanceDB and SurrealDB remain deferred, same-pattern follow-ups).
- **Placeholder scan**: no TBD/TODO; the filter-builder API shape (`_buildFilter`) is explicitly flagged as an unverified assumption, same class of caveat already carried by Pinecone's upsert-namespace signature — not silently guessed.
- **Divergence from Pinecone's pattern, and why**: Weaviate genuinely supports native hybrid search and native filter-based listing, so this backend does NOT replicate Pinecone's client-side RRF fallback or its `listDocuments`-unsupported limitation. This is a real capability difference, not an inconsistency to fix.
