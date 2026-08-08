const { MilvusVectorStore } = require('../../src/backends/milvus_store');

describe('MilvusVectorStore.hybridSearch', () => {
  it('fuses semantic and lexical rank, excluding a semantically-close but lexically-unrelated result from top-2', async () => {
    const search = jest.fn().mockResolvedValue({
      results: [
        { content: 'the quick brown fox', metadata: '{}', distance: 0.1 },
        { content: 'a completely unrelated sentence', metadata: '{}', distance: 0.15 },
        { content: 'quick fox jumps high', metadata: '{}', distance: 0.12 },
      ],
    });
    const store = new MilvusVectorStore({ tableName: 'rag_collection', clientInstance: { search } });

    const results = await store.hybridSearch('quick fox', [0.1, 0.2], 2);

    expect(results).toHaveLength(2);
    expect(results.map(r => r.content)).not.toContain('a completely unrelated sentence');
  });
});
