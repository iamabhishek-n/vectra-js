const { VectraClient, ProviderType } = require('../src/core');

function makeConfig(overrides = {}) {
  return {
    embedding: { provider: ProviderType.OPENAI, apiKey: 'test-key' },
    llm: { provider: ProviderType.OPENAI, apiKey: 'test-key', modelName: 'gpt-4o-mini' },
    database: { type: 'chroma', clientInstance: { getOrCreateCollection: jest.fn() } },
    memory: { enabled: true, type: 'in-memory' },
    queryPlanning: { tokenBudget: 15 },
    ...overrides,
  };
}

describe('queryRAG history now counts against the token budget (Phase 1 research bug fix)', () => {
  it('a long conversation history no longer bypasses the budget uncounted', async () => {
    const client = new VectraClient(makeConfig());
    client.embedder.embedQuery = jest.fn().mockResolvedValue([0.1, 0.2]);
    client.vectorStore.similaritySearch = jest.fn().mockResolvedValue([
      { content: 'short doc', metadata: {} },
    ]);
    client.llm.generate = jest.fn().mockResolvedValue('an answer');

    for (let i = 0; i < 20; i++) {
      client.history.addMessage('session-1', 'user', `This is a fairly long historical message number ${i} with a lot of extra real words padded in to make it substantial and unmistakably large for the purposes of this specific regression test.`);
    }

    await client.queryRAG('what is this?', null, false, 'session-1');

    const promptSent = client.llm.generate.mock.calls[0][0];
    const promptTokenEstimate = client.tokenEstimate(promptSent);

    expect(promptTokenEstimate).toBeLessThan(150);
  });
});
