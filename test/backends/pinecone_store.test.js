const { PineconeVectorStore } = require('../../src/backends/pinecone_store');

function makeConfig(client) {
  return { clientInstance: client, tableName: 'my-namespace' };
}

describe('PineconeVectorStore', () => {
  it('addDocuments upserts vectors with content bundled into metadata', async () => {
    const client = { upsert: jest.fn().mockResolvedValue() };
    const store = new PineconeVectorStore(makeConfig(client));

    await store.addDocuments([
      { id: 'doc-1', content: 'hello world', embedding: [0.1, 0.2], metadata: { source: 'a.md' } },
    ]);

    expect(client.upsert).toHaveBeenCalledTimes(1);
    const [vectors] = client.upsert.mock.calls[0];
    expect(vectors[0].id).toBe('doc-1');
    expect(vectors[0].values).toEqual([0.1, 0.2]);
    expect(vectors[0].metadata.content).toBe('hello world');
    expect(vectors[0].metadata.source).toBe('a.md');
  });

  it('upsertDocuments behaves the same as addDocuments (Pinecone upsert is idempotent)', async () => {
    const client = { upsert: jest.fn().mockResolvedValue() };
    const store = new PineconeVectorStore(makeConfig(client));

    await store.upsertDocuments([{ id: 'doc-1', content: 'x', embedding: [0.1], metadata: {} }]);

    expect(client.upsert).toHaveBeenCalledTimes(1);
  });

  it('similaritySearch queries and unbundles content back out of metadata', async () => {
    const client = {
      query: jest.fn().mockResolvedValue({
        matches: [
          { id: 'doc-1', score: 0.95, metadata: { content: 'hello world', source: 'a.md' } },
        ],
      }),
    };
    const store = new PineconeVectorStore(makeConfig(client));

    const results = await store.similaritySearch([0.1, 0.2], 5, { source: 'a.md' });

    expect(client.query).toHaveBeenCalledWith(expect.objectContaining({
      vector: [0.1, 0.2],
      topK: 5,
      includeMetadata: true,
    }));
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('hello world');
    expect(results[0].metadata.source).toBe('a.md');
    expect(results[0].score).toBe(0.95);
    expect(results[0].metadata.content).toBeUndefined();
  });
});
