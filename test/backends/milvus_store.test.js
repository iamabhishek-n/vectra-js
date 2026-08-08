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

    // 0.05 is already inside [0, 1], so the normalization heuristic treats it as
    // an already-similarity value and passes it through unchanged.
    expect(results).toEqual([{ content: 'hello world', metadata: { a: 1 }, score: 0.05 }]);
  });

  it('similaritySearch reads the real SDK\'s `score` field, preferring it over `distance`', async () => {
    const search = jest.fn().mockResolvedValue({
      results: [{ content: 'hello world', metadata: '{}', score: 0.42, distance: 999 }],
    });
    const store = new MilvusVectorStore({ tableName: 'rag_collection', clientInstance: { search } });

    const results = await store.similaritySearch([0.1, 0.2], 5);

    expect(results[0].score).toBe(0.42);
  });

  it('similaritySearch inverts unbounded (L2-style) distances into a bounded higher-is-better score', async () => {
    const search = jest.fn().mockResolvedValue({
      results: [{ content: 'hello world', metadata: '{}', score: 4 }],
    });
    const store = new MilvusVectorStore({ tableName: 'rag_collection', clientInstance: { search } });

    const results = await store.similaritySearch([0.1, 0.2], 5);

    // 1 / (1 + 4) = 0.2 — larger raw distance yields a smaller (worse) normalized score.
    expect(results[0].score).toBeCloseTo(0.2);
  });

  it('similaritySearch normalization preserves relative order: smaller L2 distance -> larger normalized score', async () => {
    const search = jest.fn().mockResolvedValue({
      results: [
        { content: 'far', metadata: '{}', score: 10 },
        { content: 'near', metadata: '{}', score: 2 },
      ],
    });
    const store = new MilvusVectorStore({ tableName: 'rag_collection', clientInstance: { search } });

    const results = await store.similaritySearch([0.1, 0.2], 5);

    const near = results.find(r => r.content === 'near');
    const far = results.find(r => r.content === 'far');
    expect(near.score).toBeGreaterThan(far.score);
  });
});
