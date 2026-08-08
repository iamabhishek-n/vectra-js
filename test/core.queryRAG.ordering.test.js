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

  it('preserves multi-query\'s fused RRF order instead of re-sorting by raw vector score', async () => {
    const client = new VectraClient(makeConfig({
      retrieval: { strategy: RetrievalStrategy.MULTI_QUERY, llmConfig: { provider: ProviderType.OPENAI, apiKey: 'test-key', modelName: 'gpt-4o-mini' } },
    }));

    // docP is ranked FIRST by every sub-query's similaritySearch call, so RRF
    // fusion puts it first — but it deliberately carries the LOWER raw `.score`
    // (0.1 vs docQ's 0.9). This is the discriminating fixture: a raw-score
    // re-sort would flip the order to [Q, P] (Q's score is higher), while the
    // fix (which skips the re-sort for MULTI_QUERY) must keep RRF's [P, Q].
    // With the old fixture (docQ always ranked first AND holding the higher raw
    // score), fusion order and raw-score order coincided, so the test passed
    // even with the buggy gate reverted — this fixture makes them diverge.
    const docP = { content: 'doc P', metadata: { id: 'P' }, score: 0.1 };
    const docQ = { content: 'doc Q', metadata: { id: 'Q' }, score: 0.9 };
    client.embedder.embedQuery = jest.fn().mockResolvedValue([0.1, 0.2]);
    client.retrievalLlm.generate = jest.fn().mockResolvedValue('rephrased query one');
    // Every sub-query (including the original) hits similaritySearch; return docP
    // ranked first every time so RRF fuses to [P, Q] despite P's lower raw score.
    client.vectorStore.similaritySearch = jest.fn().mockResolvedValue([docP, docQ]);
    client.llm.generate = jest.fn().mockResolvedValue('an answer');

    const result = await client.queryRAG('what is this?');

    expect(result.sources).toEqual([{ id: 'P' }, { id: 'Q' }]);
  });

  it('preserves MMR\'s greedy diversity order instead of re-sorting by raw vector score', async () => {
    const client = new VectraClient(makeConfig({
      retrieval: { strategy: RetrievalStrategy.MMR, mmrFetchK: 20, mmrLambda: 0.5 },
    }));

    // fetchK (20, clamped to >= k) is greater than k (5), so mmrSelect actually
    // runs, with no embeddings available so it falls back to lexical Jaccard
    // diversity. docHighA/docHighB are near-duplicates (4 of 5 tokens shared)
    // with the two highest raw scores; docDiverse shares no tokens with either
    // but has the lowest raw score. A raw-score re-sort would produce
    // [HighA, HighB, Diverse]. MMR's greedy selection picks HighA first (best
    // relevance), then — because HighB is heavily penalized for near-duplicating
    // HighA while Diverse has zero overlap — picks Diverse next despite its
    // lower relevance, producing [HighA, Diverse, HighB]. These two orders
    // genuinely disagree (position 2 vs 3 swapped), so this fixture fails if the
    // MMR gate regresses to the old raw-score re-sort. (The prior fixture used
    // three mutually dissimilar docs, where MMR's diversity term is 0 for all
    // three and its output coincides with plain relevance order — identical to
    // the raw-score sort, which is why it passed even with the buggy gate.)
    const docHighA = { content: 'red apple orange banana grape', metadata: { id: 'HighA' }, score: 0.9 };
    const docHighB = { content: 'red apple orange banana melon', metadata: { id: 'HighB' }, score: 0.85 };
    const docDiverse = { content: 'turtle rocket zebra volcano canyon', metadata: { id: 'Diverse' }, score: 0.5 };
    client.embedder.embedQuery = jest.fn().mockResolvedValue([0.1, 0.2]);
    client.embedder.embedDocuments = undefined;
    client.vectorStore.similaritySearch = jest.fn().mockResolvedValue([docHighA, docHighB, docDiverse]);
    client.llm.generate = jest.fn().mockResolvedValue('an answer');

    const result = await client.queryRAG('what is this?');

    expect(result.sources).toEqual([{ id: 'HighA' }, { id: 'Diverse' }, { id: 'HighB' }]);
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
