const { VectraClient, ProviderType } = require('../src/core');
const { RetrievalStrategy, RerankingProvider } = require('../src/config');

function makeConfig(overrides = {}) {
  return {
    embedding: { provider: ProviderType.OPENAI, apiKey: 'test-key' },
    llm: { provider: ProviderType.OPENAI, apiKey: 'test-key', modelName: 'gpt-4o-mini' },
    database: { type: 'chroma', clientInstance: { getOrCreateCollection: jest.fn() } },
    ...overrides,
  };
}

describe('VectraClient.queryRAG - MMR skips wasted embed-batch when fetchK <= k (final-review Important #5)', () => {
  it('does not call embedDocuments when reranking is enabled and windowSize collapses fetchK to k', async () => {
    // reranking.enabled defaults k to windowSize (20); mmrFetchK also defaults to
    // 20, so fetchK = max(20, 20) = 20 = k -> no actual MMR selection possible.
    const client = new VectraClient(makeConfig({
      retrieval: { strategy: RetrievalStrategy.MMR },
      reranking: { enabled: true, provider: RerankingProvider.LLM, topN: 3, windowSize: 20 },
    }));

    const candidates = Array.from({ length: 20 }, (_, i) => ({ content: `doc ${i}`, metadata: { id: i }, score: 1 - i * 0.01 }));
    client.embedder.embedQuery = jest.fn().mockResolvedValue([0.1, 0.2]);
    client.embedder.embedDocuments = jest.fn().mockResolvedValue(candidates.map(() => [0, 0]));
    client.vectorStore.similaritySearch = jest.fn().mockResolvedValue(candidates);
    client.reranker.rerank = jest.fn().mockImplementation((q, docs) => Promise.resolve(docs.slice(0, 3)));
    client.llm.generate = jest.fn().mockResolvedValue('an answer');

    await client.queryRAG('what is this?');

    expect(client.embedder.embedDocuments).not.toHaveBeenCalled();
  });

  it('still calls embedDocuments for embedding-space MMR when fetchK > k (an actual selection will occur)', async () => {
    const client = new VectraClient(makeConfig({
      retrieval: { strategy: RetrievalStrategy.MMR, mmrFetchK: 20 },
    }));

    // No reranking -> k defaults to 5; mmrFetchK 20 > k, so fetchK stays 20 > k
    // and an actual MMR selection (and its embedding batch call) should occur.
    const candidates = Array.from({ length: 20 }, (_, i) => ({ content: `doc ${i}`, metadata: { id: i }, score: 1 - i * 0.01 }));
    client.embedder.embedQuery = jest.fn().mockResolvedValue([0.1, 0.2]);
    client.embedder.embedDocuments = jest.fn().mockResolvedValue(candidates.map(() => [0, 0]));
    client.vectorStore.similaritySearch = jest.fn().mockResolvedValue(candidates);
    client.llm.generate = jest.fn().mockResolvedValue('an answer');

    const result = await client.queryRAG('what is this?');

    expect(client.embedder.embedDocuments).toHaveBeenCalledTimes(1);
    expect(result.sources.length).toBe(5);
  });
});
