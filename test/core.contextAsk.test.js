const { VectraClient, ProviderType } = require('../src/core');

function makeConfig(overrides = {}) {
  return {
    embedding: { provider: ProviderType.OPENAI, apiKey: 'test-key' },
    llm: { provider: ProviderType.OPENAI, apiKey: 'test-key', modelName: 'gpt-4o-mini' },
    database: { type: 'chroma', clientInstance: { getOrCreateCollection: jest.fn() } },
    ...overrides,
  };
}

describe('VectraClient.context.ask', () => {
  it('embeds the query, retrieves docs, and returns packed context', async () => {
    const client = new VectraClient(makeConfig());
    client.embedder.embedQuery = jest.fn().mockResolvedValue([0.1, 0.2]);
    client.vectorStore.similaritySearch = jest.fn().mockResolvedValue([
      { content: 'Vectra is a RAG SDK.', metadata: { source: 'readme.md' } },
    ]);

    const result = await client.context.ask('what is vectra?');

    expect(client.embedder.embedQuery).toHaveBeenCalledWith('what is vectra?');
    expect(client.vectorStore.similaritySearch).toHaveBeenCalled();
    expect(result.parts.some(p => p.type === 'docs')).toBe(true);
    expect(result.text).toContain('Vectra is a RAG SDK.');
  });

  it('includes memory when sessionId is given and a factStore is configured', async () => {
    const client = new VectraClient(makeConfig({
      memory: { enabled: true, facts: { enabled: true, clientInstance: {}, tableName: 'F' } },
    }));
    client.embedder.embedQuery = jest.fn().mockResolvedValue([0.1, 0.2]);
    client.vectorStore.similaritySearch = jest.fn().mockResolvedValue([]);
    client.factStore.read = jest.fn().mockResolvedValue([{ subject: 'user', predicate: 'likes', object: 'coffee' }]);

    const result = await client.context.ask('what does the user like', { sessionId: 'session-1' });

    expect(client.factStore.read).toHaveBeenCalledWith('session-1', 'what does the user like');
    expect(result.parts.some(p => p.type === 'memory')).toBe(true);
  });

  it('skips memory cleanly when no sessionId is given, even if a factStore is configured', async () => {
    const client = new VectraClient(makeConfig({
      memory: { enabled: true, facts: { enabled: true, clientInstance: {}, tableName: 'F' } },
    }));
    client.embedder.embedQuery = jest.fn().mockResolvedValue([0.1, 0.2]);
    client.vectorStore.similaritySearch = jest.fn().mockResolvedValue([]);
    client.factStore.read = jest.fn();

    await client.context.ask('q');

    expect(client.factStore.read).not.toHaveBeenCalled();
  });

  it('includes tool results when opts.tools is given', async () => {
    const client = new VectraClient(makeConfig());
    client.embedder.embedQuery = jest.fn().mockResolvedValue([0.1, 0.2]);
    client.vectorStore.similaritySearch = jest.fn().mockResolvedValue([]);

    const result = await client.context.ask('q', { tools: [{ name: 'get_weather', output: 'Sunny' }] });

    expect(result.parts.some(p => p.type === 'tools')).toBe(true);
  });

  it('enforces guardrails before any embedding call, same as queryRAG (found by security review — was bypassable)', async () => {
    const client = new VectraClient(makeConfig({ guardrails: { maxQueryLength: 10 } }));
    client.embedder.embedQuery = jest.fn();

    await expect(client.context.ask('this query is way too long for the limit'))
      .rejects.toThrow('GuardrailViolation: query exceeds maxQueryLength');
    expect(client.embedder.embedQuery).not.toHaveBeenCalled();
  });

  it('runs the onBeforeRetrieve middleware, same as queryRAG (found by security review — was bypassable)', async () => {
    const client = new VectraClient(makeConfig());
    client.embedder.embedQuery = jest.fn().mockResolvedValue([0.1, 0.2]);
    client.vectorStore.similaritySearch = jest.fn().mockResolvedValue([]);
    const middlewareSpy = jest.fn(async (q, v) => [q, v]);
    client.runMiddlewares = jest.fn(async (name, ...args) => {
      if (name === 'onBeforeRetrieve') return middlewareSpy(...args);
      return args;
    });

    await client.context.ask('q');

    expect(client.runMiddlewares).toHaveBeenCalledWith('onBeforeRetrieve', 'q', [0.1, 0.2]);
  });
});
