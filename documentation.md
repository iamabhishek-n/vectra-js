# Vectra JS Documentation

## 1. Getting Started
- Introduction
  - Vectra is a provider-agnostic RAG SDK for Node.js that orchestrates the pipeline: load files, chunk, embed, store, retrieve, rerank, and generate answers with streaming support.
- Key Features
  - Multi-Provider (OpenAI, Gemini, Anthropic, OpenRouter, HuggingFace)
  - HyDE and Multi-Query retrieval strategies
  - Hybrid Search with RRF fusion (vector + keyword)
  - Agentic Chunking using an LLM to find semantic breaks
  - Streaming responses and metadata enrichment
- Architecture
  ```mermaid
  graph LR
      A[Files] --> B(Chunking)
      B --> C{Embedding API}
      C --> D[(Vector Store)]
      E[User Query] --> F(Retrieval)
      D --> F
      F --> G(Reranking)
      G --> H[LLM Generation]
      H --> I[Stream Output]
  ```
- Installation
  - Prerequisites: Node.js 18+, optional Postgres (for Prisma + pgvector)
  - Commands:
    - `npm install vectra-js @prisma/client`
    - `npm install chromadb` (optional for ChromaDB backend)
    - `pnpm add vectra-js @prisma/client` and `pnpm add chromadb` (optional)
- Quickstart
  - Minimal setup with ChromaDB to avoid Postgres in first run:
  ```javascript
  const { VectraClient, ProviderType, RetrievalStrategy } = require('vectra-js');
  const { ChromaClient } = require('chromadb');
  const chroma = new ChromaClient();
  
  const config = {
    embedding: { provider: ProviderType.OPENAI, apiKey: process.env.OPENAI_API_KEY, modelName: 'text-embedding-3-small' },
    llm: { provider: ProviderType.GEMINI, apiKey: process.env.GOOGLE_API_KEY, modelName: 'gemini-1.5-pro-latest' },
    database: { type: 'chroma', clientInstance: chroma, tableName: 'rag_collection' },
    retrieval: { strategy: RetrievalStrategy.NAIVE }
  };
  const client = new VectraClient(config);
  await client.ingestDocuments('./docs/hello.txt');
  const res = await client.queryRAG('Hello');
  console.log(res.answer);
  ```
  - Environment Variables
    - `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `HUGGINGFACE_API_KEY`
  - First Query
    - `await client.queryRAG("Hello")` returns `{ answer, sources }`.

## 2. Fundamentals
- Configuration
  - Centralized config object validates providers, database, and pipeline options.
  - Copy-Paste template:
  ```javascript
  const { ProviderType, ChunkingStrategy, RetrievalStrategy } = require('vectra-js');
  const config = {
    // Embedding
    embedding: {
      provider: ProviderType.OPENAI,
      apiKey: process.env.OPENAI_API_KEY,
      modelName: 'text-embedding-3-small',
      // dimensions: 1536
    },
    // LLM (generation)
    llm: {
      provider: ProviderType.GEMINI,
      apiKey: process.env.GOOGLE_API_KEY,
      modelName: 'gemini-1.5-pro-latest',
      // temperature: 0.3,
      // maxTokens: 1024,
      // defaultHeaders: {} // OpenRouter only
    },
    // Memory (toggleable, defaults off)
    memory: {
      enabled: false,
      type: 'in-memory', // or 'redis' | 'postgres'
      maxMessages: 20,
      // Redis options
      redis: { 
        clientInstance: /* redis client */, 
        keyPrefix: 'vectra:chat:' 
      },
      // Postgres options
      postgres: {
        clientInstance: /* Prisma client */,
        tableName: 'ChatMessage',
        columnMap: { sessionId: 'sessionId', role: 'role', content: 'content', createdAt: 'createdAt' }
      }
    },
    // Ingestion (rate limit is toggleable, defaults off)
    ingestion: { rateLimitEnabled: false, concurrencyLimit: 5 },
    // Database
    database: {
      type: 'chroma', // 'prisma' | 'qdrant' | 'milvus'
      clientInstance: null, // your DB client
      tableName: 'Document',
      columnMap: { content: 'content', vector: 'embedding', metadata: 'metadata' } // Prisma only
    },
    // Chunking
    chunking: {
      strategy: ChunkingStrategy.RECURSIVE, // or ChunkingStrategy.AGENTIC
      chunkSize: 1000,
      chunkOverlap: 200,
      // separators: ['\n\n', '\n', ' ', '']
      // agenticLlm: { provider: ProviderType.OPENAI, apiKey: process.env.OPENAI_API_KEY, modelName: 'gpt-4o-mini' } // required for AGENTIC
    },
    // Retrieval
    retrieval: {
      strategy: RetrievalStrategy.HYBRID, // NAIVE | HYDE | MULTI_QUERY | HYBRID | MMR
      // llmConfig: { provider: ProviderType.OPENAI, apiKey: process.env.OPENAI_API_KEY, modelName: 'gpt-4o-mini' }, // HYDE/MULTI_QUERY
      // hybridAlpha: 0.5 // tuning
      // mmrLambda: 0.5,
      // mmrFetchK: 20
    },
    // Reranking
    reranking: {
      enabled: false,
      // topN: 5,
      // windowSize: 20,
      // llmConfig: { provider: ProviderType.ANTHROPIC, apiKey: process.env.ANTHROPIC_API_KEY, modelName: 'claude-3-haiku' }
    },
    // Metadata
    metadata: { enrichment: false }, // summary, keywords, hypothetical_questions
    // Query Planning
    queryPlanning: { tokenBudget: 2048, preferSummariesBelow: 1024, includeCitations: true },
    // Grounding
    grounding: { enabled: false, strict: false, maxSnippets: 4 },
    // Generation
    generation: { outputFormat: 'text', structuredOutput: 'none' }, // 'json' and 'citations' supported
    // Prompts
    prompts: { query: 'Use only the following context.\nContext:\n{{context}}\n\nQ: {{question}}' },
    // Callbacks
    callbacks: []
  };
  ```
- Ingestion
  - File Loading: PDF, DOCX, TXT, MD, XLSX
  - Directory Walking: `await client.ingestDocuments('./folder')` recursively processes supported files
  - Index Management (Postgres/Prisma): `await client.vectorStore.ensureIndexes()` after ingestion
- Querying
  - Standard:
  ```javascript
  const { answer } = await client.queryRAG("Question");
  ```
  - Stateful Chat (Memory):
  ```javascript
  const sessionId = "user-123";
  const { answer } = await client.queryRAG("Does this apply to contractors?", null, false, sessionId);
  ```
  - Streaming + Filtering:
  ```javascript
  const stream = await client.queryRAG(
    "Draft a welcome memo...",
    { docTitle: "Handbook" },
    true
  );
  for await (const chunk of stream) process.stdout.write(chunk.delta || '');
  ```

## 3. Database & Vector Stores
- Supported Backends
  - Prisma (Postgres + pgvector): rich SQL, hybrid search and indexes
  - ChromaDB: simple local collections, easy first-run
  - Qdrant: high-performance vector search
  - Milvus: scalable vector database
- Prisma (Postgres + pgvector)
  - Prerequisite: enable `vector` extension
    - `CREATE EXTENSION IF NOT EXISTS vector;`
  - Schema (`schema.prisma`)
  ```prisma
  model Document {
    id        String                 @id @default(uuid())
    content   String
    metadata  Json
    vector    Unsupported("vector")? // pgvector type
    createdAt DateTime               @default(now())
  }
  ```
  - Column Mapping: `columnMap` maps SDK fields to DB columns, e.g. `{ content: 'content', vector: 'embedding', metadata: 'metadata' }`
  - Index Management: ivfflat for vector cosine ops and GIN for FTS
    - `await client.vectorStore.ensureIndexes()`
- ChromaDB / Qdrant / Milvus
  - Chroma: `const { ChromaClient } = require('chromadb'); const chroma = new ChromaClient();`
  - Qdrant: `const qdrant = new QdrantClient({ url, apiKey });`
  - Milvus: `const milvus = new MilvusClient({ address });`
  - Pass `clientInstance` and `tableName` to `database` config.

## 4. Providers (LLM & Embeddings)
- Provider Setup
  - OpenAI:
    - Embeddings: `text-embedding-3-small`, `text-embedding-3-large`
    - Generation: `gpt-4o`, `gpt-4o-mini`
  - Gemini:
    - Generation: `gemini-1.5-pro-latest`
  - Anthropic:
    - Generation only (`claude-3-haiku`, `claude-3-opus`) — use a different embedding provider
  - Ollama:
    - Local development; set `provider = ProviderType.OLLAMA`
    - Defaults to `http://localhost:11434` (override with `baseUrl`)
  - OpenRouter:
    - Unified gateway; set `llm.provider = ProviderType.OPENROUTER` and `modelName` to e.g. `openai/gpt-4o`
  - HuggingFace:
    - Use Inference API for embeddings and generation with open-source models
- Customizing Models
  - `temperature`, `maxTokens`, and embedding `dimensions` (must match pgvector column for Prisma)

## 5. Advanced Concepts
- Chunking Strategies
  - Recursive: control `chunkSize`, `chunkOverlap`, and optional `separators`
  - Agentic: configure `chunking.agenticLlm`; uses an LLM to place semantic boundaries
- Retrieval Strategies
  - Naive: cosine similarity on vectors
  - HyDE: generate a hypothetical answer and search on its embedding
  - Hybrid Search (RRF): combine vector search and keyword FTS using reciprocal rank fusion
  - Multi-Query: produce query variations via LLM to improve recall
- Reranking
  - Enable with `reranking.enabled`; tune `topN` and `windowSize`
- Metadata Enrichment
  - Set `metadata.enrichment = true` to generate summaries, keywords, and hypothetical questions during ingestion
- Conversation Memory
  - Enable stateful chat by setting `memory` config and passing `sessionId` to `queryRAG`.
  - Automatically appends history to prompts and saves interactions.
- Production Evaluation
  - Use `client.evaluate(testSet)` to measure Faithfulness (answer derived from context) and Relevance (answer addresses question).
  - Returns per-test scores (0-1) for each question.
  ```javascript
  // Example Test Set structure
  const testSet = [
    { 
      question: "What is the remote work policy?",
      expectedGroundTruth: "Employees can work remotely up to 3 days a week."
    }
  ];
  const report = await client.evaluate(testSet);
  const averageFaithfulness = report.length
    ? report.reduce((s, r) => s + (r.faithfulness || 0), 0) / report.length
    : 0;
  const averageRelevance = report.length
    ? report.reduce((s, r) => s + (r.relevance || 0), 0) / report.length
    : 0;
  console.log({ averageFaithfulness, averageRelevance, report });
  ```

## 6. Production Guide
- Query Planning & Grounding
  - Token Budgets: `queryPlanning.tokenBudget`
  - Grounding: `grounding.enabled` and `grounding.strict` to restrict answers to grounded snippets
  - Citations: include titles/sections/pages via `queryPlanning.includeCitations`; parse when using `generation.structuredOutput = 'citations'`
- Observability & Debugging
  - Logging: use `StructuredLoggingCallbackHandler` for JSON events
  - Tracing: hook into pipeline events like `onRetrievalStart`, `onGenerationEnd`
- CLI Tools
  - Global or local `vectra` binary for ingestion and queries without writing code
  - `vectra ingest ./docs --config=./config.json`
  - `vectra query "What is our leave policy?" --config=./config.json --stream`

## 7. API Reference
- VectraClient
  - Constructor: `new VectraClient(config)`
  - Methods:
    - `ingestDocuments(path: string): Promise<void>`
    - `queryRAG(query: string, filter?: object | null, stream?: boolean, sessionId?: string | null): Promise<QueryResponse | AsyncGenerator>`
    - `listDocuments({ filter?: object | null, limit?: number, offset?: number }): Promise<Array<{ id, content, metadata }>>`
    - `deleteDocuments({ ids?: string[] | null, filter?: object | null }): Promise<void>`
    - `updateDocuments(docs: Array<{ id, content, metadata? }>): Promise<void>`
- VectorStore Interface
  - Extend and implement:
    - `addDocuments(docs)`
    - `upsertDocuments(docs)`
    - `similaritySearch(vector, limit = 5, filter = null)`
    - Optional: `hybridSearch(text, vector, limit = 5, filter = null)`
    - `listDocuments({ filter, limit, offset })`
    - `deleteDocuments({ ids, filter })`
- Type Definitions (shape)
  - `VectraConfig`: `{ embedding, llm, database, chunking?, retrieval?, reranking?, metadata?, queryPlanning?, grounding?, generation?, prompts?, callbacks? }`
  - `QueryResponse`: `{ answer: string | object, sources: object[] }` or streaming `AsyncGenerator<{ delta, finish_reason, usage }>`

## 8. Recipes / FAQ
- How do I use a local LLM?
  - Use **Ollama** (`ProviderType.OLLAMA`) for the easiest local setup.
  - Alternatively, use HuggingFace Inference API or a custom provider.
- How do I extract JSON from the answer?
  - Set `generation.outputFormat = 'json'`, parse `answer`; fallback to string on parse errors.
- Why is my retrieval slow?
  - Ensure Prisma indexes are created (`ensureIndexes()`); confirm embedding `dimensions` match pgvector column; consider Hybrid Search and metadata filters.
