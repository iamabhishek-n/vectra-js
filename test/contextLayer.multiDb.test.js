const { buildContext, _clearTokenCache } = require('../src/contextLayer');

function makeStore(results) {
  return { similaritySearch: jest.fn().mockResolvedValue(results) };
}

describe('buildContext - multi-db fusion (docs source with stores array)', () => {
  beforeEach(() => { _clearTokenCache(); });

  it('fans out to all stores concurrently and fuses results', async () => {
    const storeA = makeStore([{ content: 'doc from A', metadata: {}, score: 0.9 }]);
    const storeB = makeStore([{ content: 'doc from B', metadata: {}, score: 0.8 }]);

    const result = await buildContext({
      query: 'q',
      budget: { maxTokens: 1000 },
      sources: [{ type: 'docs', stores: [storeA, storeB], vector: [0.1, 0.2], limit: 5 }],
    });

    expect(storeA.similaritySearch).toHaveBeenCalledWith([0.1, 0.2], 5, undefined);
    expect(storeB.similaritySearch).toHaveBeenCalledWith([0.1, 0.2], 5, undefined);
    const contents = result.parts.map(p => p.content);
    expect(contents).toContain('doc from A');
    expect(contents).toContain('doc from B');
  });

  it('a doc findable only in one of two stores survives fusion (real RRF proof, not vacuous)', async () => {
    const storeA = makeStore([
      { content: 'shared doc', metadata: {}, score: 0.5 },
      { content: 'only in A', metadata: {}, score: 0.4 },
    ]);
    const storeB = makeStore([{ content: 'shared doc', metadata: {}, score: 0.5 }]);

    const result = await buildContext({
      query: 'q',
      budget: { maxTokens: 1000 },
      sources: [{ type: 'docs', stores: [storeA, storeB], vector: [0.1], limit: 5 }],
    });

    const contents = result.parts.map(p => p.content);
    expect(contents).toContain('only in A');
    expect(contents).toContain('shared doc');
  });

  it('dedupes by content across stores rather than double-counting the same doc', async () => {
    const storeA = makeStore([{ content: 'dup', metadata: {}, score: 0.9 }]);
    const storeB = makeStore([{ content: 'dup', metadata: {}, score: 0.9 }]);

    const result = await buildContext({
      query: 'q',
      budget: { maxTokens: 1000 },
      sources: [{ type: 'docs', stores: [storeA, storeB], vector: [0.1], limit: 5 }],
    });

    expect(result.parts.filter(p => p.content === 'dup')).toHaveLength(1);
  });

  it('uses hybridSearch instead of similaritySearch when strategy is hybrid and the store supports it', async () => {
    const store = { similaritySearch: jest.fn(), hybridSearch: jest.fn().mockResolvedValue([{ content: 'hybrid result', metadata: {}, score: 0.9 }]) };

    await buildContext({
      query: 'the query text',
      budget: { maxTokens: 1000 },
      sources: [{ type: 'docs', stores: [store], vector: [0.1], limit: 5, strategy: 'hybrid' }],
    });

    expect(store.hybridSearch).toHaveBeenCalledWith('the query text', [0.1], 5, undefined);
    expect(store.similaritySearch).not.toHaveBeenCalled();
  });
});
