# Vectra (Node.js)

Vectra is a production-grade, provider-agnostic Node.js SDK for building retrieval-augmented generation systems. It handles the full pipeline from loading documents to streaming an answer back to the user, and it's built so you can swap out any piece (embedding provider, vector store, LLM, retrieval strategy) without rewriting application code.

![GitHub Release](https://img.shields.io/github/v/release/iamabhishek-n/vectra-js)
![NPM Version](https://img.shields.io/npm/v/vectra-js)
![NPM Downloads](https://img.shields.io/npm/dm/vectra-js)
[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=iamabhishek-n_vectra-js&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=iamabhishek-n_vectra-js)

If you find this project useful, consider supporting it:<br>
[![Star this project on GitHub](https://img.shields.io/github/stars/iamabhishek-n/vectra-js?style=social)](https://github.com/iamabhishek-n/vectra-js/stargazers)
[![Sponsor me on GitHub](https://img.shields.io/badge/Sponsor%20me%20on-GitHub-%23FFD43B?logo=github)](https://github.com/sponsors/iamabhishek-n)
[![Buy me a Coffee](https://img.shields.io/badge/Buy%20me%20a%20Coffee-%23FFDD00?logo=buy-me-a-coffee&logoColor=black)](https://www.buymeacoffee.com/iamabhishekn)

## Table of Contents

* [1. Overview](#1-overview)
* [2. Design Goals](#2-design-goals)
* [3. Feature Matrix](#3-feature-matrix)
* [4. Installation](#4-installation)
* [5. Quick Start](#5-quick-start)
* [6. Core Concepts](#6-core-concepts)
* [7. Configuration Reference](#7-configuration-reference)
* [8. Context and Memory Layer](#8-context-and-memory-layer)
* [9. Ingestion Pipeline](#9-ingestion-pipeline)
* [10. Querying and Streaming](#10-querying-and-streaming)
* [11. Conversation Memory](#11-conversation-memory)
* [12. Evaluation](#12-evaluation)
* [13. CLI](#13-cli)
* [14. Observability and Callbacks](#14-observability-and-callbacks)
* [15. Telemetry](#15-telemetry)
* [16. Guardrails](#16-guardrails)
* [17. Database Schema](#17-database-schema)
* [18. Extending Vectra](#18-extending-vectra)
* [19. Architecture](#19-architecture)
* [20. Development](#20-development)
* [21. Production Notes](#21-production-notes)

---

## 1. Overview

The pipeline looks like this:

```
Load -> Chunk -> Embed -> Store -> Retrieve -> Rerank -> Plan -> Ground -> Generate -> Stream
```

<p align="center">
  <img src="https://vectra.thenxtgenagents.com/vectraArch.png" alt="Vectra SDK Architecture" width="900">
</p>

<p align="center">
  <em>Vectra SDK, end to end RAG architecture</em>
</p>

Every stage is explicit. There's no hidden default embedding model, no silent fallback vector store, no magic. If something isn't configured, Vectra tells you rather than guessing.

### What's in the box

* A provider-agnostic embedding and generation layer (OpenAI, Gemini, Anthropic, Ollama, OpenRouter, HuggingFace)
* Seven vector store backends, swappable via one config key
* Retrieval strategies beyond naive cosine similarity: HyDE, multi-query expansion, hybrid RRF, MMR
* A context and memory layer for assembling budget-aware prompts and carrying facts across sessions
* A CLI with the same capabilities as the SDK, plus a local web UI for config and observability

---

## 2. Design Goals

**Explicit over implicit.** Chunking, retrieval, grounding and memory behavior are all things you configure on purpose. Vectra won't quietly pick a strategy for you.

**Production-first.** Rate limiting, embedding caching, index helpers, observability and evaluation aren't add-ons bolted on later. They're part of the core design.

**No vendor lock-in.** Moving from OpenAI to Gemini, or from Postgres to Qdrant, is a config change. Your ingestion and query code doesn't move.

**Interfaces you can extend.** Providers, vector stores and middleware are all built against small interfaces. Writing your own backend is a matter of implementing a handful of methods, not fighting the framework.

---

## 3. Feature Matrix

**Providers**

* Embeddings: OpenAI, Gemini, Ollama, HuggingFace
* Generation: OpenAI, Gemini, Anthropic, Ollama, OpenRouter, HuggingFace
* Streaming: one unified async generator interface across all of them

**Vector stores**

* PostgreSQL via Prisma and pgvector
* PostgreSQL via the native `pg` driver
* ChromaDB
* Qdrant
* Milvus
* Pinecone
* Weaviate (native hybrid search and filter-based listing, not the client-side fallback the others use)

**Retrieval strategies**

* Naive cosine similarity
* HyDE (hypothetical document embeddings)
* Multi-query expansion
* Hybrid semantic and lexical search, fused with reciprocal rank fusion
* MMR diversification

---

## 4. Installation

```bash
npm install vectra-js
# or
pnpm add vectra-js
```

Install the client for whichever backend you're using. Vectra doesn't bundle these, since most projects only need one or two.

```bash
npm install pg                        # native Postgres, https://node-postgres.com/
npm install @prisma/client            # Prisma + pgvector, https://prisma.io/docs
npm install chromadb                  # ChromaDB, https://docs.trychroma.com/
npm install @qdrant/js-client-rest    # Qdrant, https://qdrant.tech/documentation/
npm install @zilliz/milvus2-sdk-node  # Milvus, https://milvus.io/docs/
npm install @pinecone-database/pinecone  # Pinecone, https://docs.pinecone.io/
npm install weaviate-client           # Weaviate, https://weaviate.io/developers/weaviate
```

For the CLI:

```bash
npm i -g vectra-js
```

---

## 5. Quick Start

```js
const { VectraClient, ProviderType } = require('vectra-js');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

const client = new VectraClient({
  embedding: {
    provider: ProviderType.OPENAI,
    apiKey: process.env.OPENAI_API_KEY,
    modelName: 'text-embedding-3-small'
  },
  llm: {
    provider: ProviderType.GEMINI,
    apiKey: process.env.GOOGLE_API_KEY,
    modelName: 'gemini-2.5-flash'
  },
  database: {
    type: 'postgres',
    clientInstance: pool,
    tableName: 'document',
    columnMap: { content: 'content', metadata: 'metadata', vector: 'vector' }
  }
});

await client.ingestDocuments('./docs');
const res = await client.queryRAG('What is the vacation policy?');
console.log(res.answer);
```

That's the whole setup for a working RAG pipeline. Everything past this point is about tuning it.

---

## 6. Core Concepts

**Providers** implement embeddings, generation, or both. Vectra normalizes the response shape and the streaming interface so switching providers doesn't touch your call sites.

**Vector stores** persist embeddings and metadata. They're swappable through config, and every backend implements the same interface (add, search, hybrid search, list, delete, file-exists check).

**Chunking** has two strategies: recursive character-aware splitting for most content, and agentic LLM-driven splitting for documents where semantic boundaries matter more than character counts (contracts, policies, anything dense).

**Retrieval** is where you trade recall for precision. Hybrid is the sane default for production; the others exist for cases where you know your query distribution well enough to hand-tune.

**Reranking** is an optional second pass that reorders retrieved chunks with an LLM before they're used, usually worth the extra latency when precision matters more than speed.

**Metadata enrichment** generates summaries, keywords and hypothetical questions per chunk at ingestion time, which improves retrieval quality at the cost of a slower ingest.

**Query planning and grounding** control how retrieved context gets assembled into a prompt and how strictly the model is required to stick to what it was given.

**Conversation memory** persists chat history across turns. Section 8 covers a second, complementary kind of memory: durable facts extracted from conversations, not just the raw transcript.

---

## 7. Configuration Reference

All configuration is validated with Zod at runtime, so a typo in a config key fails loudly at startup instead of silently doing nothing.

### Embedding

```js
embedding: {
  provider: ProviderType.OPENAI,
  apiKey: process.env.OPENAI_API_KEY,
  modelName: 'text-embedding-3-small',
  dimensions: 1536
}
```

Set `dimensions` explicitly when using pgvector. The column is created with a fixed dimension, and a mismatch fails at query time rather than at startup.

### LLM

```js
llm: {
  provider: ProviderType.GEMINI,
  apiKey: process.env.GOOGLE_API_KEY,
  modelName: 'gemini-2.5-flash',
  temperature: 0.3,
  maxTokens: 1024
}
```

This model is used for answer generation, HyDE, multi-query expansion, agentic chunking and reranking, unless you override any of those with their own `llmConfig`.

### Database

```js
// Native Postgres
database: {
  type: 'postgres',
  clientInstance: pool,
  tableName: 'document',
  columnMap: { content: 'content', metadata: 'metadata', vector: 'vector' }
}
```

```js
// Prisma
database: {
  type: 'prisma',
  clientInstance: prisma,
  tableName: 'Document',
  columnMap: { content: 'content', metadata: 'metadata', vector: 'embedding' }
}
```

```js
// ChromaDB
database: {
  type: 'chroma',
  clientInstance: chromaClient,
  tableName: 'rag_collection'
}
```

```js
// Qdrant
database: {
  type: 'qdrant',
  clientInstance: qdrantClient,
  tableName: 'rag_collection'
}
```

```js
// Milvus
database: {
  type: 'milvus',
  clientInstance: milvusClient,
  tableName: 'rag_collection',
  metricType: 'COSINE' // or 'IP', 'L2', matching how the collection was created
}
```

```js
// Pinecone
database: {
  type: 'pinecone',
  clientInstance: pineconeIndex, // an Index handle from the Pinecone client
  tableName: 'my-namespace'      // optional, maps to a Pinecone namespace
}
```

Pinecone has no listing or scroll endpoint, so `listDocuments` throws a clear error on this backend rather than pretending to support it.

```js
// Weaviate
database: {
  type: 'weaviate',
  clientInstance: weaviateClient, // a v3 collections-API client
  tableName: 'Document'           // the collection name
}
```

Weaviate supports hybrid search and filtered listing natively, so this backend skips the client-side fusion the other backends fall back to.

### Chunking

```js
chunking: {
  strategy: ChunkingStrategy.RECURSIVE,
  chunkSize: 1000,
  chunkOverlap: 200
}
```

```js
// Agentic
chunking: {
  strategy: ChunkingStrategy.AGENTIC,
  agenticLlm: {
    provider: ProviderType.OPENAI,
    apiKey: process.env.OPENAI_API_KEY,
    modelName: 'gpt-4o-mini'
  }
}
```

### Retrieval

```js
retrieval: { strategy: RetrievalStrategy.HYBRID }
```

### Reranking

```js
reranking: {
  enabled: true,
  windowSize: 20,
  topN: 5
}
```

### Conversation memory

```js
memory: { enabled: true, type: 'in-memory', maxMessages: 20 }
```

```js
// Redis
memory: {
  enabled: true,
  type: 'redis',
  maxMessages: 20,
  redis: {
    clientInstance: redisClient,
    keyPrefix: 'vectra:chat:'
  }
}
```

```js
// Postgres
memory: {
  enabled: true,
  type: 'postgres',
  maxMessages: 20,
  postgres: {
    clientInstance: pool,
    tableName: 'ChatMessage',
    columnMap: {
      sessionId: 'sessionId',
      role: 'role',
      content: 'content',
      createdAt: 'createdAt'
    }
  }
}
```

### Observability

```js
observability: {
  enabled: true,
  sqlitePath: 'vectra-observability.db'
}
```

---

## 8. Context and Memory Layer

Conversation memory (section 11) stores the raw back-and-forth. The context layer is a different thing: it's the primitive that assembles whatever a model needs to see, from whatever sources you have, packed into a token budget, with nothing dropped silently.

The simplest entry point is `client.context.ask`, which runs guardrails and middleware the same way `queryRAG` does, retrieves from your configured vector store, and packs the result:

```js
const packed = await client.context.ask('what did we agree on for pricing?', {
  sessionId: 'user-42'
});

console.log(packed.text);          // the assembled context, ready to hand to an LLM
console.log(packed.tokensUsed, packed.tokensBudget);
if (packed.warnings.length) console.warn(packed.warnings);
```

`packed.dropped` and `packed.warnings` are never silent. If a source ran out of budget or a store timed out, it shows up there instead of just vanishing.

### Durable facts

Alongside raw conversation history, Vectra can maintain a separate store of facts extracted from conversations, each with a validity window rather than a hard delete. When a new fact contradicts an old one, the old one is marked invalid at that point in time instead of being erased, so you can still answer "what did we believe last month."

Turn this on by adding a `facts` block under `memory`, pointing at a Postgres-compatible client (the fact store uses pgvector under the hood):

```js
memory: {
  enabled: true,
  facts: {
    enabled: true,
    clientInstance: factsPool,
    tableName: 'VectraFact'
  }
}
```

Once enabled, `client.factStore` is available directly on the client:

```js
await client.factStore.ensureIndexes(); // run once, sets up the table and indexes

await client.factStore.write('user-42', {
  userMessage: 'Our deploy target is Tokyo from now on.',
  assistantMessage: 'Got it, defaulting to the Tokyo region.'
});

// context.ask automatically pulls relevant facts into the packed context
// once a fact store is configured and a sessionId is passed in.
const packed = await client.context.ask('where should this deploy?', { sessionId: 'user-42' });
```

Writing facts isn't automatic. `queryRAG` doesn't call `factStore.write` for you, so if you want facts to persist you call it yourself after a turn completes, with whatever extraction trigger makes sense for your app.

---

## 9. Ingestion Pipeline

```js
await client.ingestDocuments('./documents');
```

Works on a single file or a directory, walked recursively. Supported formats: PDF, DOCX, XLSX, TXT, Markdown.

---

## 10. Querying and Streaming

```js
const res = await client.queryRAG('Refund policy?');
```

```js
const stream = await client.queryRAG('Draft an email', null, true);
for await (const chunk of stream) process.stdout.write(chunk.delta || '');
```

---

## 11. Conversation Memory

Pass a `sessionId` to `queryRAG` to carry history across turns. This is the raw transcript, separate from the fact store described in section 8.

---

## 12. Evaluation

```js
await client.evaluate([
  { question: 'Capital of France?', expectedGroundTruth: 'Paris' }
]);
```

Reports faithfulness and relevance scores against your ground truth set.

---

## 13. CLI

```bash
vectra ingest ./docs --config=./config.json
vectra query "What is our leave policy?" --config=./config.json --stream
```

**WebConfig** is a local UI for building and validating a `vectra.config.json` without hand-writing it, useful the first time you set up a project or when handing config off to someone non-technical.

```bash
vectra webconfig
```

**Dashboard** is a local, SQLite-backed UI showing ingestion latency, query latency, retrieval and generation traces, and chat sessions. Point it at your `observability.sqlitePath`.

```bash
vectra dashboard
```

---

## 14. Observability and Callbacks

Enabling `observability` records metrics, traces and sessions automatically. Callbacks give you hooks into ingestion, chunking, embedding, retrieval, reranking, generation and errors, if you want to wire your own logging or metrics on top.

---

## 15. Telemetry

Vectra collects anonymous usage data to help prioritize features and catch broken releases. It's off by default.

What's tracked: a random UUID stored locally in `~/.vectra/telemetry.json` (no PII, no emails, no IPs), plus coarse event data like which providers and vector stores get configured, ingestion batch sizes and durations, which retrieval strategy gets used, and error types by stage (no stack traces, no query content).

Turn it on explicitly if you want to help:

```js
const client = new VectraClient({
  // ...
  telemetry: { enabled: true }
});
```

`VECTRA_TELEMETRY_DISABLED=1` or `DO_NOT_TRACK=1` in the environment overrides the config either way, so it's a reliable way to guarantee nothing gets sent regardless of what a config file says.

---

## 16. Guardrails

`queryRAG` enforces a few defaults before anything gets embedded or sent to an LLM:

* `maxQueryLength` (default 2000 characters): longer queries are rejected outright.
* `blockPii` (default off): rejects queries that look like they contain an email, phone number, SSN-shaped number or a long digit run.
* `contentFilter` (default off): rejects queries matching a small built-in list of harmful phrases, extendable with `blockedTerms`.

Ingestion enforces `ingestion.maxFileSizeBytes` (default 50MB) before reading a file.

If you're upgrading from an older version: the 2000-character query limit and the 50MB file limit are enforced now even if you never set a `guardrails` or `ingestion` block. They existed in the schema before this release but weren't actually checked. To raise them:

```js
const client = new VectraClient({
  // ...
  guardrails: { maxQueryLength: 10000, contentFilter: true, blockedTerms: ['some phrase'] },
  ingestion: { maxFileSizeBytes: 200 * 1024 * 1024 }
});
```

The exact detection logic lives in `src/guardrails.js` if you need to know precisely what triggers a block.

---

## 17. Database Schema

For Prisma users, something like this:

```prisma
model Document {
  id        String   @id @default(uuid())
  content   String
  metadata  Json
  vector    Unsupported("vector")?
  createdAt DateTime @default(now())
}
```

---

## 18. Extending Vectra

Every vector store implements the same small interface. To add your own:

```js
class MyStore extends VectorStore {
  async addDocuments(documents) { /* ... */ }
  async similaritySearch(vector, limit, filter) { /* ... */ }
  async hybridSearch(text, vector, limit, filter) { /* ... */ }
  async listDocuments({ filter, limit, cursor }) { /* ... */ }
  async deleteDocuments({ ids, filter }) { /* ... */ }
  async fileExists(sha256, size, lastModified) { /* ... */ }
}
```

You don't need to implement everything from scratch. If your store has no native hybrid search, follow the pattern in `src/backends/qdrant_store.js`: pull a wider candidate pool with `similaritySearch`, score it against the query lexically, and fuse the two rankings with reciprocal rank fusion.

---

## 19. Architecture

`VectraClient` is the orchestrator. Config is parsed and validated once at construction. Providers and vector stores are chosen behind interfaces, so nothing downstream needs to know which one is active. Streaming uses one generator shape regardless of provider.

---

## 20. Development

* Node.js 18 or newer
* pnpm is the recommended package manager
* `pnpm run lint` before committing

---

## 21. Production Notes

Match your embedding `dimensions` to whatever your vector column was created with, especially on pgvector where a mismatch is a runtime error, not a warning. Prefer hybrid retrieval unless you have a specific reason not to. Turn on observability in staging before you need it in an incident. Re-run evaluation before changing chunk size or embedding model, since both quietly shift retrieval quality in ways that are easy to miss without a baseline.
