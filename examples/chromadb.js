const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { ChromaClient } = require('chromadb');
const { VectraClient, ProviderType, ChunkingStrategy, RetrievalStrategy } = require('../vectra-js');
const { LoggingCallbackHandler } = require('../vectra-js/src/callbacks');

async function runSimulation() {
  console.log('=== Starting Vectra SDK Simulation (Node.js) ===\n');

  const chroma = new ChromaClient({
    ssl: false,
    host: "localhost",
    port: 8000,
    headers: {},
  });

  const config = {
    embedding: {
      provider: ProviderType.GEMINI,
      apiKey: process.env.GEMINI_KEY,
      modelName: 'gemini-embedding-001',
      dimensions: 1536,
    },
    llm: {
      provider: ProviderType.GEMINI,
      apiKey: process.env.GEMINI_KEY,
      modelName: 'gemini-2.5-flash-lite',
    },
    chunking: {
      strategy: ChunkingStrategy.RECURSIVE,
      chunkSize: 500,
      chunkOverlap: 200,
    },
    database: {
      type: 'chroma',
      tableName: 'rag_collection',
      clientInstance: chroma,
      columnMap: { content: 'content', vector: 'embedding', metadata: 'metadata' },
    },
    retrieval: {
      strategy: RetrievalStrategy.HYBRID,
    },
    reranking: {
      enabled: true,
      topN: 5,
      windowSize: 20,
      llmConfig: {
        provider: ProviderType.GEMINI,
        apiKey: process.env.GEMINI_KEY,
        modelName: 'gemini-2.5-flash-lite',
      }
    },
    observability: {
        enabled: true,
        projectId: "node-test-project",
        sqlitePath: path.resolve(__dirname, "db/node-observability.db")
    },
    callbacks: [
      new LoggingCallbackHandler(),
      { onEmbeddingStart: (c) => console.info(`[RAG] Embedding ${c} chunks...`) }
    ],
  };

  console.log('Initializing Client...');
  const client = new VectraClient(config);
  if (config.database.type === 'prisma' && client.vectorStore.ensureIndexes) {
    await client.vectorStore.ensureIndexes();
  }
  await client.ingestDocuments('data/llm-ebook-part1-1.pdf');

  console.log('\n--- Step 1: Standard Query (Hybrid) ---\n');
  try {
    const result = await client.queryRAG('What is LLM?');
    console.log('Answer:', result.answer);
  } catch (error) {
    console.error('Query failed:', error);
  }

  console.log('\n--- Step 2: Streaming Query ---\n');
  try {
    const stream = await client.queryRAG('Tell me more about LLM...', null, true);
    process.stdout.write('Stream Output: ');
    for await (const chunk of stream) {
      if (typeof chunk === 'string') {
        process.stdout.write(chunk);
      } else if (chunk && chunk.delta) {
        process.stdout.write(chunk.delta);
      }
    }
    process.stdout.write('\n');
  } catch (error) {
    console.error('Streaming failed:', error);
  }
}

runSimulation();
