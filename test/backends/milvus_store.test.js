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

    // Default metricType is 'COSINE', which passes the raw score through
    // unchanged (COSINE/IP are already higher-is-better in Milvus's convention).
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

  describe('metricType: COSINE (default)', () => {
    it('passes positive COSINE scores through unchanged, no inversion', async () => {
      const search = jest.fn().mockResolvedValue({
        results: [{ content: 'hello world', metadata: '{}', score: 0.9 }],
      });
      const store = new MilvusVectorStore({ tableName: 'rag_collection', clientInstance: { search }, metricType: 'COSINE' });

      const results = await store.similaritySearch([0.1, 0.2], 5);

      expect(results[0].score).toBe(0.9);
    });

    it('passes negative COSINE scores (dissimilar vectors) through unchanged, not inverted to a huge positive number', async () => {
      const search = jest.fn().mockResolvedValue({
        results: [{ content: 'dissimilar', metadata: '{}', score: -1 }],
      });
      const store = new MilvusVectorStore({ tableName: 'rag_collection', clientInstance: { search }, metricType: 'COSINE' });

      const results = await store.similaritySearch([0.1, 0.2], 5);

      // The old 1/(1+score) heuristic would map -1 to Infinity. With COSINE
      // passthrough, -1 stays -1 — correctly the worst (most dissimilar) score.
      expect(results[0].score).toBe(-1);
    });

    it('preserves relative order for COSINE scores spanning the full [-1, 1] range', async () => {
      const search = jest.fn().mockResolvedValue({
        results: [
          { content: 'dissimilar', metadata: '{}', score: -0.5 },
          { content: 'similar', metadata: '{}', score: 0.95 },
        ],
      });
      const store = new MilvusVectorStore({ tableName: 'rag_collection', clientInstance: { search }, metricType: 'COSINE' });

      const results = await store.similaritySearch([0.1, 0.2], 5);

      const similar = results.find(r => r.content === 'similar');
      const dissimilar = results.find(r => r.content === 'dissimilar');
      expect(similar.score).toBeGreaterThan(dissimilar.score);
    });
  });

  describe('metricType: IP', () => {
    it('passes IP scores through unchanged, no inversion', async () => {
      const search = jest.fn().mockResolvedValue({
        results: [{ content: 'hello world', metadata: '{}', score: 12.5 }],
      });
      const store = new MilvusVectorStore({ tableName: 'rag_collection', clientInstance: { search }, metricType: 'IP' });

      const results = await store.similaritySearch([0.1, 0.2], 5);

      expect(results[0].score).toBe(12.5);
    });
  });

  describe('metricType: L2', () => {
    it('inverts unbounded L2 distances into a bounded higher-is-better score', async () => {
      const search = jest.fn().mockResolvedValue({
        results: [{ content: 'hello world', metadata: '{}', score: 4 }],
      });
      const store = new MilvusVectorStore({ tableName: 'rag_collection', clientInstance: { search }, metricType: 'L2' });

      const results = await store.similaritySearch([0.1, 0.2], 5);

      // 1 / (1 + 4) = 0.2 — larger raw distance yields a smaller (worse) normalized score.
      expect(results[0].score).toBeCloseTo(0.2);
    });

    it('inverts sub-1 L2 distances correctly (a common case for normalized-embedding L2 distances)', async () => {
      const search = jest.fn().mockResolvedValue({
        results: [{ content: 'hello world', metadata: '{}', score: 0.05 }],
      });
      const store = new MilvusVectorStore({ tableName: 'rag_collection', clientInstance: { search }, metricType: 'L2' });

      const results = await store.similaritySearch([0.1, 0.2], 5);

      // 1 / (1 + 0.05) ≈ 0.952 — the old heuristic would have wrongly passed
      // 0.05 through unchanged since it fell inside [0, 1].
      expect(results[0].score).toBeCloseTo(1 / 1.05);
    });

    it('maps a perfect L2 match (distance 0) to the best possible normalized score', async () => {
      const search = jest.fn().mockResolvedValue({
        results: [{ content: 'exact match', metadata: '{}', score: 0 }],
      });
      const store = new MilvusVectorStore({ tableName: 'rag_collection', clientInstance: { search }, metricType: 'L2' });

      const results = await store.similaritySearch([0.1, 0.2], 5);

      expect(results[0].score).toBe(1);
    });

    it('is monotonic across the old 1.0 boundary (no ranking flip between 1 and 1.0001)', async () => {
      const search = jest.fn().mockResolvedValue({
        results: [
          { content: 'at-boundary', metadata: '{}', score: 1 },
          { content: 'just-past-boundary', metadata: '{}', score: 1.0001 },
        ],
      });
      const store = new MilvusVectorStore({ tableName: 'rag_collection', clientInstance: { search }, metricType: 'L2' });

      const results = await store.similaritySearch([0.1, 0.2], 5);

      const atBoundary = results.find(r => r.content === 'at-boundary');
      const justPast = results.find(r => r.content === 'just-past-boundary');
      // Smaller distance (1) must still score higher than the larger distance
      // (1.0001), and the two scores must be close together, not a step change.
      expect(atBoundary.score).toBeGreaterThan(justPast.score);
      expect(atBoundary.score - justPast.score).toBeLessThan(0.001);
    });

    it('similaritySearch normalization preserves relative order: smaller L2 distance -> larger normalized score', async () => {
      const search = jest.fn().mockResolvedValue({
        results: [
          { content: 'far', metadata: '{}', score: 10 },
          { content: 'near', metadata: '{}', score: 2 },
        ],
      });
      const store = new MilvusVectorStore({ tableName: 'rag_collection', clientInstance: { search }, metricType: 'L2' });

      const results = await store.similaritySearch([0.1, 0.2], 5);

      const near = results.find(r => r.content === 'near');
      const far = results.find(r => r.content === 'far');
      expect(near.score).toBeGreaterThan(far.score);
    });
  });
});
