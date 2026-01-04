# Vectra (Node.js)

A production-ready, provider-agnostic Node.js SDK for End-to-End RAG (Retrieval-Augmented Generation) pipelines.

![GitHub Release](https://img.shields.io/github/v/release/iamabhishek-n/vectra-js)
![NPM Version](https://img.shields.io/npm/v/vectra-js)
![NPM Downloads](https://img.shields.io/npm/dm/vectra-js)
[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=iamabhishek-n_vectra-js&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=iamabhishek-n_vectra-js)

If you find this project useful, consider supporting it:
[![Sponsor me on GitHub](https://img.shields.io/badge/Sponsor%20me%20on-GitHub-%23FFD43B?logo=github)](https://github.com/sponsors/iamabhishek-n)
[![Buy me a Coffee](https://img.shields.io/badge/Buy%20me%20a%20Coffee-%23FFDD00?logo=buy-me-a-coffee&logoColor=black)](https://www.buymeacoffee.com/iamabhishekn)

## Features

*   **Multi-Provider Support**: First-class support for **OpenAI**, **Gemini**, **Anthropic**, **OpenRouter**, and **Hugging Face**.
*   **Modular Vector Store**:
    *   **Prisma**: Use your existing PostgreSQL database with `pgvector` (via Prisma).
    *   **Native PostgreSQL**: Direct connection to PostgreSQL using `pg` driver (no ORM required).
    *   **ChromaDB**: Native support for the open-source vector database.
    *   **Qdrant & Milvus**: Additional backends for portability.
    *   **Extensible**: Easily add others by extending the `VectorStore` class.
*   **Advanced Chunking**:
    *   **Recursive**: Smart splitting based on characters and separators.
    *   **Token-Aware**: Sentence/paragraph fallback and adaptive overlap based on local entropy.
    *   **Agentic**: Uses an LLM to split text into semantically complete propositions with JSON validation and dedupe.
*   **Advanced Retrieval Strategies**:
    *   **Naive**: Standard cosine similarity search.
    *   **HyDE (Hypothetical Document Embeddings)**: Generates a fake answer to the query and searches for that.
    *   **Multi-Query**: Generates multiple variations of the query to catch different phrasings.
    *   **Hybrid Search**: Combines semantic (pgvector) and lexical (FTS) results using **Reciprocal Rank Fusion (RRF)**.
    *   **MMR**: Diversifies results to reduce redundancy.
*   **Streaming**: Full support for token-by-token streaming responses.
*   **Reranking**: LLM-based reranking to re-order retrieved documents for maximum relevance.
*   **File Support**: Native parsing for PDF, DOCX, XLSX, TXT, and Markdown.
*   **Index Helpers**: ivfflat for pgvector, GIN FTS index, optional tsvector trigger.
*   **Embedding Cache**: SHA256 content-based cache to skip re-embedding.
*   **Batch Embeddings**: Gemini and OpenAI adapters support array inputs and dimension control.
*   **Metadata Enrichment**: Per-chunk summary, keywords, hypothetical questions; page and section mapping for PDFs/Markdown. Retrieval boosts matching keywords and uses summaries in prompts.
*   **Conversation Memory**: Built-in chat history management for context-aware multi-turn conversations.
*   **Production Evaluation**: Integrated evaluation module to measure RAG quality (Faithfulness, Relevance).
*   **Local LLMs**: First-class support for **Ollama** for local/offline development.
*   **Web Configuration UI**: Visual generator to create and validate your configuration file (`vectra webconfig`).

---

## Installation

```bash
# Library (npm)
npm install vectra-js @prisma/client
npm install chromadb # optional: ChromaDB backend

# Library (pnpm)
pnpm add vectra-js @prisma/client
pnpm add chromadb # optional

# CLI (global install)
npm i -g vectra-js    # or: pnpm add -g vectra-js

# CLI (no global install)
# Uses local project bin if vectra-js is installed
npx vectra ingest ./docs --config=./config.json

# CLI (one-off run with pnpm dlx)
pnpm dlx vectra-js vectra query "What is our leave policy?" --config=./config.json --stream
```

---

## Usage Guide

### 1. Configuration

The SDK uses a strictly typed configuration object (validated with Zod).

```javascript
const { ProviderType, ChunkingStrategy, RetrievalStrategy } = require('vectra-js');

const config = {
  // 1. Embedding Provider
  embedding: {
    provider: ProviderType.OPENAI,
    apiKey: process.env.OPENAI_API_KEY,
    modelName: 'text-embedding-3-small',
    dimensions: 1536 // Optional
  },

  // 2. LLM Provider (for Generation)
  llm: {
    provider: ProviderType.GEMINI,
    apiKey: process.env.GOOGLE_API_KEY,
    modelName: 'gemini-1.5-pro-latest'
  },

  // 3. Database (Modular)
  database: {
    type: 'prisma', // or 'chroma'
    clientInstance: prismaClient, // Your instantiated DB client
    tableName: 'Document', // Table or Collection name
    columnMap: { // Map SDK fields to your DB columns
       content: 'text',
       vector: 'embedding',
       metadata: 'meta'
    }
  },

  // 4. Chunking (Optional)
  chunking: {
    strategy: ChunkingStrategy.RECURSIVE,
    chunkSize: 1000,
    chunkOverlap: 200
  },

  // 5. Retrieval (Optional)
  retrieval: {
    strategy: RetrievalStrategy.HYBRID, // Uses RRF
    llmConfig: { /* Config for query rewriting LLM */ }
  }
};
```

### Configuration Reference

- Embedding
  - `provider`: one of `ProviderType.OPENAI`, `ProviderType.GEMINI`
  - `apiKey`: provider API key string
  - `modelName`: embedding model identifier
  - `dimensions`: number; ensures vector size matches DB `pgvector(n)`
- LLM
  - `provider`: `ProviderType.OPENAI` | `ProviderType.GEMINI` | `ProviderType.ANTHROPIC` | `ProviderType.OLLAMA`
  - `apiKey`: provider API key string (optional for Ollama)
  - `modelName`: generation model identifier
  - `baseUrl`: optional custom URL (e.g., for Ollama)
  - `temperature`: number; optional sampling temperature
  - `maxTokens`: number; optional max output tokens
- Memory
  - `enabled`: boolean; toggle memory on/off (default: false)
  - `type`: `'in-memory' | 'redis' | 'postgres'`
  - `maxMessages`: number; number of recent messages to retain (default: 20)
  - `redis`: `{ clientInstance, keyPrefix }` where `keyPrefix` defaults to `'vectra:chat:'`
  - `postgres`: `{ clientInstance, tableName, columnMap }` where `tableName` defaults to `'ChatMessage'` and `columnMap` maps `{ sessionId, role, content, createdAt }`
- Ingestion
  - `rateLimitEnabled`: boolean; toggle rate limiting on/off (default: false)
  - `concurrencyLimit`: number; max concurrent embedding requests when enabled (default: 5)
  - `mode`: `'skip' | 'append' | 'replace'`; idempotency behavior (default: `'skip'`)
- Database
  - `type`: `prisma` | `chroma` | `qdrant` | `milvus`
  - `clientInstance`: instantiated client for the chosen backend
  - `tableName`: table/collection name (Postgres/Qdrant/Milvus)
  - `columnMap`: maps SDK fields to DB columns
    - `content`: text column name
    - `vector`: embedding vector column name (for Postgres pgvector)
    - `metadata`: JSON column name for per-chunk metadata
- Chunking
  - `strategy`: `ChunkingStrategy.RECURSIVE` | `ChunkingStrategy.AGENTIC`
  - `chunkSize`: number; preferred chunk size (characters)
  - `chunkOverlap`: number; overlap between adjacent chunks (characters)
  - `separators`: array of string separators to split on (optional)
- Retrieval
  - `strategy`: `RetrievalStrategy.NAIVE` | `HYDE` | `MULTI_QUERY` | `HYBRID` | `MMR`
  - `llmConfig`: optional LLM config for query rewriting (HyDE/Multi-Query)
  - `mmrLambda`: \(0..1\) tradeoff between relevance and diversity (default: 0.5)
  - `mmrFetchK`: candidate pool size for MMR (default: 20)
- Reranking
  - `enabled`: boolean; enable LLM-based reranking
  - `topN`: number; final number of docs to keep (optional)
  - `windowSize`: number; number of docs considered before reranking
  - `llmConfig`: optional LLM config for the reranker
- Metadata
  - `enrichment`: boolean; generate `summary`, `keywords`, `hypothetical_questions`
- Callbacks
  - `callbacks`: array of handlers; use `LoggingCallbackHandler` or `StructuredLoggingCallbackHandler`
- Observability
  - `enabled`: boolean; enable SQLite-based observability (default: false)
  - `sqlitePath`: string; path to SQLite database file (default: 'vectra-observability.db')
  - `projectId`: string; project identifier for multi-project support (default: 'default')
  - `trackMetrics`: boolean; track latency and other metrics
  - `trackTraces`: boolean; track detailed workflow traces
  - `sessionTracking`: boolean; track chat sessions
- Index Helpers (Postgres + Prisma)
  - `ensureIndexes()`: creates ivfflat and GIN FTS indexes and optional `tsvector` trigger


### 2. Initialization & Ingestion

```javascript
const { VectraClient } = require('vectra-js');
const client = new VectraClient(config);

// Ingest a file (supports .pdf, .docx, .txt, .md, .xlsx)
// This will: Load -> Chunk -> Embed -> Store
await client.ingestDocuments('./documents/employee_handbook.pdf');
// Ensure indexes (Postgres + Prisma)
if (config.database.type === 'prisma' && client.vectorStore.ensureIndexes) {
  await client.vectorStore.ensureIndexes();
}
// Enable metadata enrichment
// metadata: { enrichment: true }
```

### Document Management

```javascript
// List recent documents (by metadata filter)
const docs = await client.listDocuments({ filter: { docTitle: 'Employee Handbook' }, limit: 50 });

// Delete by ids or metadata filter
await client.deleteDocuments({ ids: docs.map(d => d.id) });
// or:
await client.deleteDocuments({ filter: { absolutePath: '/abs/path/to/file.pdf' } });

// Update existing docs (requires backend upsert support)
await client.updateDocuments([
  { id: docs[0].id, content: 'Updated content', metadata: { docTitle: 'Employee Handbook' } }
]);
```

### 3. Querying (Standard)

```javascript
const response = await client.queryRAG("What is the vacation policy?");

console.log("Answer:", response.answer);
console.log("Sources:", response.sources); // Metadata of retrieved chunks
```

### 4. Querying (Streaming)

Ideal for Chat UIs. Returns an Async Generator of unified chunks.

```javascript
const stream = await client.queryRAG("Draft a welcome email...", null, true);

for await (const chunk of stream) {
  process.stdout.write(chunk.delta || "");
}
```

### 5. Conversation Memory

Enable multi-turn conversations by configuring memory and passing a `sessionId`.

```javascript
// In config (enable memory: default is off)
const config = {
  // ...
  memory: { enabled: true, type: 'in-memory', maxMessages: 10 }
};

// Redis-backed memory
const redis = /* your redis client instance */;
const configRedis = {
  // ...
  memory: {
    enabled: true,
    type: 'redis',
    redis: { clientInstance: redis, keyPrefix: 'vectra:chat:' },
    maxMessages: 20
  }
};

// Postgres-backed memory
const prisma = /* your Prisma client instance */;
const configPostgres = {
  // ...
  memory: {
    enabled: true,
    type: 'postgres',
    postgres: {
      clientInstance: prisma,
      tableName: 'ChatMessage',
      columnMap: { sessionId: 'sessionId', role: 'role', content: 'content', createdAt: 'createdAt' }
    },
    maxMessages: 20
  }
};

// In your app:
const sessionId = 'user-123-session-abc';
const response = await client.queryRAG("What is the refund policy?", null, false, sessionId);
const followUp = await client.queryRAG("Does it apply to sale items?", null, false, sessionId);
```

### 6. Production Evaluation

Measure the quality of your RAG pipeline using the built-in evaluation module.

```javascript
const testSet = [
  { 
    question: "What is the capital of France?", 
    expectedGroundTruth: "Paris is the capital of France." 
  }
];

const results = await client.evaluate(testSet);

console.log(`Faithfulness: ${results.averageFaithfulness}`);
console.log(`Relevance: ${results.averageRelevance}`);
```

---

## Supported Providers & Backends

| Feature | OpenAI | Gemini | Anthropic | Ollama | OpenRouter | HuggingFace |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Embeddings** | ✅ | ✅ | ❌ | ✅ | ❌ | ✅ |
| **Generation** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Streaming** | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ |

### Ollama (Local)
- Use Ollama for local, offline development.
- Set `provider = ProviderType.OLLAMA`.
- Default `baseUrl` is `http://localhost:11434`.
```javascript
const config = {
  embedding: { provider: ProviderType.OLLAMA, modelName: 'nomic-embed-text' },
  llm: { provider: ProviderType.OLLAMA, modelName: 'llama3' }
};
```

### OpenRouter (Generation)
- Use OpenRouter as a unified generation provider.
- Set `llm.provider = ProviderType.OPENROUTER`, `llm.modelName` to a supported model (e.g., `openai/gpt-4o`).
- Provide `OPENROUTER_API_KEY`; optional attribution via `OPENROUTER_REFERER`, `OPENROUTER_TITLE`.
```javascript
const config = {
  llm: {
    provider: ProviderType.OPENROUTER,
    apiKey: process.env.OPENROUTER_API_KEY,
    modelName: 'openai/gpt-4o',
    defaultHeaders: {
      'HTTP-Referer': 'https://your.app',
      'X-Title': 'Your App'
    }
  }
};
```

### Database Schemas

**Prisma (PostgreSQL)**
```prisma
model Document {
  id        String                 @id @default(uuid())
  content   String
  metadata  Json
  vector    Unsupported("vector")? // pgvector type
  createdAt DateTime               @default(now())
}
```

**ChromaDB**
No schema required; collections are created automatically.

---

## API Reference

### `new VectraClient(config)`
Creates a new client instance. Throws error if config is invalid.

### `client.ingestDocuments(path: string): Promise<void>`
Reads a file **or recursively iterates a directory**, chunks content, embeds, and saves to the configured DB.
- If `path` is a file: Ingests that single file.
- If `path` is a directory: Recursively finds all supported files and ingests them.

### `client.queryRAG(query: string, filter?: object, stream?: boolean)`
Performs the RAG pipeline:
1.  **Retrieval**: Fetches relevant docs using `config.retrieval.strategy`.
2.  **Reranking**: (Optional) Re-orders docs using `config.reranking`.
3.  **Generation**: Sends context + query to LLM.

**Returns**:
*   If `stream=false` (default): `{ answer: string | object, sources: object[] }`
*   If `stream=true`: `AsyncGenerator<{ delta: string, finish_reason: string | null, usage: any | null }>`

### Advanced Configuration

- Query Planning
  - `queryPlanning.tokenBudget`: number; total token budget for context
  - `queryPlanning.preferSummariesBelow`: number; prefer metadata summaries under this budget
  - `queryPlanning.includeCitations`: boolean; include titles/sections/pages in context
- Grounding
  - `grounding.enabled`: boolean; enable extractive snippet grounding
  - `grounding.strict`: boolean; use only grounded snippets when true
  - `grounding.maxSnippets`: number; max snippets to include
- Generation
  - `generation.structuredOutput`: `'none' | 'citations'`; enable inline citations
  - `generation.outputFormat`: `'text' | 'json'`; return JSON when set to `json`
- Prompts
  - `prompts.query`: string template using `{{context}}` and `{{question}}`
  - `prompts.reranking`: optional template for reranker prompt
- Tracing
  - `tracing.enable`: boolean; enable provider/DB/pipeline span hooks

### CLI

Quickly ingest and query to validate configurations.

```bash
vectra ingest ./docs --config=./nodejs-test/config.json
vectra query "What is our leave policy?" --config=./nodejs-test/config.json --stream
```

### Ingestion Rate Limiting
- Toggle ingestion rate limiting via `config.ingestion`.
```javascript
const config = {
  // ...
  ingestion: { rateLimitEnabled: true, concurrencyLimit: 5 }
};
```

---

## Extending

### Custom Vector Store
Inherit from `VectorStore` class and implement `addDocuments` and `similaritySearch`.

```javascript
const { VectorStore } = require('vectra-js/interfaces');

class MyCustomDB extends VectorStore {
    async addDocuments(docs) { ... }
    async similaritySearch(vector, k) { ... }
}
```

---

## Developer Guide

### Setup
- Use `pnpm` for package management.
- Node.js 18+ recommended.
- Install with `pnpm install`.
- Lint with `pnpm run lint`.

### Environment
- `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `ANTHROPIC_API_KEY` for providers.
- Database client instance configured under `config.database.clientInstance`.

### Architecture
- Pipeline: Load → Chunk → Embed → Store → Retrieve → Rerank → Plan → Ground → Generate → Stream.
- Core client: `VectraClient` (library export).
- Configuration: `VectraConfig` (validated schema).
- Vector store interface: `VectorStore` (extend to add custom stores).
- Callbacks: `StructuredLoggingCallbackHandler` and custom handler support.

### Retrieval Strategies
- Supports NAIVE, HYDE, MULTI_QUERY, HYBRID (RRF fusion built-in).

### Query Planning & Grounding
- Context assembly respects `queryPlanning` (token budget, summary preference, citations).
- Snippet extraction controlled by `grounding` (strict mode and max snippets).

### Streaming Interface
- Unified streaming shape `{ delta, finish_reason, usage }` across OpenAI, Gemini, Anthropic.

### Adding a Provider
- Implement `embedDocuments`, `embedQuery`, `generate`, `generateStream`.
- Ensure streaming yields `{ delta, finish_reason, usage }`.
- Wire via `llm.provider` in config.

### Adding a Vector Store
- Extend `VectorStore`; implement `addDocuments`, `similaritySearch`, optionally `hybridSearch`.
- Select via `database.type` in config.

### Callbacks & Observability
- Available events: `onIngestStart`, `onIngestEnd`, `onIngestSummary`, `onChunkingStart`, `onEmbeddingStart`, `onRetrievalStart`, `onRetrievalEnd`, `onRerankingStart`, `onRerankingEnd`, `onGenerationStart`, `onGenerationEnd`, `onError`.
- Extend `StructuredLoggingCallbackHandler` to add error codes and payload sizes.

### CLI
- Binary `vectra` included with the package.
- Ingest: `vectra ingest <path> --config=./config.json`.
- Query: `vectra query "<text>" --config=./config.json --stream`.

### Coding Conventions
- CommonJS modules, flat ESLint config.
- Follow existing naming: `chunkIndex` in JS; use consistent casing.

---

## Feature Guide

### Embeddings
- Providers: `OPENAI`, `GEMINI`.
- Configure dimensions to match DB `pgvector(n)` when applicable.
- Example:
```javascript
const config = {
  embedding: {
    provider: ProviderType.OPENAI,
    apiKey: process.env.OPENAI_API_KEY,
    modelName: 'text-embedding-3-small',
    dimensions: 1536
  },
  // ...
};
```

### Generation
- Providers: `OPENAI`, `GEMINI`, `ANTHROPIC`.
- Options: `temperature`, `maxTokens`.
- Structured output: set `generation.outputFormat = 'json'` and parse `answer`.
```javascript
const config = {
  llm: { provider: ProviderType.GEMINI, apiKey: process.env.GOOGLE_API_KEY, modelName: 'gemini-1.5-pro-latest', temperature: 0.3 },
  generation: { outputFormat: 'json', structuredOutput: 'citations' }
};
const client = new VectraClient(config);
const res = await client.queryRAG('Summarize our policy with citations.');
console.log(res.answer); // JSON object or string on fallback
```

- OpenRouter usage:
```javascript
const config = {
  llm: {
    provider: ProviderType.OPENROUTER,
    apiKey: process.env.OPENROUTER_API_KEY,
    modelName: 'openai/gpt-4o',
    defaultHeaders: { 'HTTP-Referer': 'https://your.app', 'X-Title': 'Your App' }
  }
};
```

### Chunking
- Strategies: `RECURSIVE`, `AGENTIC`.
- Agentic requires `chunking.agenticLlm` config.
```javascript
const config = {
  chunking: {
    strategy: ChunkingStrategy.AGENTIC,
    agenticLlm: { provider: ProviderType.OPENAI, apiKey: process.env.OPENAI_API_KEY, modelName: 'gpt-4o-mini' },
    chunkSize: 1200,
    chunkOverlap: 200
  }
};
```

### Retrieval
- Strategies: `NAIVE`, `HYDE`, `MULTI_QUERY`, `HYBRID`.
- HYDE/MULTI_QUERY require `retrieval.llmConfig`.
- Example:
```javascript
const config = {
  retrieval: {
    strategy: RetrievalStrategy.MULTI_QUERY,
    llmConfig: { provider: ProviderType.OPENAI, apiKey: process.env.OPENAI_API_KEY, modelName: 'gpt-4o-mini' }
  }
};
```

### Reranking
- Enable LLM-based reranking to reorder results.
```javascript
const config = {
  reranking: {
    enabled: true,
    topN: 5,
    windowSize: 20,
    llmConfig: { provider: ProviderType.ANTHROPIC, apiKey: process.env.ANTHROPIC_API_KEY, modelName: 'claude-3-haiku' }
  }
};
```

### Metadata Enrichment
- Add summaries, keywords, hypothetical questions during ingestion.
```javascript
const config = { metadata: { enrichment: true } };
await client.ingestDocuments('./docs/handbook.pdf');
```

### Query Planning
- Control context assembly with token budget and summary preference.
```javascript
const config = {
  queryPlanning: { tokenBudget: 2048, preferSummariesBelow: 1024, includeCitations: true }
};
```

### Answer Grounding
- Inject extractive snippets; use `strict` to only allow grounded quotes.
```javascript
const config = { grounding: { enabled: true, strict: false, maxSnippets: 4 } };
```

### Prompts
- Provide a custom query template using `{{context}}` and `{{question}}`.
```javascript
const config = {
  prompts: { query: 'Use only the following context to answer.\nContext:\n{{context}}\n\nQ: {{question}}' }
};
```

### Streaming
- Unified async generator with chunks `{ delta, finish_reason, usage }`.
```javascript
const stream = await client.queryRAG('Draft a welcome email', null, true);
for await (const chunk of stream) process.stdout.write(chunk.delta || '');
```

### Filters
- Limit retrieval to metadata fields.
```javascript
const res = await client.queryRAG('Vacation policy', { docTitle: 'Employee Handbook' });
```

### Callbacks
- Hook into pipeline stages for logging/metrics.
```javascript
const { StructuredLoggingCallbackHandler } = require('vectra-js/src/callbacks');
const config = { callbacks: [ new StructuredLoggingCallbackHandler() ] };
```

### Observability

Built-in SQLite-based observability to track metrics, traces, and sessions.

```javascript
const config = {
  // ...
  observability: {
    enabled: true,
    sqlitePath: 'vectra-observability.db',
    projectId: 'my-project',
    trackMetrics: true,
    trackTraces: true,
    sessionTracking: true
  }
};
```

This tracks:
- **Metrics**: Latency (ingest, query).
- **Traces**: Detailed spans for retrieval, generation, and ingestion workflows.
- **Sessions**: Chat session history and last query tracking.

### Vector Stores
- Prisma (Postgres + pgvector), Chroma, Qdrant, Milvus.
- Configure `database.type`, `tableName`, `columnMap`, `clientInstance`.
```javascript
const config = {
  database: {
    type: 'prisma',
    clientInstance: prismaClient,
    tableName: 'Document',
    columnMap: { content: 'content', vector: 'embedding', metadata: 'metadata' }
  }
};
```
### HuggingFace (Embeddings & Generation)
- Use HuggingFace Inference API for embeddings and generation.
- Set `provider = ProviderType.HUGGINGFACE`, `modelName` to a supported model (e.g., `sentence-transformers/all-MiniLM-L6-v2` for embeddings, `tiiuae/falcon-7b-instruct` for generation).
- Provide `HUGGINGFACE_API_KEY`.
```javascript
const config = {
  embedding: { provider: ProviderType.HUGGINGFACE, apiKey: process.env.HUGGINGFACE_API_KEY, modelName: 'sentence-transformers/all-MiniLM-L6-v2' },
  llm: { provider: ProviderType.HUGGINGFACE, apiKey: process.env.HUGGINGFACE_API_KEY, modelName: 'tiiuae/falcon-7b-instruct' }
};
```
