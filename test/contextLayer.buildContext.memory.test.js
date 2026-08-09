const { buildContext, _clearTokenCache } = require('../src/contextLayer');

function fakeFactStore(facts) {
  return { read: jest.fn(async () => facts) };
}

describe('buildContext - memory source', () => {
  beforeEach(() => { _clearTokenCache(); });

  it('packs facts from FactStore.read into parts, counted against the budget', async () => {
    const factStore = fakeFactStore([
      { subject: 'user', predicate: 'likes', object: 'coffee' },
    ]);

    const result = await buildContext({
      query: 'what does the user like',
      budget: { maxTokens: 1000 },
      sources: [{ type: 'memory', factStore, sessionId: 'session-1' }],
    });

    expect(factStore.read).toHaveBeenCalledWith('session-1', 'what does the user like');
    expect(result.parts).toHaveLength(1);
    expect(result.parts[0].type).toBe('memory');
    expect(result.parts[0].content).toContain('coffee');
    expect(result.tokensUsed).toBeGreaterThan(0);
  });

  it('memory genuinely competes for budget with docs — a real regression test for the Phase 1 bug', async () => {
    const longDoc = 'word '.repeat(50);
    const factStore = fakeFactStore([{ subject: 'user', predicate: 'likes', object: 'coffee' }]);

    const result = await buildContext({
      query: 'q',
      budget: { maxTokens: 5 },
      sources: [
        { type: 'docs', items: [{ content: longDoc, metadata: {} }] },
        { type: 'memory', factStore, sessionId: 'session-1' },
      ],
    });

    expect(result.dropped.some(d => d.source === 'docs')).toBe(true);
  });

  it('skips the memory source cleanly when no factStore or sessionId is provided', async () => {
    const result = await buildContext({
      query: 'q',
      budget: { maxTokens: 100 },
      sources: [{ type: 'memory', factStore: null, sessionId: 'session-1' }],
    });
    expect(result.parts).toEqual([]);
  });
});
