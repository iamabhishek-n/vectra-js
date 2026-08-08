const { VectraClient, ProviderType } = require('../src/core');

function makeConfig(guardrails) {
  return {
    embedding: { provider: ProviderType.OPENAI, apiKey: 'test-key' },
    llm: { provider: ProviderType.OPENAI, apiKey: 'test-key', modelName: 'gpt-4o-mini' },
    database: { type: 'chroma', clientInstance: { getOrCreateCollection: jest.fn() } },
    guardrails,
  };
}

describe('VectraClient.queryRAG guardrail enforcement', () => {
  it('rejects an over-length query before any embedding call', async () => {
    const client = new VectraClient(makeConfig({ maxQueryLength: 10 }));
    client.embedder.embedQuery = jest.fn();
    await expect(client.queryRAG('this query is way too long for the limit'))
      .rejects.toThrow('GuardrailViolation: query exceeds maxQueryLength');
    expect(client.embedder.embedQuery).not.toHaveBeenCalled();
  });

  it('rejects a query with PII before any embedding call when blockPii is on', async () => {
    const client = new VectraClient(makeConfig({ blockPii: true }));
    client.embedder.embedQuery = jest.fn();
    await expect(client.queryRAG('email me at test@example.com'))
      .rejects.toThrow('GuardrailViolation: possible PII detected');
    expect(client.embedder.embedQuery).not.toHaveBeenCalled();
  });

  it('does not interfere with a normal query when guardrails are unset', async () => {
    const client = new VectraClient(makeConfig(undefined));
    client.embedder.embedQuery = jest.fn().mockResolvedValue([0.1, 0.2]);
    client.vectorStore.similaritySearch = jest.fn().mockResolvedValue([]);
    client.llm.generate = jest.fn().mockResolvedValue('an answer');
    await expect(client.queryRAG('what is this SDK?')).resolves.toBeDefined();
  });
});
