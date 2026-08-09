# Context & Memory Layer Phase 1 — vectra-js Fact Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the bi-temporal fact-store memory layer (Component 1 of `docs/superpowers/specs/2026-08-09-context-memory-layer-design.md`) — LLM-driven fact extraction, contradiction/invalidation on write, indexed vector+temporal retrieval on read. This is Phase 1 of 4; later phases (context layer, multi-db fusion, new backends) consume this.

**Architecture:** New `FactStore` class in `src/memory/factStore.js`, following the exact structural pattern of the existing `PostgresHistory` class in `src/memory.js` (constructor takes `clientInstance`/`tableName`, `_withConn` helper, parameterized queries, `safeIdent` for identifiers). Postgres/pgvector only in this phase (matches the spec's "implementable as plain rows over any backend that already has a relational mode" — Postgres is the existing default). Wired into `VectraClient` via a new `memory.facts` config block, additive and separate from the existing raw-message history (which is untouched).

**Tech Stack:** Same as the rest of vectra-js — `pg`, `zod` for config, Jest for tests, the existing embedder/LLM backend abstractions (`this.embedder.embedQuery`/`embedDocuments`, `this.llm.generate` or a dedicated small extraction-LLM config — decided in Task 2).

## Global Constraints

- Postgres/pgvector only in this phase. Do not attempt Neo4j/SurrealDB/graph-native backends — that's explicitly future work per the spec (Component 4, later phase).
- Never delete a fact row. Superseding sets `invalidAt = NOW()` on the old row and inserts a new one.
- All identifiers (table name) go through `safeIdent`-equivalent validation (reuse the existing `safeIdent` function already exported from `src/memory.js`, or an equivalent — do not write raw string-interpolated SQL identifiers without validation, this codebase had a dedicated SQL-identifier-sanitization pass in an earlier phase).
- All queries parameterized (`$1`, `$2`, ...) — no string-interpolated user-controlled values in query text, only validated identifiers.
- Fact extraction (the write path's LLM call) must be fail-soft: a malformed/unparseable LLM response must not throw or crash the caller's turn — log/skip and return.
- Read path must be a single batched query — no per-fact or per-entity round trips (N+1).
- Every task ends with `npm test` passing before moving to the next task.
- Do not touch `src/memory.js`'s existing `InMemoryHistory`/`RedisHistory`/`PostgresHistory` classes, `queryRAG`'s existing history wiring, or any Phase 3/4/5 work already merged — this is purely additive.

---

### Task 1: FactStore schema — table creation, indexes

**Files:**
- Create: `src/memory/factStore.js`
- Create: `test/memory/factStore.ensureIndexes.test.js`

**Interfaces:**
- Produces: `class FactStore` with a constructor `(config)` where `config = { clientInstance, tableName, dimensions }`, and `async ensureIndexes(dimensions = 1536)` that creates the fact table and its indexes if they don't exist. Table name defaults to `'VectraFact'`.

- [ ] **Step 1: Write the failing test**

Create `test/memory/factStore.ensureIndexes.test.js`:

```js
const { FactStore } = require('../../src/memory/factStore');

class FakeConn {
  constructor() {
    this.queries = [];
    this.query = jest.fn(async (q, params) => {
      this.queries.push(q);
      if (q.includes('information_schema.columns')) return { rows: [] };
      return { rows: [] };
    });
  }
}

describe('FactStore.ensureIndexes', () => {
  it('creates the fact table with the given dimension and both a vector index and a temporal index', async () => {
    const conn = new FakeConn();
    const store = new FactStore({ clientInstance: conn, tableName: 'VectraFact' });

    await store.ensureIndexes(768);

    const createTable = conn.queries.find(q => q.includes('CREATE TABLE IF NOT EXISTS'));
    expect(createTable).toBeDefined();
    expect(createTable).toContain('vector(768)');
    expect(createTable).toContain('"subject"');
    expect(createTable).toContain('"predicate"');
    expect(createTable).toContain('"object"');
    expect(createTable).toContain('"validAt"');
    expect(createTable).toContain('"invalidAt"');
    expect(createTable).toContain('"sessionId"');

    const vecIndex = conn.queries.find(q => q.includes('USING hnsw') || q.includes('USING ivfflat'));
    expect(vecIndex).toBeDefined();

    const temporalIndex = conn.queries.find(q => q.toLowerCase().includes('index') && q.includes('"sessionId"') && q.includes('"validAt"'));
    expect(temporalIndex).toBeDefined();
  });

  it('rejects an unsafe table name', () => {
    expect(() => new FactStore({ clientInstance: {}, tableName: 'Fact; DROP TABLE users;--' })).toThrow(/Invalid SQL identifier/);
  });
});
```

- [ ] **Step 2: Run and verify it fails**

Run: `npx jest test/memory/factStore.ensureIndexes.test.js`
Expected: FAIL — `src/memory/factStore.js` does not exist yet.

- [ ] **Step 3: Implement**

Create `src/memory/factStore.js`. Reuse the identifier-safety pattern from `src/memory.js` (copy the `safeIdent` function, or `require` and reuse it directly — prefer `require('../memory').safeIdent` if it's exported; if not currently exported, this task ALSO adds it to `module.exports` in `src/memory.js` alongside the existing three classes, a one-line additive change):

```js
const { safeIdent } = require('../memory');

class FactStore {
  constructor(config) {
    this.client = config.clientInstance;
    this.tableName = safeIdent(config.tableName || 'VectraFact');
  }

  async _withConn(fn) {
    if (typeof this.client.connect === 'function') {
      const c = await this.client.connect();
      try { return await fn(c); } finally { c.release(); }
    }
    return fn(this.client);
  }

  async ensureIndexes(dimensions = 1536) {
    const t = this.tableName;
    const dim = dimensions || 1536;
    await this._withConn(async (client) => {
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');
      await client.query(`CREATE TABLE IF NOT EXISTS "${t}" (
        "id" TEXT PRIMARY KEY,
        "sessionId" TEXT NOT NULL,
        "subject" TEXT NOT NULL,
        "predicate" TEXT NOT NULL,
        "object" TEXT NOT NULL,
        "embedding" vector(${dim}),
        "validAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        "invalidAt" TIMESTAMP WITH TIME ZONE,
        "sourceMessageId" TEXT,
        "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )`);
      try {
        await client.query(`CREATE INDEX IF NOT EXISTS "${t}_vec_idx" ON "${t}" USING hnsw ("embedding" vector_cosine_ops)`);
      } catch (e) {
        try { await client.query(`CREATE INDEX IF NOT EXISTS "${t}_vec_idx" ON "${t}" USING ivfflat ("embedding" vector_cosine_ops)`); } catch (_) {}
      }
      await client.query(`CREATE INDEX IF NOT EXISTS "${t}_session_temporal_idx" ON "${t}" ("sessionId", "validAt", "invalidAt")`);
      await client.query(`CREATE INDEX IF NOT EXISTS "${t}_subject_predicate_idx" ON "${t}" ("sessionId", "subject", "predicate")`);
    });
  }
}

module.exports = { FactStore };
```

If `safeIdent` is not currently exported from `src/memory.js`, add it to that file's `module.exports` line (`module.exports = { InMemoryHistory, RedisHistory, PostgresHistory, safeIdent };`) as part of this task — a one-line additive change, not a rewrite.

- [ ] **Step 4: Run and verify it passes**

Run: `npx jest test/memory/factStore.ensureIndexes.test.js`
Expected: 2 tests pass.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all tests pass, no regressions.

- [ ] **Step 6: Commit**

```bash
git add src/memory/factStore.js src/memory.js test/memory/factStore.ensureIndexes.test.js
git commit -m "feat: add FactStore schema and index creation for bi-temporal memory layer"
```

---

### Task 2: Fact extraction on write (LLM-driven, fail-soft)

**Files:**
- Modify: `src/memory/factStore.js`
- Create: `test/memory/factStore.write.test.js`

**Interfaces:**
- Consumes: `FactStore` from Task 1. An LLM backend object with `async generate(prompt, sys)` (same interface every existing backend in `src/backends/*.js` already implements) and an embedder with `async embedDocuments(texts)`, passed into the constructor as `config.llm` and `config.embedder`.
- Produces: `async write(sessionId, turn)` where `turn = { userMessage, assistantMessage }`. Extracts `{subject, predicate, object}` triples via one `generate()` call, embeds each triple's textual form, and inserts them as new facts (contradiction/invalidation logic is Task 3 — this task always inserts, never invalidates yet).

- [ ] **Step 1: Write the failing test**

Create `test/memory/factStore.write.test.js`:

```js
const { FactStore } = require('../../src/memory/factStore');

class FakeConn {
  constructor() {
    this.inserted = [];
    this.query = jest.fn(async (q, params) => {
      if (q.includes('INSERT INTO')) this.inserted.push(params);
      return { rows: [] };
    });
  }
}

function makeStore({ llmResponse, embedResponse }) {
  const conn = new FakeConn();
  const llm = { generate: jest.fn(async () => llmResponse) };
  const embedder = { embedDocuments: jest.fn(async (texts) => texts.map(() => embedResponse || [0.1, 0.2])) };
  const store = new FactStore({ clientInstance: conn, tableName: 'VectraFact', llm, embedder });
  return { store, conn, llm, embedder };
}

describe('FactStore.write', () => {
  it('extracts triples via the LLM and inserts them as new facts', async () => {
    const { store, conn, llm, embedder } = makeStore({
      llmResponse: JSON.stringify({ facts: [{ subject: 'user', predicate: 'likes', object: 'coffee' }] }),
    });

    await store.write('session-1', { userMessage: 'I really like coffee', assistantMessage: 'Noted!' });

    expect(llm.generate).toHaveBeenCalledTimes(1);
    expect(embedder.embedDocuments).toHaveBeenCalledTimes(1);
    expect(conn.inserted).toHaveLength(1);
    const [id, sessionId, subject, predicate, object] = conn.inserted[0];
    expect(sessionId).toBe('session-1');
    expect(subject).toBe('user');
    expect(predicate).toBe('likes');
    expect(object).toBe('coffee');
  });

  it('extracts multiple triples from one turn', async () => {
    const { store, conn } = makeStore({
      llmResponse: JSON.stringify({ facts: [
        { subject: 'user', predicate: 'likes', object: 'coffee' },
        { subject: 'user', predicate: 'lives_in', object: 'Berlin' },
      ] }),
    });

    await store.write('session-1', { userMessage: 'I like coffee and I live in Berlin', assistantMessage: 'Cool!' });

    expect(conn.inserted).toHaveLength(2);
  });

  it('does not throw when the LLM returns malformed JSON, and inserts nothing', async () => {
    const { store, conn } = makeStore({ llmResponse: 'not json at all {{{' });

    await expect(store.write('session-1', { userMessage: 'hi', assistantMessage: 'hello' })).resolves.not.toThrow();
    expect(conn.inserted).toHaveLength(0);
  });

  it('does not throw when the LLM returns an empty facts array', async () => {
    const { store, conn } = makeStore({ llmResponse: JSON.stringify({ facts: [] }) });

    await store.write('session-1', { userMessage: 'hi', assistantMessage: 'hello' });

    expect(conn.inserted).toHaveLength(0);
  });

  it('is a no-op when sessionId is missing', async () => {
    const { store, conn, llm } = makeStore({ llmResponse: JSON.stringify({ facts: [] }) });

    await store.write(null, { userMessage: 'hi', assistantMessage: 'hello' });

    expect(llm.generate).not.toHaveBeenCalled();
    expect(conn.inserted).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run and verify it fails**

Run: `npx jest test/memory/factStore.write.test.js`
Expected: FAIL — `write` is not yet implemented.

- [ ] **Step 3: Implement**

Add to `src/memory/factStore.js` (add `const { v4: uuidv4 } = require('uuid');` to the top imports — `uuid` is already a dependency, confirm via `package.json` before assuming; if not present, use `require('crypto').randomUUID()` instead, which is Node builtin and needs no new dependency):

```js
const EXTRACTION_PROMPT = `Extract factual (subject, predicate, object) triples from the conversation turn below. Only extract clear, stated facts about the user or entities discussed — not questions, greetings, or the assistant's own commentary. Return strict JSON only, no prose: {"facts": [{"subject": "...", "predicate": "...", "object": "..."}]}. If there are no clear facts, return {"facts": []}.

User: {{USER}}
Assistant: {{ASSISTANT}}`;

class FactStore {
  constructor(config) {
    this.client = config.clientInstance;
    this.tableName = safeIdent(config.tableName || 'VectraFact');
    this.llm = config.llm;
    this.embedder = config.embedder;
  }

  // ...ensureIndexes/_withConn from Task 1 unchanged...

  async write(sessionId, turn) {
    if (!sessionId || !this.llm || !this.embedder) return;
    const prompt = EXTRACTION_PROMPT
      .replace('{{USER}}', turn.userMessage || '')
      .replace('{{ASSISTANT}}', turn.assistantMessage || '');

    let facts;
    try {
      const raw = await this.llm.generate(prompt, 'You extract structured facts as strict JSON.');
      const parsed = JSON.parse(raw);
      facts = Array.isArray(parsed.facts) ? parsed.facts : [];
    } catch (_) {
      return;
    }

    facts = facts.filter(f => f && f.subject && f.predicate && f.object);
    if (facts.length === 0) return;

    const texts = facts.map(f => `${f.subject} ${f.predicate} ${f.object}`);
    let embeddings;
    try {
      embeddings = await this.embedder.embedDocuments(texts);
    } catch (_) {
      return;
    }

    const t = this.tableName;
    await this._withConn(async (client) => {
      for (let i = 0; i < facts.length; i++) {
        const f = facts[i];
        const vec = `[${embeddings[i].join(',')}]`;
        const id = uuidv4();
        try {
          await client.query(
            `INSERT INTO "${t}" ("id","sessionId","subject","predicate","object","embedding","sourceMessageId") VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [id, sessionId, f.subject, f.predicate, f.object, vec, turn.sourceMessageId || null]
          );
        } catch (_) {}
      }
    });
  }
}
```

- [ ] **Step 4: Run and verify it passes**

Run: `npx jest test/memory/factStore.write.test.js`
Expected: 5 tests pass.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/memory/factStore.js test/memory/factStore.write.test.js package.json package-lock.json
git commit -m "feat: LLM-driven fact extraction on FactStore.write, fail-soft on malformed output"
```
(Only include `package.json`/`package-lock.json` in the commit if a new dependency was actually added — e.g. if `uuid` wasn't already present and Node's builtin `crypto.randomUUID()` couldn't be used for some reason. Prefer the builtin; if so, these two files won't be part of this diff at all.)

---

### Task 3: Contradiction detection and invalidation

**Files:**
- Modify: `src/memory/factStore.js`
- Create: `test/memory/factStore.invalidation.test.js`

**Interfaces:**
- Produces: `write()` now checks, per extracted triple, whether a currently-valid fact exists with the same `sessionId`+`subject`+`predicate` but a different `object`. If so, it sets that old row's `invalidAt = NOW()` before inserting the new fact. If an identical fact (same subject+predicate+object, still valid) already exists, it's skipped entirely (no duplicate insert).

- [ ] **Step 1: Write the failing test**

Create `test/memory/factStore.invalidation.test.js`:

```js
const { FactStore } = require('../../src/memory/factStore');

class FakeConn {
  constructor(existingFacts = []) {
    this.existingFacts = existingFacts;
    this.inserted = [];
    this.invalidated = [];
    this.query = jest.fn(async (q, params) => {
      if (q.includes('SELECT') && q.includes('"invalidAt" IS NULL')) {
        return { rows: this.existingFacts.filter(f => f.subject === params[1] && f.predicate === params[2]) };
      }
      if (q.includes('UPDATE') && q.includes('"invalidAt"')) {
        this.invalidated.push(params[0]);
        return { rows: [] };
      }
      if (q.includes('INSERT INTO')) {
        this.inserted.push(params);
        return { rows: [] };
      }
      return { rows: [] };
    });
  }
}

function makeStore(existingFacts, llmResponse) {
  const conn = new FakeConn(existingFacts);
  const llm = { generate: jest.fn(async () => llmResponse) };
  const embedder = { embedDocuments: jest.fn(async (texts) => texts.map(() => [0.1, 0.2])) };
  const store = new FactStore({ clientInstance: conn, tableName: 'VectraFact', llm, embedder });
  return { store, conn };
}

describe('FactStore contradiction/invalidation', () => {
  it('invalidates the old fact and inserts a new one when the object changes', async () => {
    const { store, conn } = makeStore(
      [{ id: 'old-1', subject: 'user', predicate: 'lives_in', object: 'Berlin' }],
      JSON.stringify({ facts: [{ subject: 'user', predicate: 'lives_in', object: 'Tokyo' }] })
    );

    await store.write('session-1', { userMessage: 'I moved to Tokyo', assistantMessage: 'Nice!' });

    expect(conn.invalidated).toContain('old-1');
    expect(conn.inserted).toHaveLength(1);
    expect(conn.inserted[0][4]).toBe('Tokyo');
  });

  it('does not insert a duplicate when the exact same fact already exists and is valid', async () => {
    const { store, conn } = makeStore(
      [{ id: 'old-1', subject: 'user', predicate: 'likes', object: 'coffee' }],
      JSON.stringify({ facts: [{ subject: 'user', predicate: 'likes', object: 'coffee' }] })
    );

    await store.write('session-1', { userMessage: 'I still like coffee', assistantMessage: 'Great!' });

    expect(conn.invalidated).toHaveLength(0);
    expect(conn.inserted).toHaveLength(0);
  });

  it('inserts as new when no existing fact shares subject+predicate', async () => {
    const { store, conn } = makeStore(
      [],
      JSON.stringify({ facts: [{ subject: 'user', predicate: 'likes', object: 'tea' }] })
    );

    await store.write('session-1', { userMessage: 'I like tea', assistantMessage: 'Noted!' });

    expect(conn.invalidated).toHaveLength(0);
    expect(conn.inserted).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run and verify it fails**

Run: `npx jest test/memory/factStore.invalidation.test.js`
Expected: FAIL — no contradiction-check logic exists yet, every fact gets inserted unconditionally.

- [ ] **Step 3: Implement**

Modify `write()`'s per-fact loop in `src/memory/factStore.js`. Before inserting, query for an existing valid fact with the same `sessionId`+`subject`+`predicate`:

```js
    await this._withConn(async (client) => {
      for (let i = 0; i < facts.length; i++) {
        const f = facts[i];
        const vec = `[${embeddings[i].join(',')}]`;

        const existing = await client.query(
          `SELECT "id","object" FROM "${t}" WHERE "sessionId" = $1 AND "subject" = $2 AND "predicate" = $3 AND "invalidAt" IS NULL`,
          [sessionId, f.subject, f.predicate]
        );
        const existingRow = existing.rows[0];

        if (existingRow && existingRow.object === f.object) {
          continue; // identical fact already valid, skip
        }
        if (existingRow) {
          try {
            await client.query(`UPDATE "${t}" SET "invalidAt" = NOW() WHERE "id" = $1`, [existingRow.id]);
          } catch (_) {}
        }

        const id = uuidv4();
        try {
          await client.query(
            `INSERT INTO "${t}" ("id","sessionId","subject","predicate","object","embedding","sourceMessageId") VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [id, sessionId, f.subject, f.predicate, f.object, vec, turn.sourceMessageId || null]
          );
        } catch (_) {}
      }
    });
```

- [ ] **Step 4: Run and verify it passes**

Run: `npx jest test/memory/factStore.invalidation.test.js`
Expected: 3 tests pass.

- [ ] **Step 5: Run the full suite, including Task 2's tests**

Run: `npx jest test/memory/ && npm test`
Expected: all pass — confirm Task 2's tests still pass unchanged (they use empty `existingFacts`, so the new SELECT should return no rows and behave identically to before).

- [ ] **Step 6: Commit**

```bash
git add src/memory/factStore.js test/memory/factStore.invalidation.test.js
git commit -m "feat: contradiction detection and bi-temporal invalidation on FactStore.write"
```

---

### Task 4: Read path — indexed vector + temporal retrieval

**Files:**
- Modify: `src/memory/factStore.js`
- Create: `test/memory/factStore.read.test.js`

**Interfaces:**
- Produces: `async read(sessionId, query, { limit = 10 } = {})` — embeds `query`, runs ONE batched SQL query combining vector similarity ordering with a temporal-validity filter (`"invalidAt" IS NULL`), scoped to `sessionId`, returns `Fact[]` with `embedding` excluded from the output shape.

- [ ] **Step 1: Write the failing test**

Create `test/memory/factStore.read.test.js`:

```js
const { FactStore } = require('../../src/memory/factStore');

class FakeConn {
  constructor(rows) {
    this.rows = rows;
    this.lastQuery = null;
    this.lastParams = null;
    this.query = jest.fn(async (q, params) => {
      this.lastQuery = q;
      this.lastParams = params;
      return { rows: this.rows };
    });
  }
}

describe('FactStore.read', () => {
  it('runs a single query combining vector similarity and temporal validity, scoped to the session', async () => {
    const conn = new FakeConn([
      { id: '1', subject: 'user', predicate: 'likes', object: 'coffee', validAt: new Date(), invalidAt: null },
    ]);
    const embedder = { embedQuery: jest.fn(async () => [0.1, 0.2]) };
    const store = new FactStore({ clientInstance: conn, tableName: 'VectraFact', embedder });

    const facts = await store.read('session-1', 'what does the user like?', { limit: 5 });

    expect(conn.query).toHaveBeenCalledTimes(1); // single batched query, no N+1
    expect(conn.lastQuery).toContain('"invalidAt" IS NULL');
    expect(conn.lastQuery).toContain('"sessionId" = $1');
    expect(conn.lastQuery.toLowerCase()).toContain('order by');
    expect(conn.lastParams[0]).toBe('session-1');

    expect(facts).toHaveLength(1);
    expect(facts[0]).toEqual({ id: '1', subject: 'user', predicate: 'likes', object: 'coffee', validAt: expect.any(Date), invalidAt: null });
    expect(facts[0].embedding).toBeUndefined();
  });

  it('returns an empty array and does not query when sessionId is missing', async () => {
    const conn = new FakeConn([]);
    const embedder = { embedQuery: jest.fn(async () => [0.1, 0.2]) };
    const store = new FactStore({ clientInstance: conn, tableName: 'VectraFact', embedder });

    const facts = await store.read(null, 'query');

    expect(facts).toEqual([]);
    expect(conn.query).not.toHaveBeenCalled();
  });

  it('respects the limit parameter', async () => {
    const conn = new FakeConn([]);
    const embedder = { embedQuery: jest.fn(async () => [0.1, 0.2]) };
    const store = new FactStore({ clientInstance: conn, tableName: 'VectraFact', embedder });

    await store.read('session-1', 'query', { limit: 3 });

    expect(conn.lastQuery.toLowerCase()).toContain('limit');
    expect(conn.lastParams).toContain(3);
  });
});
```

- [ ] **Step 2: Run and verify it fails**

Run: `npx jest test/memory/factStore.read.test.js`
Expected: FAIL — `read` is not yet implemented.

- [ ] **Step 3: Implement**

Add to `src/memory/factStore.js`:

```js
  async read(sessionId, query, { limit = 10 } = {}) {
    if (!sessionId || !this.embedder) return [];
    const vector = await this.embedder.embedQuery(query);
    const vec = `[${vector.join(',')}]`;
    const t = this.tableName;

    const res = await this.client.query(
      `SELECT "id","subject","predicate","object","validAt","invalidAt"
       FROM "${t}"
       WHERE "sessionId" = $1 AND "invalidAt" IS NULL
       ORDER BY "embedding" <=> $2
       LIMIT $3`,
      [sessionId, vec, Math.max(1, limit)]
    );
    return res.rows;
  }
```

Note: this uses `this.client.query` directly (not `_withConn`) to match the single-batched-query requirement simply for a read-only SELECT — confirm this matches the existing `PostgresVectorStore.similaritySearch` convention in `src/backends/postgres_store.js` (check whether IT uses `_withConn` or `this.client.query` directly for reads) and follow whichever pattern that file actually uses, for consistency across the codebase.

- [ ] **Step 4: Run and verify it passes**

Run: `npx jest test/memory/factStore.read.test.js`
Expected: 3 tests pass.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/memory/factStore.js test/memory/factStore.read.test.js
git commit -m "feat: indexed vector+temporal read path for FactStore, single batched query"
```

---

### Task 5: Config wiring — `memory.facts` schema block, VectraClient instantiation

**Files:**
- Modify: `src/config.js`
- Modify: `src/core.js`
- Create: `test/config.memoryFacts.test.js`

**Interfaces:**
- Consumes: `FactStore` from Tasks 1-4.
- Produces: `RAGConfigSchema`'s existing `memory` object gains an optional `facts` sub-object (`enabled`, `clientInstance`, `tableName`). `VectraClient`'s constructor instantiates `this.factStore = new FactStore(...)` when `config.memory?.facts?.enabled` is true, passing `this.embedder` and `this.llm` (both already constructed earlier in the constructor — confirm exact construction order in `core.js` and place the `factStore` instantiation after both exist).

- [ ] **Step 1: Read the current memory config schema and VectraClient constructor**

Read `src/config.js`'s `memory` object (around line 119, shown in this plan's research above) and `src/core.js`'s constructor (around lines 100-135, where `this.embedder`/`this.llm`/history backends are constructed) in full before editing, to place the new code correctly relative to existing construction order.

- [ ] **Step 2: Write the failing test**

Create `test/config.memoryFacts.test.js`:

```js
const { RAGConfigSchema } = require('../src/config');

describe('memory.facts config', () => {
  it('defaults to disabled when not specified', () => {
    const parsed = RAGConfigSchema.parse({
      embedding: { provider: 'openai', modelName: 'text-embedding-3-small' },
      llm: { provider: 'openai', modelName: 'gpt-4o-mini' },
      database: { type: 'postgres', clientInstance: {} },
    });
    expect(parsed.memory.facts?.enabled ?? false).toBe(false);
  });

  it('accepts an explicit facts config', () => {
    const client = {};
    const parsed = RAGConfigSchema.parse({
      embedding: { provider: 'openai', modelName: 'text-embedding-3-small' },
      llm: { provider: 'openai', modelName: 'gpt-4o-mini' },
      database: { type: 'postgres', clientInstance: {} },
      memory: { enabled: true, facts: { enabled: true, clientInstance: client, tableName: 'MyFacts' } },
    });
    expect(parsed.memory.facts.enabled).toBe(true);
    expect(parsed.memory.facts.tableName).toBe('MyFacts');
  });
});
```

- [ ] **Step 3: Run and verify it fails**

Run: `npx jest test/config.memoryFacts.test.js`
Expected: FAIL — `facts` field doesn't exist on the schema yet, `parsed.memory.facts` is `undefined`, second test's `.tableName` access throws.

- [ ] **Step 4: Add the schema field**

In `src/config.js`, inside the existing `memory: z.object({ ... })` block, add a sibling field to `redis`/`postgres`:

```js
    facts: z.object({
      enabled: z.boolean().default(false),
      clientInstance: z.any().optional(),
      tableName: z.string().default('VectraFact'),
    }).optional(),
```

- [ ] **Step 5: Wire instantiation in core.js**

In `src/core.js`'s constructor, after `this.embedder`/`this.llm` are constructed (confirm exact line from Step 1's read), add:

```js
const { FactStore } = require('./memory/factStore');
// ...
if (this.config.memory?.facts?.enabled) {
  this.factStore = new FactStore({
    clientInstance: this.config.memory.facts.clientInstance,
    tableName: this.config.memory.facts.tableName,
    llm: this.llm,
    embedder: this.embedder,
  });
}
```

Place the `require` at the top of the file with the other requires, not inline, matching the file's existing style — check how `PostgresHistory`/`RedisHistory`/`InMemoryHistory` are already required at the top of `core.js` and follow the same pattern.

- [ ] **Step 6: Run and verify it passes**

Run: `npx jest test/config.memoryFacts.test.js`
Expected: 2 tests pass.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: all pass, no regressions to existing `VectraClient` construction tests.

- [ ] **Step 8: Commit**

```bash
git add src/config.js src/core.js test/config.memoryFacts.test.js
git commit -m "feat: wire FactStore into VectraClient via memory.facts config"
```

---

### Task 6: Short-lived per-session read cache

**Files:**
- Modify: `src/memory/factStore.js`
- Create: `test/memory/factStore.cache.test.js`

**Interfaces:**
- Produces: `read()` now checks an in-process LRU-style cache keyed by `` `${sessionId}:${query}` `` before querying. Cache entries expire after a short TTL (default 30 seconds, configurable via `config.cacheTtlMs`). This is purely a performance optimization for rapid repeat reads within a burst of turns — not a correctness requirement, so a simple `Map` with timestamp-based expiry is sufficient (no need for a full LRU library dependency).

- [ ] **Step 1: Write the failing test**

Create `test/memory/factStore.cache.test.js`:

```js
const { FactStore } = require('../../src/memory/factStore');

describe('FactStore read cache', () => {
  it('does not re-query for the same session+query within the TTL', async () => {
    const conn = { query: jest.fn(async () => ({ rows: [{ id: '1', subject: 'a', predicate: 'b', object: 'c' }] })) };
    const embedder = { embedQuery: jest.fn(async () => [0.1]) };
    const store = new FactStore({ clientInstance: conn, tableName: 'VectraFact', embedder, cacheTtlMs: 30000 });

    await store.read('session-1', 'same query');
    await store.read('session-1', 'same query');

    expect(conn.query).toHaveBeenCalledTimes(1);
  });

  it('re-queries for a different query text even within the TTL', async () => {
    const conn = { query: jest.fn(async () => ({ rows: [] })) };
    const embedder = { embedQuery: jest.fn(async () => [0.1]) };
    const store = new FactStore({ clientInstance: conn, tableName: 'VectraFact', embedder, cacheTtlMs: 30000 });

    await store.read('session-1', 'query A');
    await store.read('session-1', 'query B');

    expect(conn.query).toHaveBeenCalledTimes(2);
  });

  it('re-queries after the cache entry has expired', async () => {
    const conn = { query: jest.fn(async () => ({ rows: [] })) };
    const embedder = { embedQuery: jest.fn(async () => [0.1]) };
    const store = new FactStore({ clientInstance: conn, tableName: 'VectraFact', embedder, cacheTtlMs: 1 });

    await store.read('session-1', 'query');
    await new Promise(r => setTimeout(r, 10));
    await store.read('session-1', 'query');

    expect(conn.query).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run and verify it fails**

Run: `npx jest test/memory/factStore.cache.test.js`
Expected: FAIL — no caching exists yet, every call queries.

- [ ] **Step 3: Implement**

In the constructor, add `this.cacheTtlMs = config.cacheTtlMs ?? 30000; this._readCache = new Map();`. At the top of `read()`, before embedding/querying:

```js
    const cacheKey = `${sessionId}:${query}`;
    const cached = this._readCache.get(cacheKey);
    if (cached && (Date.now() - cached.ts) < this.cacheTtlMs) {
      return cached.value;
    }
```

At the end of `read()`, before `return res.rows;`, cache the result:

```js
    this._readCache.set(cacheKey, { ts: Date.now(), value: res.rows });
    return res.rows;
```

- [ ] **Step 4: Run and verify it passes**

Run: `npx jest test/memory/factStore.cache.test.js`
Expected: 3 tests pass.

- [ ] **Step 5: Run the full suite, including all prior FactStore tests**

Run: `npx jest test/memory/ && npm test`
Expected: all pass — confirm Task 4's tests still pass (they don't set `cacheTtlMs`, so default 30s applies; each test in `factStore.read.test.js` uses fresh `FactStore` instances, so no cross-test cache pollution).

- [ ] **Step 6: Commit**

```bash
git add src/memory/factStore.js test/memory/factStore.cache.test.js
git commit -m "perf: add short-lived per-session read cache to FactStore"
```

---

### Task 7: End-to-end integration test

**Files:**
- Create: `test/memory/factStore.integration.test.js`

**Interfaces:**
- Consumes: everything from Tasks 1-6. No new production code — pure test coverage tying the full write→invalidate→read flow together with a more realistic fake Postgres connection (in-memory row store, not per-method mocked returns) to catch integration bugs the per-task unit tests' narrower mocks could miss.

- [ ] **Step 1: Write the integration test**

Create `test/memory/factStore.integration.test.js`:

```js
const { FactStore } = require('../../src/memory/factStore');

// A more realistic fake: actually stores/updates/filters rows, rather than
// returning canned responses per query shape like the per-task unit tests do.
class InMemoryFakeConn {
  constructor() { this.rows = []; }
  async query(q, params) {
    if (q.includes('CREATE TABLE') || q.includes('CREATE INDEX') || q.includes('CREATE EXTENSION')) {
      return { rows: [] };
    }
    if (q.includes('SELECT') && q.includes('"invalidAt" IS NULL') && q.includes('"subject" = $2')) {
      const [sessionId, subject, predicate] = params;
      return { rows: this.rows.filter(r => r.sessionId === sessionId && r.subject === subject && r.predicate === predicate && !r.invalidAt) };
    }
    if (q.includes('UPDATE') && q.includes('"invalidAt"')) {
      const [id] = params;
      const row = this.rows.find(r => r.id === id);
      if (row) row.invalidAt = new Date();
      return { rows: [] };
    }
    if (q.includes('INSERT INTO')) {
      const [id, sessionId, subject, predicate, object] = params;
      this.rows.push({ id, sessionId, subject, predicate, object, validAt: new Date(), invalidAt: null });
      return { rows: [] };
    }
    if (q.includes('SELECT') && q.includes('ORDER BY')) {
      const [sessionId] = params;
      return { rows: this.rows.filter(r => r.sessionId === sessionId && !r.invalidAt).map(r => ({ id: r.id, subject: r.subject, predicate: r.predicate, object: r.object, validAt: r.validAt, invalidAt: r.invalidAt })) };
    }
    return { rows: [] };
  }
}

describe('FactStore end-to-end', () => {
  it('write then read round-trips a fact', async () => {
    const conn = new InMemoryFakeConn();
    const llm = { generate: jest.fn(async () => JSON.stringify({ facts: [{ subject: 'user', predicate: 'likes', object: 'coffee' }] })) };
    const embedder = { embedDocuments: jest.fn(async (t) => t.map(() => [0.1])), embedQuery: jest.fn(async () => [0.1]) };
    const store = new FactStore({ clientInstance: conn, tableName: 'VectraFact', llm, embedder });

    await store.write('session-1', { userMessage: 'I like coffee', assistantMessage: 'Noted!' });
    const facts = await store.read('session-1', 'what does the user like');

    expect(facts).toHaveLength(1);
    expect(facts[0].object).toBe('coffee');
  });

  it('a superseding fact replaces the old one in read results, never both', async () => {
    const conn = new InMemoryFakeConn();
    const embedder = { embedDocuments: jest.fn(async (t) => t.map(() => [0.1])), embedQuery: jest.fn(async () => [0.1]) };
    const llmSeq = [
      JSON.stringify({ facts: [{ subject: 'user', predicate: 'lives_in', object: 'Berlin' }] }),
      JSON.stringify({ facts: [{ subject: 'user', predicate: 'lives_in', object: 'Tokyo' }] }),
    ];
    let call = 0;
    const llm = { generate: jest.fn(async () => llmSeq[call++]) };
    const store = new FactStore({ clientInstance: conn, tableName: 'VectraFact', llm, embedder });

    await store.write('session-1', { userMessage: 'I live in Berlin', assistantMessage: 'Cool!' });
    await store.write('session-1', { userMessage: 'I moved to Tokyo', assistantMessage: 'Wow!' });
    const facts = await store.read('session-1', 'where does the user live');

    const livesInFacts = facts.filter(f => f.predicate === 'lives_in');
    expect(livesInFacts).toHaveLength(1);
    expect(livesInFacts[0].object).toBe('Tokyo');
  });

  it('facts from a different session never leak into another session\'s read', async () => {
    const conn = new InMemoryFakeConn();
    const embedder = { embedDocuments: jest.fn(async (t) => t.map(() => [0.1])), embedQuery: jest.fn(async () => [0.1]) };
    const llm = { generate: jest.fn(async () => JSON.stringify({ facts: [{ subject: 'user', predicate: 'likes', object: 'coffee' }] })) };
    const store = new FactStore({ clientInstance: conn, tableName: 'VectraFact', llm, embedder });

    await store.write('session-A', { userMessage: 'I like coffee', assistantMessage: 'Noted!' });
    const factsB = await store.read('session-B', 'what does the user like');

    expect(factsB).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run and verify it passes**

Run: `npx jest test/memory/factStore.integration.test.js`
Expected: 3 tests pass. (This is integration coverage over already-implemented behavior from Tasks 1-6 — if any of these 3 tests fail, it means the per-task unit tests missed a real integration bug; investigate and fix the underlying implementation, do not weaken these assertions to force a pass.)

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add test/memory/factStore.integration.test.js
git commit -m "test: add end-to-end integration coverage for FactStore write/invalidate/read"
```

---

## Self-Review Notes

- **Spec coverage:** all of Component 1 (Memory Layer) from `docs/superpowers/specs/2026-08-09-context-memory-layer-design.md` — schema (Task 1), write/extraction (Task 2), invalidation (Task 3), read (Task 4), config wiring (Task 5), caching (Task 6), integration proof (Task 7). Multi-hop graph walk from the spec's read-path description is deliberately deferred — this phase ships single-hop (direct vector-similarity match only); a follow-up task in a later phase can add graph expansion once there's a real graph-capable backend (Component 4), consistent with the spec's phasing.
- **Placeholder scan:** no TBD/TODO; every step has real, runnable code.
- **Performance requirements from the spec, addressed**: indexed reads (Task 1's HNSW + temporal indexes), no N+1 (Task 4's single batched query, asserted directly in its test via `toHaveBeenCalledTimes(1)`), async/non-blocking extraction (Task 2 — `write()` is itself `async` and callers are expected to not `await` it synchronously in the hot path, though enforcing "fire and forget" call-site behavior is a Phase 2 concern once `queryRAG` is wired to call this), short-lived cache (Task 6).
- **Type/interface consistency:** `FactStore` constructor shape (`clientInstance`, `tableName`, `llm`, `embedder`, `cacheTtlMs`) and the `write(sessionId, turn)`/`read(sessionId, query, opts)` signatures are used identically across all 7 tasks — verified no drift between the interface Task 1 establishes and what Tasks 2-7 assume.
