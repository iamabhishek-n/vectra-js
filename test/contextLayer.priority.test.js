const { buildContext, _clearTokenCache } = require('../src/contextLayer');

describe('buildContext - priority order', () => {
  beforeEach(() => { _clearTokenCache(); });

  it('gives earlier-priority sources first claim on a tight budget', async () => {
    const factStore = { read: jest.fn(async () => [{ subject: 'user', predicate: 'likes', object: 'coffee' }]) };
    const bigDoc = 'word '.repeat(50);

    const result = await buildContext({
      query: 'q',
      budget: { maxTokens: 10 },
      sources: [
        { type: 'docs', items: [{ content: bigDoc, metadata: {} }] },
        { type: 'memory', factStore, sessionId: 's1' },
      ],
      priority: ['memory', 'docs'],
    });

    expect(result.parts.some(p => p.type === 'memory')).toBe(true);
    expect(result.parts.some(p => p.type === 'docs')).toBe(false);
    expect(result.dropped.some(d => d.source === 'docs')).toBe(true);
  });

  it('a source type not listed in priority still processes (falls to the end), not silently dropped wholesale', async () => {
    const result = await buildContext({
      query: 'q',
      budget: { maxTokens: 1000 },
      sources: [{ type: 'tools', results: [{ name: 'x', output: 'y' }] }],
      priority: ['memory', 'docs'],
    });
    expect(result.parts).toHaveLength(1);
    expect(result.parts[0].type).toBe('tools');
  });

  it('an unlisted source type falls AFTER listed ones in processing order, not before', async () => {
    const factStore = { read: jest.fn(async () => [{ subject: 'user', predicate: 'likes', object: 'coffee' }]) };
    const result = await buildContext({
      query: 'q',
      budget: { maxTokens: 1000 },
      sources: [
        { type: 'tools', results: [{ name: 'x', output: 'y' }] }, // unlisted in priority
        { type: 'memory', factStore, sessionId: 's1' }, // listed, should win the ordering race
      ],
      priority: ['memory', 'docs'],
    });
    expect(result.parts[0].type).toBe('memory');
    expect(result.parts[1].type).toBe('tools');
  });

  it('with no priority given, sources are processed in the order supplied', async () => {
    const result = await buildContext({
      query: 'q',
      budget: { maxTokens: 1000 },
      sources: [
        { type: 'tools', results: [{ name: 'x', output: 'y' }] },
        { type: 'docs', items: [{ content: 'doc content', metadata: {} }] },
      ],
    });
    expect(result.parts[0].type).toBe('tools');
    expect(result.parts[1].type).toBe('docs');
  });
});
