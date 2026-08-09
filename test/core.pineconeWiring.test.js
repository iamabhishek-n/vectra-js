const { VectraClient, ProviderType } = require('../src/core');

describe('createVectorStore - pinecone', () => {
  it('returns a PineconeVectorStore for type "pinecone"', () => {
    const client = new VectraClient({
      embedding: { provider: ProviderType.OPENAI, apiKey: 'test-key' },
      llm: { provider: ProviderType.OPENAI, apiKey: 'test-key', modelName: 'gpt-4o-mini' },
      database: { type: 'pinecone', clientInstance: { query: jest.fn(), upsert: jest.fn() } },
    });

    expect(client.vectorStore.constructor.name).toBe('PineconeVectorStore');
  });
});
