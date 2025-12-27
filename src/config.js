const { z } = require('zod');

const ProviderType = {
  OPENAI: 'openai',
  ANTHROPIC: 'anthropic',
  GEMINI: 'gemini',
  OPENROUTER: 'openrouter',
  HUGGINGFACE: 'huggingface',
  OLLAMA: 'ollama',
};

const ChunkingStrategy = {
  RECURSIVE: 'recursive',
  AGENTIC: 'agentic',
};

const RetrievalStrategy = {
  NAIVE: 'naive',
  HYDE: 'hyde',
  MULTI_QUERY: 'multi_query',
  HYBRID: 'hybrid',
  MMR: 'mmr'
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
  baseUrl: z.string().optional(),
  defaultHeaders: z.record(z.string()).optional(),
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
    hybridAlpha: z.number().default(0.5),
    mmrLambda: z.number().default(0.5),
    mmrFetchK: z.number().default(20)
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
  metadata: z.object({ enrichment: z.boolean().default(false) }).optional(),
  ingestion: z.object({ rateLimitEnabled: z.boolean().default(false), concurrencyLimit: z.number().default(5) }).optional(),
  memory: z.object({
    enabled: z.boolean().default(false),
    type: z.enum(['in-memory','redis','postgres']).default('in-memory'),
    maxMessages: z.number().default(20),
    redis: z.object({
      clientInstance: z.any().optional(),
      keyPrefix: z.string().default('vectra:chat:')
    }).optional(),
    postgres: z.object({
      clientInstance: z.any().optional(),
      tableName: z.string().default('ChatMessage'),
      columnMap: z.object({
        sessionId: z.string().default('sessionId'),
        role: z.string().default('role'),
        content: z.string().default('content'),
        createdAt: z.string().default('createdAt')
      }).default({ sessionId: 'sessionId', role: 'role', content: 'content', createdAt: 'createdAt' })
    }).optional()
  }).optional(),
  queryPlanning: z.object({ tokenBudget: z.number().default(2048), preferSummariesBelow: z.number().default(1024), includeCitations: z.boolean().default(true) }).optional(),
  grounding: z.object({ enabled: z.boolean().default(false), strict: z.boolean().default(false), maxSnippets: z.number().default(3) }).optional(),
  generation: z.object({ structuredOutput: z.enum(['none','citations']).default('none'), outputFormat: z.enum(['text','json']).default('text') }).optional(),
  prompts: z.object({ query: z.string().optional(), reranking: z.string().optional() }).optional(),
  tracing: z.object({ enable: z.boolean().default(false) }).optional(),
  callbacks: z.array(z.custom((val) => true)).optional(), 
  observability: z.object({
    enabled: z.boolean().default(false),
    sqlitePath: z.string().default('vectra-observability.db'),
    projectId: z.string().default('default'),
    trackMetrics: z.boolean().default(true),
    trackTraces: z.boolean().default(true),
    trackLogs: z.boolean().default(true),
    sessionTracking: z.boolean().default(true)
  }).default({})
});

module.exports = {
  ProviderType, ChunkingStrategy, RetrievalStrategy,
  EmbeddingConfigSchema, LLMConfigSchema, ChunkingConfigSchema,
  RetrievalConfigSchema, RerankingConfigSchema, DatabaseConfigSchema, RAGConfigSchema
};
