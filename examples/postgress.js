const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');
const { VectraClient, ProviderType, ChunkingStrategy, RetrievalStrategy } = require('../vectra-js');
const { LoggingCallbackHandler } = require('../vectra-js/src/callbacks');

async function runSimulation() {
  console.log('=== Starting Vectra SDK Simulation (Node.js + Prisma) ===\n');

  const connectionString = process.env.DATABASE_URL;
  const pool = new Pool({ connectionString });
  // const adapter = new PrismaPg({ pool });
  // const prisma = new PrismaClient({ adapter });

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
      chunkSize: 1000,
      chunkOverlap: 200,
    },
    database: {
      type: 'postgres',
      tableName: 'Document',
      clientInstance: pool,
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
  
  if ((config.database.type === 'prisma' || config.database.type === 'postgres') && client.vectorStore.ensureIndexes) {
    try {
        await client.vectorStore.ensureIndexes();
        console.log('Database indexes ensured.');
    } catch (e) {
        console.warn('Index creation warning (may already exist):', e.message);
    }
  }
  
  // Clean up table for simulation
  if (config.database.type === 'postgres') {
      try {
        await pool.query(`DELETE FROM "${config.database.tableName}"`); // Use quoted identifier
        console.log('Cleared existing documents from table.');
      } catch (e) {
        console.warn('Could not clear table:', e.message);
      }
  }
  
  await client.ingestDocuments('data/sample.txt');

  console.log('\n--- Step 1: Standard Query (Hybrid) ---\n');
  try {
    const result = await client.queryRAG('What is RAG?');
    console.log('Answer:', result.answer);
  } catch (error) {
    console.error('Query failed:', error);
  }

  console.log('\n--- Step 2: Streaming Query ---\n');
  try {
    const stream = await client.queryRAG('Tell me more...', null, true);
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

  await pool.end();
}

runSimulation();
