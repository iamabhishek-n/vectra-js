# Phase 1 — vectra-js Trust & Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give vectra-js a real test suite, an MIT license with no contradictions, and telemetry that's off by default — the three blocking items from Phase 1 of the cross-repo design spec that apply to this repo.

**Architecture:** No architectural changes. This plan adds a Jest test suite covering the pure algorithmic core (RRF, MMR), the SQL-identifier safety helpers, config validation, telemetry gating, and one integration-style test per vector-store backend using a mocked `clientInstance`. It also flips the telemetry default from opt-out to opt-in, and replaces the GPL-3.0 license with MIT.

**Tech Stack:** Node.js (CommonJS), Jest for testing, Zod (already a dependency) for config validation.

## Global Constraints

- License target: MIT, exactly as decided in `docs/superpowers/specs/2026-08-06-vectra-productization-design.md`.
- No direct-to-master commits, no force-push, no skipped hooks (standing session rule).
- Every task ends with tests passing (`npx jest <file>`) before moving to the next task.
- Do not touch reranking, guardrail enforcement, hybrid search, or hardcoded-dimension issues — those are Phase 2/3 scope, not this plan.

---

### Task 1: Test framework setup

**Files:**
- Create: `jest.config.js`
- Modify: `package.json:6-11` (scripts block)
- Modify: `package.json:57-66` (devDependencies block)

**Interfaces:**
- Produces: `npx jest` runs the suite; `npx jest <path>` runs a single file. All later tasks in this plan assume this is in place.

- [ ] **Step 1: Add Jest as a devDependency**

Edit `package.json`, inside `"devDependencies"`, add (keep the list alphabetical with the existing entries):

```json
    "jest": "^29.7.0",
```

- [ ] **Step 2: Replace the stub test script**

Edit `package.json` line 7, change:

```json
    "test": "echo \"Error: no test specified\" && exit 1",
```

to:

```json
    "test": "jest",
```

- [ ] **Step 3: Create the Jest config**

Create `jest.config.js`:

```js
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/test/**/*.test.js'],
};
```

- [ ] **Step 4: Install and verify**

Run: `npm install`
Run: `npx jest`
Expected: "No tests found" (exit code 1 is fine here — there are no test files yet; this just confirms Jest itself runs).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json jest.config.js
git commit -m "test: add Jest test runner"
```

---

### Task 2: RRF and MMR unit tests

**Files:**
- Create: `test/retrieval.test.js`

**Interfaces:**
- Consumes: `VectraClient.prototype.reciprocalRankFusion(docLists, k=60)` and `VectraClient.prototype.mmrSelect(candidates, k, mmrLambda)` from `src/core.js:679` and `src/core.js:694`. Both are pure — neither reads `this` — so they can be called directly off the prototype without constructing a client.

- [ ] **Step 1: Write the failing tests**

Create `test/retrieval.test.js`:

```js
const { VectraClient } = require('../src/core');

describe('reciprocalRankFusion', () => {
  const rrf = VectraClient.prototype.reciprocalRankFusion;

  it('merges two ranked lists and favors docs that appear in both', () => {
    const listA = [{ content: 'alpha' }, { content: 'beta' }];
    const listB = [{ content: 'beta' }, { content: 'gamma' }];
    const result = rrf([listA, listB]);
    expect(result.map(d => d.content)).toEqual(['beta', 'alpha', 'gamma']);
  });

  it('returns an empty array for empty input', () => {
    expect(rrf([])).toEqual([]);
  });

  it('deduplicates by content, keeping the first-seen doc object', () => {
    const listA = [{ content: 'same', tag: 'first' }];
    const listB = [{ content: 'same', tag: 'second' }];
    const result = rrf([listA, listB]);
    expect(result).toHaveLength(1);
    expect(result[0].tag).toBe('first');
  });
});

describe('mmrSelect', () => {
  const mmr = VectraClient.prototype.mmrSelect;

  it('returns an empty array for empty candidates', () => {
    expect(mmr([], 5, 0.5)).toEqual([]);
  });

  it('always includes the highest-scoring candidate first', () => {
    const candidates = [
      { content: 'low score doc about cats', score: 0.2 },
      { content: 'high score doc about dogs', score: 0.9 },
    ];
    const result = mmr(candidates, 2, 0.5);
    expect(result[0].content).toBe('high score doc about dogs');
  });

  it('prefers a diverse second pick over a near-duplicate of the first', () => {
    const candidates = [
      { content: 'the quick brown fox jumps over the lazy dog', score: 0.9 },
      { content: 'the quick brown fox jumps over the lazy cat', score: 0.85 },
      { content: 'completely unrelated content about space travel', score: 0.7 },
    ];
    const result = mmr(candidates, 2, 0.9);
    expect(result).toHaveLength(2);
    expect(result[1].content).toBe('completely unrelated content about space travel');
  });

  it('respects the k limit', () => {
    const candidates = Array.from({ length: 10 }, (_, i) => ({
      content: `doc number ${i} with unique words ${i}${i}${i}`,
      score: 1 - i * 0.05,
    }));
    const result = mmr(candidates, 3, 0.5);
    expect(result).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run and verify all pass**

Run: `npx jest test/retrieval.test.js -v`
Expected: 8 tests pass (no implementation changes needed — this task only adds coverage for existing behavior).

- [ ] **Step 3: Commit**

```bash
git add test/retrieval.test.js
git commit -m "test: cover reciprocalRankFusion and mmrSelect"
```

---

### Task 3: SQL identifier safety — export and test

**Files:**
- Modify: `src/backends/postgres_store.js:243`
- Modify: `src/backends/prisma_store.js:215`
- Create: `test/backends/sqlIdentifier.test.js`

**Interfaces:**
- Produces: `require('../../src/backends/postgres_store')` and `require('../../src/backends/prisma_store')` now also export `isSafeIdentifier` and `quoteIdentifier` (postgres also exports `quoteTableName`, prisma also exports `quoteTableName`) in addition to their existing store class exports.

- [ ] **Step 1: Export the helpers from postgres_store.js**

Edit `src/backends/postgres_store.js` line 243, change:

```js
module.exports = { PostgresVectorStore };
```

to:

```js
module.exports = { PostgresVectorStore, isSafeIdentifier, quoteIdentifier, quoteTableName };
```

- [ ] **Step 2: Export the helpers from prisma_store.js**

Edit `src/backends/prisma_store.js` line 215, change:

```js
module.exports = { PrismaVectorStore };
```

to:

```js
module.exports = { PrismaVectorStore, isSafeIdentifier, quoteIdentifier, quoteTableName };
```

- [ ] **Step 3: Write the failing tests**

Create `test/backends/sqlIdentifier.test.js`:

```js
const postgres = require('../../src/backends/postgres_store');
const prisma = require('../../src/backends/prisma_store');

describe.each([
  ['postgres_store', postgres],
  ['prisma_store', prisma],
])('%s SQL identifier safety', (_name, mod) => {
  it('accepts a plain alphanumeric identifier', () => {
    expect(mod.isSafeIdentifier('content')).toBe(true);
    expect(mod.isSafeIdentifier('_private_col')).toBe(true);
  });

  it('rejects identifiers containing SQL metacharacters', () => {
    expect(mod.isSafeIdentifier('content"; DROP TABLE users; --')).toBe(false);
    expect(mod.isSafeIdentifier("content' OR '1'='1")).toBe(false);
    expect(mod.isSafeIdentifier('content column')).toBe(false);
  });

  it('rejects an identifier starting with a digit', () => {
    expect(mod.isSafeIdentifier('1content')).toBe(false);
  });

  it('quoteIdentifier wraps a safe value in double quotes', () => {
    expect(mod.quoteIdentifier('content', 'test')).toBe('"content"');
  });

  it('quoteIdentifier throws on an unsafe value', () => {
    expect(() => mod.quoteIdentifier('a"; DROP TABLE x; --', 'test')).toThrow('Unsafe SQL identifier');
  });

  it('quoteTableName accepts a plain table name', () => {
    expect(mod.quoteTableName('documents', 'test')).toBe('"documents"');
  });

  it('quoteTableName accepts a schema-qualified table name', () => {
    expect(mod.quoteTableName('public.documents', 'test')).toBe('"public"."documents"');
  });

  it('quoteTableName throws on an injection attempt', () => {
    expect(() => mod.quoteTableName('documents"; DROP TABLE users; --', 'test')).toThrow('Unsafe SQL identifier');
  });

  it('quoteTableName throws on more than one dot-separated part', () => {
    expect(() => mod.quoteTableName('a.b.c', 'test')).toThrow('Unsafe SQL identifier');
  });
});
```

- [ ] **Step 4: Run and verify all pass**

Run: `npx jest test/backends/sqlIdentifier.test.js -v`
Expected: 18 tests pass (9 assertions × 2 modules).

- [ ] **Step 5: Commit**

```bash
git add src/backends/postgres_store.js src/backends/prisma_store.js test/backends/sqlIdentifier.test.js
git commit -m "test: export and cover SQL identifier safety helpers"
```

---

### Task 4: Config validation tests, telemetry default-off, telemetry tests

**Files:**
- Modify: `src/config.js:110-112`
- Modify: `src/telemetry.js:23`, `src/telemetry.js:37-51`
- Create: `test/config.test.js`
- Create: `test/telemetry.test.js`

**Interfaces:**
- Consumes: `RAGConfigSchema` from `src/config.js` (exported alongside `ProviderType` etc. — confirm via `require('../src/config')`).
- Produces: `telemetry.enabled` is `false` by default after `new TelemetryManager()`, and stays `false` after `init(config)` unless `config.telemetry.enabled === true`.

- [ ] **Step 1: Flip the telemetry config default to false**

Edit `src/config.js` lines 110-112, change:

```js
  telemetry: z.object({
    enabled: z.boolean().default(true),
  }).default({ enabled: true }),
```

to:

```js
  telemetry: z.object({
    enabled: z.boolean().default(false),
  }).default({ enabled: false }),
```

- [ ] **Step 2: Flip the TelemetryManager default and require explicit opt-in**

Edit `src/telemetry.js` line 23, change:

```js
    this.enabled = true;
```

to:

```js
    this.enabled = false;
```

Edit `src/telemetry.js` lines 40-51, change:

```js
    if (config.telemetry?.enabled === false) {
      this.enabled = false;
      return;
    }

    if (
      process.env.VECTRA_TELEMETRY_DISABLED === '1' ||
      process.env.DO_NOT_TRACK === '1'
    ) {
      this.enabled = false;
      return;
    }
```

to:

```js
    if (config.telemetry?.enabled !== true) {
      this.enabled = false;
      return;
    }

    if (
      process.env.VECTRA_TELEMETRY_DISABLED === '1' ||
      process.env.DO_NOT_TRACK === '1'
    ) {
      this.enabled = false;
      return;
    }
```

- [ ] **Step 3: Write the telemetry test**

Create `test/telemetry.test.js`. `src/telemetry.js` exports a singleton instance directly (`module.exports = new TelemetryManager()`), so each test calls `jest.resetModules()` first to get a fresh instance with untouched constructor defaults:

```js
describe('telemetry default-off behavior', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('is disabled by construction, before init() is ever called', () => {
    const mgr = require('../src/telemetry');
    expect(mgr.enabled).toBe(false);
  });

  it('stays disabled when init() is called with no config', () => {
    const mgr = require('../src/telemetry');
    mgr.init();
    expect(mgr.enabled).toBe(false);
  });

  it('stays disabled when telemetry.enabled is omitted from config', () => {
    const mgr = require('../src/telemetry');
    mgr.init({ telemetry: {} });
    expect(mgr.enabled).toBe(false);
  });

  it('enables only when telemetry.enabled is explicitly true', () => {
    jest.resetModules();
    jest.spyOn(require('fs'), 'existsSync').mockReturnValue(false);
    jest.spyOn(require('fs'), 'mkdirSync').mockImplementation(() => {});
    jest.spyOn(require('fs'), 'writeFileSync').mockImplementation(() => {});
    const mgr = require('../src/telemetry');
    mgr.init({ telemetry: { enabled: true } });
    expect(mgr.enabled).toBe(true);
    jest.restoreAllMocks();
  });

  it('stays disabled when VECTRA_TELEMETRY_DISABLED=1 even if config says enabled', () => {
    jest.resetModules();
    process.env.VECTRA_TELEMETRY_DISABLED = '1';
    const mgr = require('../src/telemetry');
    mgr.init({ telemetry: { enabled: true } });
    expect(mgr.enabled).toBe(false);
    delete process.env.VECTRA_TELEMETRY_DISABLED;
  });
});
```

*(Note: `src/telemetry.js` exports a singleton instance, not the class — confirm this against `module.exports` at the bottom of the file before running; if it exports the class instead, replace `require('../src/telemetry')` with `new (require('../src/telemetry'))()` in each test above.)*

- [ ] **Step 4: Write the config validation test**

Create `test/config.test.js`:

```js
const { RAGConfigSchema, ProviderType } = require('../src/config');

const minimalConfig = {
  embedding: { provider: ProviderType.OPENAI, apiKey: 'test-key' },
  llm: { provider: ProviderType.OPENAI, apiKey: 'test-key', modelName: 'gpt-4o-mini' },
  database: { type: 'chroma', clientInstance: {} },
};

describe('RAGConfigSchema', () => {
  it('accepts a minimal valid config and fills in defaults', () => {
    const parsed = RAGConfigSchema.parse(minimalConfig);
    expect(parsed.embedding.modelName).toBe('text-embedding-3-small');
    expect(parsed.telemetry.enabled).toBe(false);
    expect(parsed.database.columnMap).toEqual({ content: 'content', vector: 'vector', metadata: 'metadata' });
  });

  it('rejects a config missing the embedding provider', () => {
    const bad = { ...minimalConfig, embedding: { apiKey: 'test-key' } };
    expect(() => RAGConfigSchema.parse(bad)).toThrow();
  });

  it('rejects a config missing the database type', () => {
    const bad = { ...minimalConfig, database: { clientInstance: {} } };
    expect(() => RAGConfigSchema.parse(bad)).toThrow();
  });

  it('rejects an agentic chunking strategy with no agenticLlm', () => {
    const bad = { ...minimalConfig, chunking: { strategy: 'agentic' } };
    expect(() => RAGConfigSchema.parse(bad)).toThrow('agenticLlm required');
  });

  it('rejects a HyDE retrieval strategy with no llmConfig', () => {
    const bad = { ...minimalConfig, retrieval: { strategy: 'hyde' } };
    expect(() => RAGConfigSchema.parse(bad)).toThrow('llmConfig required');
  });
});
```

- [ ] **Step 5: Run and verify all pass**

Run: `npx jest test/config.test.js test/telemetry.test.js -v`
Expected: all tests pass. If `RAGConfigSchema`/`ProviderType` aren't currently exported from `src/config.js`, add them to its `module.exports` before this step (check the bottom of the file first — do not add a duplicate export if they're already there).

- [ ] **Step 6: Commit**

```bash
git add src/config.js src/telemetry.js test/config.test.js test/telemetry.test.js
git commit -m "fix: default telemetry off, opt-in only; add config and telemetry tests"
```

---

### Task 5: Postgres backend integration test

**Files:**
- Create: `test/backends/postgres_store.test.js`

**Interfaces:**
- Consumes: `PostgresVectorStore` from `src/backends/postgres_store.js:20-38` (constructor throws if `config.clientInstance` is missing), `addDocuments(docs)` at line 91, `similaritySearch(vector, limit, filter)` at line 128.

- [ ] **Step 1: Write the failing test**

Create `test/backends/postgres_store.test.js`:

```js
const { PostgresVectorStore } = require('../../src/backends/postgres_store');

describe('PostgresVectorStore', () => {
  it('throws when constructed without a clientInstance', () => {
    expect(() => new PostgresVectorStore({ tableName: 'document' })).toThrow('clientInstance');
  });

  it('addDocuments issues one parameterized INSERT per document', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const store = new PostgresVectorStore({ tableName: 'document', clientInstance: { query } });

    await store.addDocuments([
      { id: 'doc-1', content: 'hello world', metadata: { a: 1 }, embedding: [0.1, 0.2, 0.3] },
    ]);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('INSERT INTO "document"');
    expect(params[0]).toBe('doc-1');
    expect(params[1]).toBe('hello world');
  });

  it('similaritySearch returns mapped results from the query rows', async () => {
    const query = jest.fn().mockResolvedValue({
      rows: [{ content: 'hello world', metadata: { a: 1 }, score: 0.87 }],
    });
    const store = new PostgresVectorStore({ tableName: 'document', clientInstance: { query } });

    const results = await store.similaritySearch([0.1, 0.2, 0.3], 5);

    expect(results).toEqual([{ content: 'hello world', metadata: { a: 1 }, score: 0.87 }]);
    expect(query.mock.calls[0][0]).toContain('ORDER BY');
  });
});
```

- [ ] **Step 2: Run and verify all pass**

Run: `npx jest test/backends/postgres_store.test.js -v`
Expected: 3 tests pass.

- [ ] **Step 3: Commit**

```bash
git add test/backends/postgres_store.test.js
git commit -m "test: add PostgresVectorStore integration test"
```

---

### Task 6: Prisma backend integration test

**Files:**
- Create: `test/backends/prisma_store.test.js`

**Interfaces:**
- Consumes: `PrismaVectorStore` from `src/backends/prisma_store.js:20-31`, `addDocuments(docs)` at line 36, `similaritySearch(vector, limit, filter)` at line 64.

- [ ] **Step 1: Write the failing test**

Create `test/backends/prisma_store.test.js`:

```js
const { PrismaVectorStore } = require('../../src/backends/prisma_store');

describe('PrismaVectorStore', () => {
  it('rejects an unsafe table name at construction', () => {
    const clientInstance = { $executeRawUnsafe: jest.fn(), $queryRawUnsafe: jest.fn() };
    expect(() => new PrismaVectorStore({ tableName: 'a"; DROP TABLE x; --', clientInstance }))
      .toThrow('Unsafe SQL identifier');
  });

  it('addDocuments issues one $executeRawUnsafe call per document', async () => {
    const $executeRawUnsafe = jest.fn().mockResolvedValue(undefined);
    const store = new PrismaVectorStore({ tableName: 'Document', clientInstance: { $executeRawUnsafe } });

    await store.addDocuments([
      { id: 'doc-1', content: 'hello world', metadata: { a: 1 }, embedding: [0.3, 0.4] },
    ]);

    expect($executeRawUnsafe).toHaveBeenCalledTimes(1);
    const [sql, id, content] = $executeRawUnsafe.mock.calls[0];
    expect(sql).toContain('INSERT INTO "Document"');
    expect(id).toBe('doc-1');
    expect(content).toBe('hello world');
  });

  it('similaritySearch returns mapped results from $queryRawUnsafe', async () => {
    const $queryRawUnsafe = jest.fn().mockResolvedValue([{ content: 'hello world', metadata: { a: 1 }, score: 0.9 }]);
    const store = new PrismaVectorStore({ tableName: 'Document', clientInstance: { $queryRawUnsafe } });

    const results = await store.similaritySearch([0.3, 0.4], 5);

    expect(results).toEqual([{ content: 'hello world', metadata: { a: 1 }, score: 0.9 }]);
  });
});
```

- [ ] **Step 2: Run and verify all pass**

Run: `npx jest test/backends/prisma_store.test.js -v`
Expected: 3 tests pass.

- [ ] **Step 3: Commit**

```bash
git add test/backends/prisma_store.test.js
git commit -m "test: add PrismaVectorStore integration test"
```

---

### Task 7: Chroma backend integration test

**Files:**
- Create: `test/backends/chroma_store.test.js`

**Interfaces:**
- Consumes: `ChromaVectorStore` from `src/backends/chroma_store.js:4-10`, `addDocuments(docs)` at line 33, `similaritySearch(vector, limit, filter)` at line 81. Passing a `clientInstance` in config skips the real `ChromaClient` construction in `_init()` (line 12-16).

- [ ] **Step 1: Write the failing test**

Create `test/backends/chroma_store.test.js`:

```js
const { ChromaVectorStore } = require('../../src/backends/chroma_store');

function makeMockCollection() {
  return {
    add: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue({
      documents: [['hello world']],
      metadatas: [[{ a: 1 }]],
      distances: [[0.13]],
    }),
  };
}

describe('ChromaVectorStore', () => {
  it('addDocuments calls collection.add with ids, embeddings, metadatas, documents', async () => {
    const collection = makeMockCollection();
    const clientInstance = { getOrCreateCollection: jest.fn().mockResolvedValue(collection) };
    const store = new ChromaVectorStore({ tableName: 'rag_collection', clientInstance });

    await store.addDocuments([{ id: 'doc-1', content: 'hello world', metadata: { a: 1 }, embedding: [0.1, 0.2] }]);

    expect(collection.add).toHaveBeenCalledWith({
      ids: ['doc-1'],
      embeddings: [[0.1, 0.2]],
      metadatas: [{ a: 1 }],
      documents: ['hello world'],
    });
  });

  it('similaritySearch maps Chroma\'s batched response into flat results', async () => {
    const collection = makeMockCollection();
    const clientInstance = { getOrCreateCollection: jest.fn().mockResolvedValue(collection) };
    const store = new ChromaVectorStore({ tableName: 'rag_collection', clientInstance });

    const results = await store.similaritySearch([0.1, 0.2], 5);

    expect(results).toEqual([{ content: 'hello world', metadata: { a: 1 }, score: 0.87 }]);
  });
});
```

- [ ] **Step 2: Run and verify all pass**

Run: `npx jest test/backends/chroma_store.test.js -v`
Expected: 2 tests pass.

- [ ] **Step 3: Commit**

```bash
git add test/backends/chroma_store.test.js
git commit -m "test: add ChromaVectorStore integration test"
```

---

### Task 8: Qdrant backend integration test

**Files:**
- Create: `test/backends/qdrant_store.test.js`

**Interfaces:**
- Consumes: `QdrantVectorStore` from `src/backends/qdrant_store.js:3-4`, `addDocuments(documents)` at line 20, `similaritySearch(vector, limit, filter)` at line 27.

- [ ] **Step 1: Write the failing test**

Create `test/backends/qdrant_store.test.js`:

```js
const { QdrantVectorStore } = require('../../src/backends/qdrant_store');

describe('QdrantVectorStore', () => {
  it('addDocuments upserts points with vector and payload', async () => {
    const upsert = jest.fn().mockResolvedValue(undefined);
    const store = new QdrantVectorStore({ tableName: 'rag_collection', clientInstance: { upsert } });

    await store.addDocuments([{ id: 'doc-1', content: 'hello world', metadata: { a: 1 }, embedding: [0.1, 0.2] }]);

    expect(upsert).toHaveBeenCalledWith('rag_collection', {
      points: [{ id: 'doc-1', vector: [0.1, 0.2], payload: { content: 'hello world', metadata: { a: 1 } } }],
    });
  });

  it('similaritySearch maps Qdrant hits into content/metadata/score', async () => {
    const search = jest.fn().mockResolvedValue([
      { payload: { content: 'hello world', metadata: { a: 1 } }, score: 0.92 },
    ]);
    const store = new QdrantVectorStore({ tableName: 'rag_collection', clientInstance: { search } });

    const results = await store.similaritySearch([0.1, 0.2], 5);

    expect(results).toEqual([{ content: 'hello world', metadata: { a: 1 }, score: 0.92 }]);
  });

  it('normalizeFilter turns a flat filter object into a Qdrant must-clause', () => {
    const store = new QdrantVectorStore({ tableName: 'rag_collection', clientInstance: {} });
    expect(store.normalizeFilter({ category: 'docs' })).toEqual({
      must: [{ key: 'metadata.category', match: { value: 'docs' } }],
    });
  });
});
```

- [ ] **Step 2: Run and verify all pass**

Run: `npx jest test/backends/qdrant_store.test.js -v`
Expected: 3 tests pass.

- [ ] **Step 3: Commit**

```bash
git add test/backends/qdrant_store.test.js
git commit -m "test: add QdrantVectorStore integration test"
```

---

### Task 9: Milvus backend integration test

**Files:**
- Create: `test/backends/milvus_store.test.js`

**Interfaces:**
- Consumes: `MilvusVectorStore` from `src/backends/milvus_store.js:3-4`, `addDocuments(documents)` at line 5, `similaritySearch(vector, limit, filter)` at line 12.

- [ ] **Step 1: Write the failing test**

Create `test/backends/milvus_store.test.js`:

```js
const { MilvusVectorStore } = require('../../src/backends/milvus_store');

describe('MilvusVectorStore', () => {
  it('addDocuments inserts vector, content, and JSON-stringified metadata', async () => {
    const insert = jest.fn().mockResolvedValue(undefined);
    const store = new MilvusVectorStore({ tableName: 'rag_collection', clientInstance: { insert } });

    await store.addDocuments([{ content: 'hello world', metadata: { a: 1 }, embedding: [0.1, 0.2] }]);

    expect(insert).toHaveBeenCalledWith({
      collection_name: 'rag_collection',
      fields_data: [{ vector: [0.1, 0.2], content: 'hello world', metadata: JSON.stringify({ a: 1 }) }],
    });
  });

  it('similaritySearch parses JSON metadata back into an object', async () => {
    const search = jest.fn().mockResolvedValue({
      results: [{ content: 'hello world', metadata: JSON.stringify({ a: 1 }), distance: 0.05 }],
    });
    const store = new MilvusVectorStore({ tableName: 'rag_collection', clientInstance: { search } });

    const results = await store.similaritySearch([0.1, 0.2], 5);

    expect(results).toEqual([{ content: 'hello world', metadata: { a: 1 }, score: 0.05 }]);
  });
});
```

- [ ] **Step 2: Run and verify all pass**

Run: `npx jest test/backends/milvus_store.test.js -v`
Expected: 2 tests pass.

- [ ] **Step 3: Commit**

```bash
git add test/backends/milvus_store.test.js
git commit -m "test: add MilvusVectorStore integration test"
```

---

### Task 10: Relicense to MIT

**Files:**
- Modify: `package.json:52` (license field)
- Modify: `LICENSE` (full replace)

**Interfaces:**
- Produces: `package.json`'s `"license"` field reads `"MIT"`; `LICENSE` contains the MIT license text. No other file in this repo currently references the license (confirmed: no GPL/license mentions in `README.md`).

- [ ] **Step 1: Update package.json**

Edit `package.json` line 52, change:

```json
  "license": "GPL-3.0",
```

to:

```json
  "license": "MIT",
```

- [ ] **Step 2: Replace the LICENSE file**

Overwrite `LICENSE` with:

```
MIT License

Copyright (c) 2026 Abhishek N

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 3: Run the full suite one last time**

Run: `npx jest`
Expected: all tests from Tasks 2-9 pass (license changes don't affect runtime behavior, this just confirms nothing else broke).

- [ ] **Step 4: Commit**

```bash
git add package.json LICENSE
git commit -m "chore: relicense from GPL-3.0 to MIT"
```

---

## Self-Review Notes

- **Spec coverage:** relicense (Task 10), test suite covering config/RRF/MMR/SQL-identifiers/all 5 backends (Tasks 1-9), telemetry default-off (Task 4) — all Phase 1 vectra-js items from the design spec are covered. The three CRUD bug fixes and README pip-install fix are vectra-py/vectra-site scope, not this repo.
- **Placeholder scan:** no TBD/TODO; every step has runnable code.
- **Type consistency:** `isSafeIdentifier`/`quoteIdentifier`/`quoteTableName` names match between Task 3's export edit and its test file. Mock shapes in Tasks 5-9 match the exact `clientInstance` calls read from each backend's source. `src/telemetry.js`'s export shape (singleton instance via `module.exports = new TelemetryManager()`) was confirmed directly before writing Task 4's test.
