const { VectraClient, ProviderType } = require('../src/core');

function makeConfig(overrides = {}) {
  return {
    embedding: { provider: ProviderType.OPENAI, apiKey: 'test-key' },
    llm: { provider: ProviderType.OPENAI, apiKey: 'test-key', modelName: 'gpt-4o-mini' },
    database: { type: 'chroma', clientInstance: { getOrCreateCollection: jest.fn() } },
    ...overrides,
  };
}

describe('VectraClient FactStore wiring', () => {
  it('does not create a factStore when memory.facts is not enabled', () => {
    const client = new VectraClient(makeConfig());
    expect(client.factStore).toBeNull();
  });

  it('creates a factStore when memory.facts.enabled is true', () => {
    const client = new VectraClient(makeConfig({
      memory: { enabled: true, facts: { enabled: true, clientInstance: {}, tableName: 'MyFacts' } },
    }));
    expect(client.factStore).not.toBeNull();
    expect(client.factStore.tableName).toBe('MyFacts');
    expect(client.factStore.llm).toBe(client.llm);
    expect(client.factStore.embedder).toBe(client.embedder);
  });
});
