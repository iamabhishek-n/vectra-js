const { PineconeVectorStore } = require('../../src/backends/pinecone_store');

function makeConfig(client) {
  return { clientInstance: client, tableName: 'ns' };
}

describe('PineconeVectorStore hybrid/CRUD', () => {
  it('hybridSearch fuses semantic and lexical rank, filtering out lexically-unrelated high-score matches', async () => {
    const client = {
      query: jest.fn().mockResolvedValue({
        matches: [
          { id: '1', score: 0.9, metadata: { content: 'the quick brown fox' } },
          { id: '2', score: 0.8, metadata: { content: 'a completely unrelated sentence' } },
          { id: '3', score: 0.85, metadata: { content: 'quick fox jumps high' } },
        ],
      }),
    };
    const store = new PineconeVectorStore(makeConfig(client));

    const results = await store.hybridSearch('quick fox', [0.1, 0.2], 2);

    expect(results).toHaveLength(2);
    const contents = results.map(r => r.content);
    expect(contents).not.toContain('a completely unrelated sentence');
  });

  it('deleteDocuments deletes by ids', async () => {
    const client = { deleteMany: jest.fn().mockResolvedValue() };
    const store = new PineconeVectorStore(makeConfig(client));

    await store.deleteDocuments({ ids: ['doc-1', 'doc-2'] });

    expect(client.deleteMany).toHaveBeenCalled();
  });

  it('fileExists queries by metadata filter and returns a boolean', async () => {
    const client = {
      query: jest.fn().mockResolvedValue({ matches: [{ id: '1', score: 1, metadata: {} }] }),
    };
    const store = new PineconeVectorStore(makeConfig(client));

    const exists = await store.fileExists('abc123', 100, 12345);

    expect(exists).toBe(true);
  });

  it('fileExists returns false when no match found', async () => {
    const client = { query: jest.fn().mockResolvedValue({ matches: [] }) };
    const store = new PineconeVectorStore(makeConfig(client));

    const exists = await store.fileExists('abc123', 100, 12345);

    expect(exists).toBe(false);
  });
});
