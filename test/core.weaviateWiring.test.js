const { VectraClient, ProviderType } = require('../src/core');

describe('createVectorStore - weaviate', () => {
  it('returns a WeaviateVectorStore for type "weaviate"', () => {
    const collection = { data: {}, query: {} };
    const client = { collections: { get: jest.fn().mockReturnValue(collection) } };
    const vectraClient = new VectraClient({
      embedding: { provider: ProviderType.OPENAI, apiKey: 'test-key' },
      llm: { provider: ProviderType.OPENAI, apiKey: 'test-key', modelName: 'gpt-4o-mini' },
      database: { type: 'weaviate', clientInstance: client },
    });

    expect(vectraClient.vectorStore.constructor.name).toBe('WeaviateVectorStore');
  });
});
