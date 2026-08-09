const { buildContext, _clearTokenCache } = require('../src/contextLayer');

function slowStore(ms, result) {
  return {
    similaritySearch: jest.fn(() => new Promise((resolve) => setTimeout(() => resolve(result), ms))),
  };
}

function throwingStore() {
  return { similaritySearch: jest.fn().mockRejectedValue(new Error('connection refused')) };
}

describe('buildContext - multi-db timeout/circuit-breaker', () => {
  beforeEach(() => { _clearTokenCache(); });

  it('a store that throws produces a warning, not a failed buildContext call', async () => {
    const goodStore = { similaritySearch: jest.fn().mockResolvedValue([{ content: 'good doc', metadata: {}, score: 0.9 }]) };
    const badStore = throwingStore();

    const result = await buildContext({
      query: 'q',
      budget: { maxTokens: 1000 },
      sources: [{ type: 'docs', stores: [goodStore, badStore], vector: [0.1], limit: 5 }],
    });

    expect(result.parts.some(p => p.content === 'good doc')).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0].error).toContain('connection refused');
  });

  it('a store that exceeds its timeout produces a warning, does not hang the whole call', async () => {
    const fastStore = { similaritySearch: jest.fn().mockResolvedValue([{ content: 'fast doc', metadata: {}, score: 0.9 }]) };
    const hangingStore = slowStore(10000, [{ content: 'never arrives', metadata: {}, score: 0.9 }]);

    const result = await buildContext({
      query: 'q',
      budget: { maxTokens: 1000 },
      sources: [{ type: 'docs', stores: [fastStore, hangingStore], vector: [0.1], limit: 5, timeoutMs: 50 }],
    });

    expect(result.parts.some(p => p.content === 'fast doc')).toBe(true);
    expect(result.parts.some(p => p.content === 'never arrives')).toBe(false);
    expect(result.warnings.some(w => String(w.error).toLowerCase().includes('timeout'))).toBe(true);
  }, 2000);

  it('total wall-clock time is bounded by the slowest allowed store, not the sum of all stores', async () => {
    const storeA = slowStore(30, [{ content: 'a', metadata: {}, score: 0.9 }]);
    const storeB = slowStore(30, [{ content: 'b', metadata: {}, score: 0.9 }]);
    const storeC = slowStore(30, [{ content: 'c', metadata: {}, score: 0.9 }]);

    const start = Date.now();
    await buildContext({
      query: 'q',
      budget: { maxTokens: 1000 },
      sources: [{ type: 'docs', stores: [storeA, storeB, storeC], vector: [0.1], limit: 5 }],
    });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(80);
  });
});
