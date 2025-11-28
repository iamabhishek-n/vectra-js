# Vectra (Node.js)

A production-ready, provider-agnostic Node.js SDK for End-to-End RAG (Retrieval-Augmented Generation) pipelines.

## Features

*   **Multi-Provider Support**: First-class support for **OpenAI**, **Gemini**, and **Anthropic**.
*   **Modular Vector Store**:
    *   **Prisma**: Use your existing PostgreSQL database with `pgvector`.
    *   **ChromaDB**: Native support for the open-source vector database.
    *   **Extensible**: Easily add others (Pinecone, Qdrant) by extending the `VectorStore` class.
*   **Advanced Chunking**:
    *   **Recursive**: Smart splitting based on characters and separators.
    *   **Agentic**: Uses an LLM to split text into semantically complete propositions.
*   **Advanced Retrieval Strategies**:
    *   **Naive**: Standard cosine similarity search.
    *   **HyDE (Hypothetical Document Embeddings)**: Generates a fake answer to the query and searches for that.
    *   **Multi-Query**: Generates multiple variations of the query to catch different phrasings.
    *   **Hybrid Search**: Combines results using **Reciprocal Rank Fusion (RRF)**.
*   **Streaming**: Full support for token-by-token streaming responses.
*   **Reranking**: LLM-based reranking to re-order retrieved documents for maximum relevance.
*   **File Support**: Native parsing for PDF, DOCX, XLSX, TXT, and Markdown.

---

## Installation

```bash
npm install vectra-js @prisma/client
# Optional: If using Chroma
npm install chromadb
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

### 2. Initialization & Ingestion

```javascript
const { RAGClient } = require('vectra-js');
const client = new RAGClient(config);

// Ingest a file (supports .pdf, .docx, .txt, .md, .xlsx)
// This will: Load -> Chunk -> Embed -> Store
await client.ingestDocuments('./documents/employee_handbook.pdf');
```

### 3. Querying (Standard)

```javascript
const response = await client.queryRAG("What is the vacation policy?");

console.log("Answer:", response.answer);
console.log("Sources:", response.sources); // Metadata of retrieved chunks
```

### 4. Querying (Streaming)

Ideal for Chat UIs. Returns an Async Generator.

```javascript
const stream = await client.queryRAG("Draft a welcome email...", null, true);

for await (const chunk of stream) {
    process.stdout.write(chunk); // "Draft", "ing", " a", " wel", ...
}
```

---

## Supported Providers & Backends

| Feature | OpenAI | Gemini | Anthropic |
| :--- | :---: | :---: | :---: |
| **Embeddings** | ✅ | ✅ | ❌ |
| **Generation** | ✅ | ✅ | ✅ |
| **Streaming** | ✅ | ✅ | ✅ |

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

### `new RAGClient(config)`
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
*   If `stream=false` (default): `{ answer: string, sources: object[] }`
*   If `stream=true`: `AsyncGenerator<string>`

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
