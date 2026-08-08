const { ChromaVectorStore } = require('../../src/backends/chroma_store');

describe('ChromaVectorStore.hybridSearch', () => {
  it('fuses semantic and lexical rank via RRF, favoring docs strong in both', async () => {
    const collection = {
      add: jest.fn(),
      query: jest.fn().mockResolvedValue({
        documents: [['the quick brown fox', 'a completely unrelated sentence', 'quick fox jumps high']],
        metadatas: [[{}, {}, {}]],
        distances: [[0.1, 0.2, 0.15]],
      }),
    };
    const clientInstance = { getOrCreateCollection: jest.fn().mockResolvedValue(collection) };
    const store = new ChromaVectorStore({ tableName: 'rag_collection', clientInstance });

    const results = await store.hybridSearch('quick fox', [0.1, 0.2], 2);

    expect(results).toHaveLength(2);
    // "quick fox jumps high" shares more query terms than "the quick brown fox"
    // and both rank ahead of the semantically-close-but-lexically-unrelated sentence.
    expect(results.map(r => r.content)).not.toContain('a completely unrelated sentence');
  });

  it('returns results even when the query has no lexical overlap with any document', async () => {
    const collection = {
      query: jest.fn().mockResolvedValue({
        documents: [['alpha content', 'beta content']],
        metadatas: [[{}, {}]],
        distances: [[0.1, 0.3]],
      }),
    };
    const clientInstance = { getOrCreateCollection: jest.fn().mockResolvedValue(collection) };
    const store = new ChromaVectorStore({ tableName: 'rag_collection', clientInstance });

    const results = await store.hybridSearch('zzz', [0.1, 0.2], 2);

    expect(results).toHaveLength(2);
  });
});
