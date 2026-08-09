const { WeaviateVectorStore } = require('../../src/backends/weaviate_store');

function makeConfig(collection) {
  const client = { collections: { get: jest.fn().mockReturnValue(collection) } };
  return { clientInstance: client, tableName: 'Document' };
}

describe('WeaviateVectorStore hybrid/CRUD', () => {
  it('hybridSearch delegates to the native Weaviate hybrid query (no client-side RRF)', async () => {
    const collection = {
      query: {
        hybrid: jest.fn().mockResolvedValue({
          objects: [
            { properties: { content: 'quick fox jumps high', metadata: '{}' }, metadata: { score: 0.95 } },
          ],
        }),
      },
    };
    const store = new WeaviateVectorStore(makeConfig(collection));

    const results = await store.hybridSearch('quick fox', [0.1, 0.2], 5);

    expect(collection.query.hybrid).toHaveBeenCalledWith('quick fox', expect.objectContaining({ vector: [0.1, 0.2], limit: 5 }));
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('quick fox jumps high');
  });

  it('listDocuments fetches by filter with cursor-based pagination', async () => {
    const collection = {
      query: {
        fetchObjects: jest.fn().mockResolvedValue({
          objects: [{ uuid: 'id-1', properties: { content: 'doc a', metadata: '{}' } }],
        }),
      },
    };
    const store = new WeaviateVectorStore(makeConfig(collection));

    const [docs, cursor] = await store.listDocuments({ limit: 1 });

    expect(collection.query.fetchObjects).toHaveBeenCalledWith(expect.objectContaining({ limit: 1 }));
    expect(docs).toHaveLength(1);
    expect(docs[0].id).toBe('id-1');
    expect(cursor).toBe('id-1');
  });

  it('deleteDocuments deletes by ids', async () => {
    const collection = { data: { deleteById: jest.fn().mockResolvedValue({}) } };
    const store = new WeaviateVectorStore(makeConfig(collection));

    await store.deleteDocuments({ ids: ['doc-1', 'doc-2'] });

    expect(collection.data.deleteById).toHaveBeenCalledTimes(2);
  });

  it('fileExists queries by metadata filter without needing a dummy vector', async () => {
    const collection = {
      query: { fetchObjects: jest.fn().mockResolvedValue({ objects: [{ uuid: 'id-1', properties: {} }] }) },
    };
    const store = new WeaviateVectorStore(makeConfig(collection));

    const exists = await store.fileExists('abc123', 100, 12345);

    expect(collection.query.fetchObjects).toHaveBeenCalled();
    const [opts] = collection.query.fetchObjects.mock.calls[0];
    expect(opts.vector).toBeUndefined();
    expect(exists).toBe(true);
  });

  it('fileExists returns false when no match found', async () => {
    const collection = { query: { fetchObjects: jest.fn().mockResolvedValue({ objects: [] }) } };
    const store = new WeaviateVectorStore(makeConfig(collection));

    const exists = await store.fileExists('abc123', 100, 12345);

    expect(exists).toBe(false);
  });
});
