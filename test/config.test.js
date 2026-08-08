const { RAGConfigSchema, ProviderType } = require('../src/config');

const minimalConfig = {
  embedding: { provider: ProviderType.OPENAI, apiKey: 'test-key' },
  llm: { provider: ProviderType.OPENAI, apiKey: 'test-key', modelName: 'gpt-4o-mini' },
  database: { type: 'chroma', clientInstance: {} },
};

describe('RAGConfigSchema', () => {
  it('accepts a minimal valid config and fills in defaults', () => {
    const parsed = RAGConfigSchema.parse(minimalConfig);
    expect(parsed.embedding.modelName).toBe('text-embedding-3-small');
    expect(parsed.telemetry.enabled).toBe(false);
    expect(parsed.database.columnMap).toEqual({ content: 'content', vector: 'vector', metadata: 'metadata' });
  });

  it('rejects a config missing the embedding provider', () => {
    const bad = { ...minimalConfig, embedding: { apiKey: 'test-key' } };
    expect(() => RAGConfigSchema.parse(bad)).toThrow();
  });

  it('rejects a config missing the database type', () => {
    const bad = { ...minimalConfig, database: { clientInstance: {} } };
    expect(() => RAGConfigSchema.parse(bad)).toThrow();
  });

  it('rejects an agentic chunking strategy with no agenticLlm', () => {
    const bad = { ...minimalConfig, chunking: { strategy: 'agentic' } };
    expect(() => RAGConfigSchema.parse(bad)).toThrow('agenticLlm required');
  });

  it('rejects a HyDE retrieval strategy with no llmConfig', () => {
    const bad = { ...minimalConfig, retrieval: { strategy: 'hyde' } };
    expect(() => RAGConfigSchema.parse(bad)).toThrow('llmConfig required');
  });
});
