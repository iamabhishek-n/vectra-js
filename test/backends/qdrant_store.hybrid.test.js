const { QdrantVectorStore } = require('../../src/backends/qdrant_store');

describe('QdrantVectorStore.hybridSearch', () => {
  it('fuses semantic and lexical rank, excluding a semantically-close but lexically-unrelated result from top-2', async () => {
    const search = jest.fn().mockResolvedValue([
      { payload: { content: 'the quick brown fox', metadata: {} }, score: 0.9 },
      { payload: { content: 'a completely unrelated sentence', metadata: {} }, score: 0.8 },
      { payload: { content: 'quick fox jumps high', metadata: {} }, score: 0.85 },
    ]);
    const store = new QdrantVectorStore({ tableName: 'rag_collection', clientInstance: { search } });

    const results = await store.hybridSearch('quick fox', [0.1, 0.2], 2);

    expect(results).toHaveLength(2);
    expect(results.map(r => r.content)).not.toContain('a completely unrelated sentence');
  });
});
