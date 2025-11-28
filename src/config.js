const { z } = require('zod');

const ProviderType = {
  OPENAI: 'openai',
  ANTHROPIC: 'anthropic',
  GEMINI: 'gemini',
};

const ChunkingStrategy = {
  RECURSIVE: 'recursive',
  AGENTIC: 'agentic',
};

const RetrievalStrategy = {
  NAIVE: 'naive',
  HYDE: 'hyde',
  MULTI_QUERY: 'multi_query',
  HYBRID: 'hybrid' // New Strategy
};

const EmbeddingConfigSchema = z.object({
  provider: z.nativeEnum(ProviderType),
  apiKey: z.string().optional(),
  modelName: z.string().default('text-embedding-3-small'),
  dimensions: z.number().optional(),
});

const LLMConfigSchema = z.object({
  provider: z.nativeEnum(ProviderType),
  apiKey: z.string().optional(),
  modelName: z.string(),
  temperature: z.number().default(0),
  maxTokens: z.number().default(1024),
});

const ChunkingConfigSchema = z.object({
  strategy: z.nativeEnum(ChunkingStrategy).default(ChunkingStrategy.RECURSIVE),
  chunkSize: z.number().default(1000),
  chunkOverlap: z.number().default(200),
  separators: z.array(z.string()).default(['\n\n', '\n', ' ', '']),
  agenticLlm: LLMConfigSchema.optional(),
}).refine((data) => {
  if (data.strategy === ChunkingStrategy.AGENTIC && !data.agenticLlm) return false;
  return true;
}, { message: "agenticLlm required for AGENTIC strategy", path: ["agenticLlm"] });

const RerankingConfigSchema = z.object({
    enabled: z.boolean().default(false),
    provider: z.literal('llm').default('llm'),
    llmConfig: LLMConfigSchema.optional(),
    topN: z.number().default(5),
    windowSize: z.number().default(20)
});

const RetrievalConfigSchema = z.object({
    strategy: z.nativeEnum(RetrievalStrategy).default(RetrievalStrategy.NAIVE),
    llmConfig: LLMConfigSchema.optional(),
    hybridAlpha: z.number().default(0.5)
}).refine((data) => {
    if ((data.strategy === RetrievalStrategy.HYDE || data.strategy === RetrievalStrategy.MULTI_QUERY) && !data.llmConfig) return false;
    return true;
}, { message: "llmConfig required for advanced retrieval", path: ["llmConfig"] });

const DatabaseConfigSchema = z.object({
  type: z.string(), // 'prisma', 'chroma', etc.
  tableName: z.string().optional(),
  columnMap: z.object({
    content: z.string(),
    vector: z.string(),
    metadata: z.string(),
  }).default({ content: 'content', vector: 'vector', metadata: 'metadata' }),
  clientInstance: z.any(), // The actual client object
});

const RAGConfigSchema = z.object({
  embedding: EmbeddingConfigSchema,
  llm: LLMConfigSchema,
  database: DatabaseConfigSchema,
  chunking: ChunkingConfigSchema.default({}),
  retrieval: RetrievalConfigSchema.default({}),
  reranking: RerankingConfigSchema.default({}),
  callbacks: z.array(z.custom((val) => true)).optional(), 
});

module.exports = {
  ProviderType, ChunkingStrategy, RetrievalStrategy,
  EmbeddingConfigSchema, LLMConfigSchema, ChunkingConfigSchema,
  RetrievalConfigSchema, RerankingConfigSchema, DatabaseConfigSchema, RAGConfigSchema
};
