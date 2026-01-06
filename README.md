# Vectra (Node.js)

**Vectra** is a **production-grade, provider-agnostic Node.js SDK** for building **end-to-end Retrieval-Augmented Generation (RAG)** systems. It is designed for teams that need **flexibility, extensibility, correctness, and observability** across embeddings, vector databases, retrieval strategies, and LLM providers—without locking into a single vendor.

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
* [2. Design Goals & Philosophy](#2-design-goals--philosophy)
* [3. Feature Matrix](#3-feature-matrix)
* [4. Installation](#4-installation)
* [5. Quick Start](#5-quick-start)
* [6. Core Concepts](#6-core-concepts)

  * [Providers](#providers)
  * [Vector Stores](#vector-stores)
  * [Chunking](#chunking)
  * [Retrieval](#retrieval)
  * [Reranking](#reranking)
  * [Metadata Enrichment](#metadata-enrichment)
  * [Query Planning & Grounding](#query-planning--grounding)
  * [Conversation Memory](#conversation-memory)
* [7. Configuration Reference (Usage‑Driven)](#7-configuration-reference-usage-driven)
* [8. Ingestion Pipeline](#8-ingestion-pipeline)
* [9. Querying & Streaming](#9-querying--streaming)
* [10. Conversation Memory](#10-conversation-memory)
* [11. Evaluation & Quality Measurement](#11-evaluation--quality-measurement)
* [12. CLI](#12-cli)

  * [Ingest & Query](#ingest--query)
  * [WebConfig (Config Generator UI)](#webconfig-config-generator-ui)
  * [Observability Dashboard](#observability-dashboard)
* [13. Observability & Callbacks](#13-observability--callbacks)
* [14. Telemetry](#14-telemetry)
* [15. Database Schemas & Indexing](#15-database-schemas--indexing)
* [16. Extending Vectra](#16-extending-vectra)
* [17. Architecture Overview](#17-architecture-overview)
* [18. Development & Contribution Guide](#18-development--contribution-guide)
* [19. Production Best Practices](#19-production-best-practices)

---

## 1. Overview

Vectra provides a **fully modular RAG pipeline**:

```
Load → Chunk → Embed → Store → Retrieve → Rerank → Plan → Ground → Generate → Stream
```
<p align="center">
  <img src="https://vectra.thenxtgenagents.com/vectraArch.png" alt="Vectra SDK Architecture" width="900">
</p>

<p align="center">
  <em>Vectra SDK – End-to-End RAG Architecture</em>
</p>

Every stage is **explicitly configurable**, validated at runtime, and observable.

### Key Characteristics

* Provider‑agnostic LLM & embedding layer
* Multiple vector backends (Postgres, Chroma, Qdrant, Milvus)
* Advanced retrieval strategies (HyDE, Multi‑Query, Hybrid RRF, MMR)
* Unified streaming interface
* Built‑in evaluation & observability
* CLI + SDK parity

---

## 2. Design Goals & Philosophy

### Explicitness over Magic

Vectra avoids hidden defaults. Chunking, retrieval, grounding, memory, and generation behavior are always explicit.

### Production‑First

Index helpers, rate limiting, embedding cache, observability, and evaluation are first‑class features.

### Provider Neutrality

Swapping OpenAI → Gemini → Anthropic → Ollama requires **no application code changes**.

### Extensibility

Every major subsystem (providers, vector stores, callbacks) is interface‑driven.

---

## 3. Feature Matrix

### Providers

* **Embeddings**: OpenAI, Gemini, Ollama, HuggingFace
* **Generation**: OpenAI, Gemini, Anthropic, Ollama, OpenRouter, HuggingFace
* **Streaming**: Unified async generator

### Vector Stores

* PostgreSQL (Prisma + pgvector)
* PostgreSQL (native `pg` driver)
* ChromaDB
* Qdrant
* Milvus

### Retrieval Strategies

* Naive cosine similarity
* HyDE (Hypothetical Document Embeddings)
* Multi‑Query expansion
* Hybrid semantic + lexical (RRF)
* MMR diversification

---

## 4. Installation

### Library

```bash
npm install vectra-js
# or
pnpm add vectra-js
```

Backends:

```bash
npm install pg                    # https://node-postgres.com/
npm install @prisma/client       # https://prisma.io/docs
npm install chromadb              # https://docs.trychroma.com/
npm install qdrant-client         # https://qdrant.tech/documentation/
npm install pymilvus              # https://milvus.io/docs/
```

### CLI

```bash
npm i -g vectra-js
# or
pnpm add -g vectra-js
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
    columnMap: { 'content': 'content', 'metadata': 'metadata', 'vector': 'vector' }
  }
});

await client.ingestDocuments('./docs');
const res = await client.queryRAG('What is the vacation policy?');
console.log(res.answer);
```

---

## 6. Core Concepts

### Providers

Providers implement embeddings, generation, or both. Vectra normalizes outputs and streaming across providers.

### Vector Stores

Vector stores persist embeddings and metadata. They are fully swappable via config.

### Chunking

* **Recursive**: Character‑aware, separator‑aware splitting
* **Agentic**: LLM‑driven semantic propositions (best for policies, legal docs)

### Retrieval

Controls recall vs precision using multiple strategies.

### Reranking

Optional LLM‑based reordering of retrieved chunks.

### Metadata Enrichment

Optional per‑chunk summaries, keywords, and hypothetical questions generated at ingestion time.

### Query Planning & Grounding

Controls how context is assembled and how strictly answers must be grounded in retrieved text.

### Conversation Memory

Persist multi‑turn chat history across sessions.

---

## 7. Configuration Reference (Usage‑Driven)

> All configuration is validated using **Zod** at runtime.

### Embedding

```js
embedding: {
  provider: ProviderType.OPENAI,
  apiKey: process.env.OPENAI_API_KEY,
  modelName: 'text-embedding-3-small',
  dimensions: 1536
}
```

Use `dimensions` when using pgvector to avoid runtime mismatches.

---

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

Used for:

* Answer generation
* HyDE & Multi‑Query
* Agentic chunking
* Reranking

---

### Database

Supports Prisma, Postgres (native), Chroma, Qdrant, Milvus.

```js
// PostgreSQL (native pg)
database: {
  type: 'postgres',
  clientInstance: pool, // new Pool(...)
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
  collectionName: 'rag_collection'
}
```

```js
// Qdrant
database: {
  type: 'qdrant',
  clientInstance: qdrantClient,
  collectionName: 'rag_collection'
}
```

```js
// Milvus
database: {
  type: 'milvus',
  clientInstance: milvusClient,
  collectionName: 'rag_collection'
}
```

---

### Chunking

```js
chunking: {
  strategy: ChunkingStrategy.RECURSIVE,
  chunkSize: 1000,
  chunkOverlap: 200
}
```

Agentic chunking:

```js
chunking: {
  strategy: ChunkingStrategy.AGENTIC,
  agenticLlm: {
    provider: ProviderType.OPENAI,
    apiKey: process.env.OPENAI_API_KEY,
    modelName: 'gpt-4o-mini'
  }
}
```

---

### Retrieval

```js
retrieval: { strategy: RetrievalStrategy.HYBRID }
```

HYBRID is recommended for production.

---

### Reranking

```js
reranking: {
  enabled: true,
  windowSize: 20,
  topN: 5
}
```

---

### Memory

```js
memory: { enabled: true, type: 'in-memory', maxMessages: 20 }
```

Redis and Postgres are supported.

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
    clientInstance: pool, // pg Pool
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

---

### Observability

```js
observability: {
  enabled: true,
  sqlitePath: 'vectra-observability.db'
}
```

---

## 8. Ingestion Pipeline

```js
await client.ingestDocuments('./documents');
```

Supports files or directories.

Formats: PDF, DOCX, XLSX, TXT, Markdown

---

## 9. Querying & Streaming

```js
const res = await client.queryRAG('Refund policy?');
```

Streaming:

```js
const stream = await client.queryRAG('Draft email', null, true);
for await (const chunk of stream) process.stdout.write(chunk.delta || '');
```

---

## 10. Conversation Memory

Pass a `sessionId` to maintain context across turns.

---

## 11. Evaluation & Quality Measurement

```js
await client.evaluate([{ question: 'Capital of France?', expectedGroundTruth: 'Paris' }]);
```

Metrics:

* Faithfulness
* Relevance

---

## 12. CLI

### Ingest & Query

```bash
vectra ingest ./docs --config=./config.json
vectra query "What is our leave policy?" --config=./config.json --stream
```

---

### WebConfig (Config Generator UI)

```bash
vectra webconfig
```

**WebConfig** launches a local web UI that:

* Guides you through building a valid `vectra.config.json`
* Validates all options interactively
* Prevents misconfiguration

This is ideal for:

* First‑time setup
* Non‑backend users
* Sharing configs across teams

---

### Observability Dashboard

```bash
vectra dashboard
```

The **Observability Dashboard** is a local web UI backed by SQLite that visualizes:

* Ingestion latency
* Query latency
* Retrieval & generation traces
* Chat sessions

It helps you:

* Debug RAG quality issues
* Understand latency bottlenecks
* Monitor production‑like workloads

---

## 13. Observability & Callbacks

### Observability

Tracks metrics, traces, and sessions automatically when enabled.

### Callbacks

Lifecycle hooks:

* Ingestion
* Chunking
* Embedding
* Retrieval
* Reranking
* Generation
* Errors

---

## 14. Telemetry

Vectra collects anonymous usage data to help us improve the SDK, prioritize features, and detect broken versions.

### What we track

* **Identity**: A random UUID (`distinct_id`) stored locally in `~/.vectra/telemetry.json`. **No PII, emails, IPs, or hostnames.**
* **Events**:
    * `sdk_initialized`: Config shape (providers used), OS/Runtime version, session type (api/cli/chat).
    * `ingest_started/completed`: Source type, chunking strategy, duration bucket, chunk count bucket.
    * `query_executed`: Retrieval strategy, query mode (rag), result count, latency bucket.
    * `feature_used`: WebConfig/Dashboard usage.
    * `evaluation_run`: Dataset size bucket.
    * `error_occurred`: Error type and stage (no stack traces).
    * `cli_command_used`: Command name and flags.

### Why we track it

* **Detect broken versions**: Spikes in `error_occurred` help us find bugs.
* **Measure adoption**: Helps us understand which providers (OpenAI vs Gemini) and vector stores are most popular.
* **Drop support safely**: We can see if anyone is still using Node 18 before dropping it.

### How to opt-out

Telemetry is **enabled by default**. To disable it:

**Option 1: Config**

```js
const client = new VectraClient({
  // ...
  telemetry: { enabled: false }
});
```

**Option 2: Environment Variable**

Set `VECTRA_TELEMETRY_DISABLED=1` or `DO_NOT_TRACK=1`.

---

## 15. Database Schemas & Indexing

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

## 16. Extending Vectra

### Custom Vector Store

```js
class MyStore extends VectorStore {
  async addDocuments() {}
  async similaritySearch() {}
}
```

---

## 17. Architecture Overview

* `VectraClient`: orchestrator
* Typed config schema
* Interface‑driven providers & stores
* Unified streaming abstraction

---

## 18. Development & Contribution Guide

* Node.js 18+
* pnpm recommended
* Lint: `pnpm run lint`

---

## 19. Production Best Practices

* Match embedding dimensions to pgvector
* Prefer HYBRID retrieval
* Enable observability in staging
* Evaluate before changing chunk sizes

---

**Vectra scales cleanly from local prototypes to production‑grade RAG platforms.**
