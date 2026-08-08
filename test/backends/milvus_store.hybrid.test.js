const { MilvusVectorStore } = require('../../src/backends/milvus_store');

describe('MilvusVectorStore.hybridSearch', () => {
  it('fuses semantic and lexical rank, excluding a semantically-close but lexically-unrelated result from top-2', async () => {
    // Uses the real SDK's `score` field (COSINE-like, already higher-is-better,
    // in [0, 1]) so similaritySearch's normalization passes it through unchanged
    // and hybridSearch's descending sort reflects true "higher = better" order.
    const search = jest.fn().mockResolvedValue({
      results: [
        { content: 'the quick brown fox', metadata: '{}', score: 0.9 },
        { content: 'a completely unrelated sentence', metadata: '{}', score: 0.8 },
        { content: 'quick fox jumps high', metadata: '{}', score: 0.85 },
      ],
    });
    const store = new MilvusVectorStore({ tableName: 'rag_collection', clientInstance: { search } });

    const results = await store.hybridSearch('quick fox', [0.1, 0.2], 2);

    expect(results).toHaveLength(2);
    expect(results.map(r => r.content)).not.toContain('a completely unrelated sentence');
  });

  it('still returns correct fusion order when the SDK sends the legacy `distance` field', async () => {
    const search = jest.fn().mockResolvedValue({
      results: [
        { content: 'the quick brown fox', metadata: '{}', distance: 0.9 },
        { content: 'a completely unrelated sentence', metadata: '{}', distance: 0.8 },
        { content: 'quick fox jumps high', metadata: '{}', distance: 0.85 },
      ],
    });
    const store = new MilvusVectorStore({ tableName: 'rag_collection', clientInstance: { search } });

    const results = await store.hybridSearch('quick fox', [0.1, 0.2], 2);

    expect(results).toHaveLength(2);
    expect(results.map(r => r.content)).not.toContain('a completely unrelated sentence');
  });
});
