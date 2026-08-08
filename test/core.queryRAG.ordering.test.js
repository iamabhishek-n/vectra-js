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

describe('VectraClient.queryRAG - post-retrieval ordering (final-review Critical #1/#2)', () => {
  it('preserves the reranker\'s returned order instead of re-sorting by raw vector score', async () => {
    const client = new VectraClient(makeConfig({
      reranking: { enabled: true, provider: RerankingProvider.LLM, topN: 3, windowSize: 5 },
    }));

    // Vector store returns docs in ascending raw-score order (0.1, 0.5, 0.9).
    // A naive "sort by raw score descending" would produce [B, C, A].
    const docA = { content: 'doc A', metadata: { id: 'A' }, score: 0.1 };
    const docB = { content: 'doc B', metadata: { id: 'B' }, score: 0.9 };
    const docC = { content: 'doc C', metadata: { id: 'C' }, score: 0.5 };
    client.embedder.embedQuery = jest.fn().mockResolvedValue([0.1, 0.2]);
    client.vectorStore.similaritySearch = jest.fn().mockResolvedValue([docA, docB, docC]);

    // The reranker authoritatively reorders to [C, A, B] — deliberately not
    // matching raw-score order, so a leftover boost re-sort would corrupt it.
    client.reranker.rerank = jest.fn().mockResolvedValue([docC, docA, docB]);
    client.llm.generate = jest.fn().mockResolvedValue('an answer');

    const result = await client.queryRAG('what is this?');

    expect(result.sources).toEqual([{ id: 'C' }, { id: 'A' }, { id: 'B' }]);
  });

  it('preserves hybrid search\'s fused RRF order instead of re-sorting by raw vector score', async () => {
    const client = new VectraClient(makeConfig({
      retrieval: { strategy: RetrievalStrategy.HYBRID },
    }));

    // hybridSearch's fused order intentionally contradicts raw-score order
    // (X has a lower raw score than Y but is ranked first by fusion) — this is
    // exactly the scenario a leftover raw-score re-sort would invert, and is
    // also representative of Milvus's unnormalized, lower-is-better distance.
    const docX = { content: 'doc X', metadata: { id: 'X' }, score: 0.1 };
    const docY = { content: 'doc Y', metadata: { id: 'Y' }, score: 0.9 };
    client.embedder.embedQuery = jest.fn().mockResolvedValue([0.1, 0.2]);
    client.vectorStore.hybridSearch = jest.fn().mockResolvedValue([docX, docY]);
    client.llm.generate = jest.fn().mockResolvedValue('an answer');

    const result = await client.queryRAG('what is this?');

    expect(result.sources).toEqual([{ id: 'X' }, { id: 'Y' }]);
  });

  it('still applies the keyword-boost re-sort on the plain vector-similarity path (no reranking, no hybrid)', async () => {
    const client = new VectraClient(makeConfig({}));

    // Plain naive retrieval: raw score ordering plus a keyword-match boost is
    // still the intended ranking signal on this path.
    const docLow = { content: 'low score, keyword match', metadata: { id: 'low', keywords: ['widget'] }, score: 0.1 };
    const docHigh = { content: 'high score, no keyword match', metadata: { id: 'high' }, score: 0.5 };
    client.embedder.embedQuery = jest.fn().mockResolvedValue([0.1, 0.2]);
    client.vectorStore.similaritySearch = jest.fn().mockResolvedValue([docLow, docHigh]);
    client.llm.generate = jest.fn().mockResolvedValue('an answer');

    const result = await client.queryRAG('tell me about widget');

    // docHigh (0.5) still outranks docLow (0.1 + 0.1 keyword boost = 0.2) here,
    // confirming the boost re-sort logic itself is unchanged on this path.
    expect(result.sources).toEqual([{ id: 'high' }, { id: 'low', keywords: ['widget'] }]);
  });
});
