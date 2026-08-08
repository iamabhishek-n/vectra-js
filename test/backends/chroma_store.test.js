const { ChromaVectorStore } = require('../../src/backends/chroma_store');

function makeMockCollection() {
  return {
    add: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue({
      documents: [['hello world']],
      metadatas: [[{ a: 1 }]],
      distances: [[0.13]],
    }),
  };
}

describe('ChromaVectorStore', () => {
  it('addDocuments calls collection.add with ids, embeddings, metadatas, documents', async () => {
    const collection = makeMockCollection();
    const clientInstance = { getOrCreateCollection: jest.fn().mockResolvedValue(collection) };
    const store = new ChromaVectorStore({ tableName: 'rag_collection', clientInstance });

    await store.addDocuments([{ id: 'doc-1', content: 'hello world', metadata: { a: 1 }, embedding: [0.1, 0.2] }]);

    expect(collection.add).toHaveBeenCalledWith({
      ids: ['doc-1'],
      embeddings: [[0.1, 0.2]],
      metadatas: [{ a: 1 }],
      documents: ['hello world'],
    });
  });

  it('similaritySearch maps Chroma\'s batched response into flat results', async () => {
    const collection = makeMockCollection();
    const clientInstance = { getOrCreateCollection: jest.fn().mockResolvedValue(collection) };
    const store = new ChromaVectorStore({ tableName: 'rag_collection', clientInstance });

    const results = await store.similaritySearch([0.1, 0.2], 5);

    expect(results).toEqual([{ content: 'hello world', metadata: { a: 1 }, score: 0.87 }]);
  });
});
