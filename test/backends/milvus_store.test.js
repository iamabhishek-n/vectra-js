const { MilvusVectorStore } = require('../../src/backends/milvus_store');

describe('MilvusVectorStore', () => {
  it('addDocuments inserts vector, content, and JSON-stringified metadata', async () => {
    const insert = jest.fn().mockResolvedValue(undefined);
    const store = new MilvusVectorStore({ tableName: 'rag_collection', clientInstance: { insert } });

    await store.addDocuments([{ content: 'hello world', metadata: { a: 1 }, embedding: [0.1, 0.2] }]);

    expect(insert).toHaveBeenCalledWith({
      collection_name: 'rag_collection',
      fields_data: [{ vector: [0.1, 0.2], content: 'hello world', metadata: JSON.stringify({ a: 1 }) }],
    });
  });

  it('similaritySearch parses JSON metadata back into an object', async () => {
    const search = jest.fn().mockResolvedValue({
      results: [{ content: 'hello world', metadata: JSON.stringify({ a: 1 }), distance: 0.05 }],
    });
    const store = new MilvusVectorStore({ tableName: 'rag_collection', clientInstance: { search } });

    const results = await store.similaritySearch([0.1, 0.2], 5);

    expect(results).toEqual([{ content: 'hello world', metadata: { a: 1 }, score: 0.05 }]);
  });
});
