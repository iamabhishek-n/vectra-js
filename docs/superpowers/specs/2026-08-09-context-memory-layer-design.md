# Context & Memory Layer — Design Spec

## Goal

Give Vectra a standalone, backend-agnostic **context layer** implementing a Read-Think-Write pattern (federated read across sources → caller's LLM reasons → write-back persists learnings), plus a first-class **memory layer** built on a bi-temporal knowledge-graph fact store — not the existing raw-message-history classes. Ship natively in both vectra-js and vectra-py, in lockstep, same API shape in both languages.

This is Vectra's differentiation move: none of the four established agent-memory products (Mem0, Zep/Graphiti, Letta, Cognee) do full RAG (hybrid search, real rerankers, multi-strategy retrieval) well or at all — Vectra already does. Adding a competitive memory/context layer on top, without losing the RAG strength, is whitespace none of them occupy.

## Background — competitive research (this session)

| | Mem0 | Zep/Graphiti | Letta | Cognee |
|---|---|---|---|---|
| Stars | ~62k | Graphiti ~30k | ~23k | ~30k |
| Funding | $24M | $500K (YC) | $10M | $7.5M |
| Core approach | LLM-extracted atomic facts, vector+graph+KV hybrid search | Bi-temporal knowledge graph (Graphiti engine), open core + closed hosted layer (Zep) | LLM self-manages memory paging (OS-style, non-deterministic retrieval) | ECL pipeline, typed knowledge graph, pluggable backends |
| Lang | Py+JS | **Graphiti = Python only** | Py+TS | Py primary, new TS |
| Weakness to exploit | Yanked graph feature to paid tier after building OSS trust — don't do that | Python-only core is a real JS gap | LLM-decided retrieval trades away latency/predictability guarantees | 3 overlapping API surfaces, API churn signals instability |

None of the four have a RAG orchestration layer comparable to Vectra's (real hybrid search RRF fusion across 5+ backends, real Cohere/Jina rerankers, HyDE/multi-query/MMR). Vectra's opening: RAG + memory + context assembly + multi-db fusion, in one SDK, dual-language natively from day one (not bolted on later like Cognee/Letta's TS support).

## Architecture: Read-Think-Write

- **READ**: federated fetch across whatever sources are configured (vector-store docs, temporal-graph facts, tool-call results, raw conversation history) — fused into one unified, budget-aware context. Backend-agnostic; not dependent on any single database's native multi-model capability (e.g. SurrealDB, evaluated this session — real multi-model engine, but BSL-licensed and unproven at vector-search scale vs Qdrant/Milvus; may be added later as one more pluggable backend, not a required dependency).
- **THINK**: the caller's LLM reasons over the unified context. Vectra does not own reasoning — hands back clean, structured, budget-fit context and gets out of the way.
- **WRITE**: the agent's derived facts/entities/decisions persist back into the memory layer for the next turn, via explicit write-back call — not implicit raw-message logging.

## Component 1: Memory Layer (bi-temporal fact store)

Replaces (for context-building purposes) the existing `InMemoryHistory`/`RedisHistory`/`PostgresHistory` classes' role. Those classes stay as a raw-log/audit-trail fallback; the fact store becomes the real memory layer feeding `buildContext`.

### Data model

Implementable as plain rows over any backend that already has a relational or document mode (Postgres, SQLite, Prisma) — a graph is an edge list with temporal columns, not a mandatory dedicated graph database. Richer backends (Neo4j, SurrealDB via `RELATE`) get a native implementation later behind the same interface for real multi-hop traversal performance.

```
fact:
  id
  session_id
  subject       (entity)
  predicate     (relation)
  object        (entity or literal)
  embedding     (vector, for semantic candidate search)
  valid_at      (timestamp — when this fact became true)
  invalid_at    (timestamp, nullable — when superseded; null = still valid)
  source_message_id
```

Never delete a fact. Superseding a fact sets `invalid_at = now()` on the old row and inserts a new one — bi-temporal, matches Graphiti's actual moat rather than a naive overwrite.

### Write path

1. Turn completes (user+assistant messages).
2. LLM extraction call (reuse existing `generate()` backend abstraction already in `llm.js`/`llm.py` — no new LLM plumbing) pulls `{subject, predicate, object}` triples from the turn.
3. For each triple: check for an existing valid fact with the same `subject`+`predicate` but a different `object`. If found, contradiction/update — invalidate the old fact, insert the new one. If not found, insert as new.
4. Extraction is async, non-blocking — does not hold up the response to the caller. Batched/debounced per turn, not one LLM call per fact.

### Read path

1. Query arrives, gets embedded (reuse existing embedder abstraction).
2. Vector search over fact embeddings for a candidate set (indexed — HNSW/ivfflat depending on backend, no sequential scans on this hot path).
3. Optional multi-hop graph walk from matched entities (follow `RELATE`-style edges / joined edge-list rows) to pull connected facts.
4. Filter to temporally valid facts only: `invalid_at IS NULL OR invalid_at > now()`.
5. Single batched query — no N+1 per-entity round trips.
6. Short-lived per-session LRU cache for repeat reads within a burst of turns.

### API

**JS** (`src/memory/factStore.js` or similar — exact filename decided at plan time):
```js
await memory.write(sessionId, turn)              // extract + invalidate + insert, async/non-blocking
await memory.read(sessionId, query, { limit })    // -> Fact[]
```

**Python** (`vectra/memory/fact_store.py`):
```python
await memory.write(session_id, turn)
await memory.read(session_id, query, limit=...)
```

Both return the same `Fact` shape (subject/predicate/object/valid_at/invalid_at/embedding-excluded-from-output).

## Component 2: Context Layer (Read-Think-Write assembly)

Two-tier API, same shape both languages.

### Tier 1 — low-level, full control

**JS**: `buildContext(input) -> PackedContext`
**Python**: `build_context(input) -> PackedContext`

```
input = {
  query,
  budget: { maxTokens, model },
  sources: [
    { type: 'docs', stores: [store1, store2, ...], strategy: 'hybrid'|'naive'|'mmr'|... },  // multi-db fan-out, RRF-fused across ALL stores, not just within one
    { type: 'memory', sessionId },        // reads from the fact store (Component 1)
    { type: 'tools', results: [{name, output}, ...] },  // pre-computed only — Vectra does not execute tool calls, that's the caller's agent loop's job (validated: none of Mem0/Zep/Letta/Cognee execute tools either, all four scope themselves as memory/context layers, not agent orchestrators)
  ],
  priority: ['memory', 'tools', 'docs'],  // trim order when over budget
}

PackedContext = {
  parts: [{ source, type, content, tokens }],   // structured
  text: '...',                                   // pre-joined convenience string
  tokensUsed, tokensBudget,
  dropped: [...],                                 // explicit, not silently truncated — fixes the existing buildContextParts silent-truncation gap found in Phase 3 review
  warnings: [{ store, error }],                   // partial-failure reporting from multi-db fan-out
}
```

### Tier 2 — high-level, simple

**JS**: `context.ask(query, { sessionId, stores }) `
**Python**: `context.ask(query, session_id=..., stores=...)`

Thin wrapper over Tier 1 — auto-picks strategy/budget/priority/fusion with sane defaults, same ergonomics as today's `queryRAG(query, filter, stream, sessionId)`. Recommended entry point in quickstart docs; Tier 1 documented as the advanced/power-user path.

### Backward compatibility

`queryRAG`/`query_rag`'s existing signature is unchanged. Internally refactored to call `buildContext`/`build_context` for context assembly — this also fixes a real bug found in Phase 3 research: conversation history is currently concatenated into the prompt *outside* `buildContextParts`'s token-budget accounting, so history can push the real prompt over budget uncounted. Single-store configs behave exactly as before; multi-db fan-out is opt-in (pass an array of stores, not required).

## Component 3: Multi-db fusion

Extends the existing `reciprocalRankFusion`/RRF pattern (already fuses semantic+lexical *within* one store, used across Chroma/Qdrant/Milvus/Postgres/Prisma) to fuse *across* multiple store instances in one `buildContext` call.

- Fan-out to all configured stores **concurrently** (`Promise.all` / `asyncio.gather`) — never sequential. This is the single biggest performance lever; sequential fan-out multiplies latency by store count.
- Per-store timeout + circuit-breaker. One dead/slow store degrades gracefully: partial results + an entry in `warnings`, not a hard failure of the whole `buildContext` call. Total latency bounded by the *slowest* store's timeout, not the sum of all stores.
- Fusion math reuses existing RRF (`1/(k+rank+1)`, k=60, sort-based O(n log n)) — same constant and algorithm already used and tested across 5 backends this session, extended to fuse across store boundaries instead of within one.

## Component 4: New vector store backends

Existing: Postgres/pgvector, Prisma, ChromaDB, Qdrant, Milvus (6 counting Postgres+Prisma separately). Gap identified this session: competitors offer 15-40+.

Candidates for addition (priority TBD at plan time, likely ordered by real-world deployment frequency): Pinecone, Weaviate, LanceDB, SurrealDB (researched this session — real multi-model engine, native HNSW vector + graph `RELATE` + temporal, official JS+Python SDKs, ~31k stars, $44M raised, BSL license — source-visible/free to self-host, restricted only if reselling as a competing managed DBaaS; vector search not benchmarked competitive with Qdrant/Milvus at scale, so positioned as an optional batteries-included choice for users who want one engine doing vector+graph+temporal natively, not a required dependency or a replacement for the existing adapters).

Each new backend: native indexes only (HNSW, no brute-force fallback in the hot path), connection pooling/reuse (no per-query connect), same `similaritySearch`/`hybridSearch`/`addDocuments` interface contract as existing backends.

## Non-goals

- **No tool-execution loop.** Vectra accepts pre-computed tool results as a context source; it does not add `tool_choice`/`functions` passthrough to LLM backends or run an execute-then-recall loop. That's agent-framework territory (LangGraph etc.), confirmed out of scope by how all four real competitors (Mem0/Zep/Letta/Cognee) also scope themselves as memory/context layers, not orchestrators.
- **No Rust rewrite.** Evaluated this session: the actual latency bottleneck here is I/O (LLM calls, DB round trips), not CPU — architecture (concurrency, indexing, no N+1) gets most of the win in JS/Python already. A native Rust core for the CPU-bound slivers (RRF fusion, temporal-fact filtering, tokenization) shared via bindings into both languages is a plausible *future* bet once there's real usage/benchmarks to justify the adoption-friction cost of native addons — not now.
- **No requirement on SurrealDB or any single database.** The Read-Think-Write pattern is Vectra's own architecture, implemented backend-agnostically over the existing pluggable-store model. SurrealDB is one optional new backend choice among several, not infrastructure the context/memory layer depends on.

## Config schema

Lightweight `contextLayer` block added to `RAGConfig`/`VectraConfig` (budget defaults, priority-order defaults), same pattern as the existing `memory`/`reranking` config blocks — not a new parallel config system.

## Performance requirements

Directional (numeric SLOs to be set once there's something to benchmark, per this session's discussion):
- All context sources fetched concurrently, never sequential.
- Every hot-path read uses a native index (vector HNSW/ivfflat, temporal columns), no sequential scans.
- No N+1 query patterns anywhere in the read path — single batched queries.
- Token counts cached by content-hash, not recomputed per call.
- Fact extraction (LLM call) is async/non-blocking, does not hold up the response.
- Per-store timeout + circuit-breaker on multi-db fan-out; total latency bounded by slowest store, not sum of all stores.

## Testing strategy

TDD, real discriminating assertions (not vacuous — this session's reviews repeatedly caught vacuous test fixtures that passed under both correct and buggy code; every new test must be verified to actually fail against a deliberately-reverted implementation before being accepted).

Required coverage:
- Single-store passthrough (proves `queryRAG` backward compatibility unchanged).
- Multi-store RRF fusion — discriminating fixture where a doc is findable *only* in store B, must survive fusion.
- Budget trimming honestly reports `dropped` — nothing silently disappears.
- Memory folds into token budget correctly (regression test proving the fix to the bug found in Phase 3 research, where history wasn't counted).
- Tool-results fold into context correctly.
- Priority order actually determines trim order under budget pressure.
- Fact write-path: contradiction/supersession correctly invalidates old fact, never deletes.
- Fact read-path: temporally invalid facts excluded from results.
- Multi-db fan-out: one store timing out produces partial results + warning, not a hard failure.

## Phasing

Each phase gets its own implementation plan (via writing-plans/subagent-driven-development), executed in both vectra-js and vectra-py in lockstep — same tasks, same review cadence, not JS-then-port (native parity is the differentiation, per the competitive research above).

1. **Memory layer** — bi-temporal fact store: write-path extraction/invalidation, read-path graph+vector retrieval. Foundational; everything else consumes it.
2. **Context layer core** — `buildContext`/`build_context` (Tier 1) + `context.ask` (Tier 2), budget/priority/dropped-reporting, single-store only in this phase.
3. **Multi-db fusion** — fan-out across N stores, RRF across store boundaries, timeout/circuit-breaker.
4. **New vector store backends** — SurrealDB + others (final priority order set at plan time for this phase).

## Self-review notes

- **Placeholder scan**: no TBD/TODO. The one open item (numeric performance SLOs) is explicitly deferred with a stated reason (nothing to benchmark yet), not silently left vague.
- **Scope check**: appropriately large for a 4-phase decomposition, each phase independently plannable/shippable, matching this session's established Phase N pattern.
- **Consistency**: fact store, context layer, and multi-db fusion all reuse existing abstractions (LLM `generate()`, embedder, RRF fusion math) rather than introducing parallel implementations — deliberate, keeps the two SDKs' drift risk down (a real problem hit repeatedly this session, e.g. the Milvus score bug found independently in both languages).
