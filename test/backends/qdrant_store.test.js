const { QdrantVectorStore } = require('../../src/backends/qdrant_store');

describe('QdrantVectorStore', () => {
  it('addDocuments upserts points with vector and payload', async () => {
    const upsert = jest.fn().mockResolvedValue(undefined);
    const store = new QdrantVectorStore({ tableName: 'rag_collection', clientInstance: { upsert } });

    await store.addDocuments([{ id: 'doc-1', content: 'hello world', metadata: { a: 1 }, embedding: [0.1, 0.2] }]);

    expect(upsert).toHaveBeenCalledWith('rag_collection', {
      points: [{ id: 'doc-1', vector: [0.1, 0.2], payload: { content: 'hello world', metadata: { a: 1 } } }],
    });
  });

  it('similaritySearch maps Qdrant hits into content/metadata/score', async () => {
    const search = jest.fn().mockResolvedValue([
      { payload: { content: 'hello world', metadata: { a: 1 } }, score: 0.92 },
    ]);
    const store = new QdrantVectorStore({ tableName: 'rag_collection', clientInstance: { search } });

    const results = await store.similaritySearch([0.1, 0.2], 5);

    expect(results).toEqual([{ content: 'hello world', metadata: { a: 1 }, score: 0.92 }]);
  });

  it('normalizeFilter turns a flat filter object into a Qdrant must-clause', () => {
    const store = new QdrantVectorStore({ tableName: 'rag_collection', clientInstance: {} });
    expect(store.normalizeFilter({ category: 'docs' })).toEqual({
      must: [{ key: 'metadata.category', match: { value: 'docs' } }],
    });
  });
});
