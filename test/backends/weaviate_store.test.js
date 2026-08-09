const { WeaviateVectorStore } = require('../../src/backends/weaviate_store');

function makeCollection(overrides = {}) {
  return {
    data: { insertMany: jest.fn().mockResolvedValue({}), ...overrides.data },
    query: { nearVector: jest.fn(), ...overrides.query },
  };
}

function makeConfig(collection) {
  const client = { collections: { get: jest.fn().mockReturnValue(collection) } };
  return { clientInstance: client, tableName: 'Document' };
}

describe('WeaviateVectorStore', () => {
  it('addDocuments inserts objects with content/metadata properties and a vector', async () => {
    const collection = makeCollection();
    const store = new WeaviateVectorStore(makeConfig(collection));

    await store.addDocuments([
      { id: 'doc-1', content: 'hello world', embedding: [0.1, 0.2], metadata: { source: 'a.md' } },
    ]);

    expect(collection.data.insertMany).toHaveBeenCalledTimes(1);
    const [objects] = collection.data.insertMany.mock.calls[0];
    expect(objects[0].properties.content).toBe('hello world');
    expect(objects[0].properties.metadata).toBe(JSON.stringify({ source: 'a.md' }));
    expect(objects[0].vector).toEqual([0.1, 0.2]);
  });

  it('upsertDocuments behaves the same as addDocuments (insertMany overwrites on ID collision)', async () => {
    const collection = makeCollection();
    const store = new WeaviateVectorStore(makeConfig(collection));

    await store.upsertDocuments([{ id: 'doc-1', content: 'x', embedding: [0.1], metadata: {} }]);

    expect(collection.data.insertMany).toHaveBeenCalledTimes(1);
  });

  it('similaritySearch queries nearVector and converts distance to a higher-is-better score', async () => {
    const collection = makeCollection({
      query: {
        nearVector: jest.fn().mockResolvedValue({
          objects: [
            { properties: { content: 'hello world', metadata: JSON.stringify({ source: 'a.md' }) }, metadata: { distance: 0.2 } },
          ],
        }),
      },
    });
    const store = new WeaviateVectorStore(makeConfig(collection));

    const results = await store.similaritySearch([0.1, 0.2], 5);

    expect(collection.query.nearVector).toHaveBeenCalledWith([0.1, 0.2], expect.objectContaining({ limit: 5 }));
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('hello world');
    expect(results[0].metadata.source).toBe('a.md');
    expect(results[0].score).toBeCloseTo(0.8);
  });
});
