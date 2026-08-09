const { buildContext, _clearTokenCache } = require('../src/contextLayer');

describe('buildContext - tools source', () => {
  beforeEach(() => { _clearTokenCache(); });

  it('packs pre-computed tool results into parts', async () => {
    const result = await buildContext({
      query: 'q',
      budget: { maxTokens: 1000 },
      sources: [{ type: 'tools', results: [
        { name: 'get_weather', output: 'Sunny, 22C' },
      ] }],
    });

    expect(result.parts).toHaveLength(1);
    expect(result.parts[0].type).toBe('tools');
    expect(result.parts[0].content).toContain('get_weather');
    expect(result.parts[0].content).toContain('Sunny, 22C');
  });

  it('does not execute anything — results are used verbatim as given', async () => {
    const output = { note: 'this is data, not a function' };
    const result = await buildContext({
      query: 'q',
      budget: { maxTokens: 1000 },
      sources: [{ type: 'tools', results: [{ name: 'x', output: JSON.stringify(output) }] }],
    });
    expect(result.parts[0].content).toContain('this is data, not a function');
  });

  it('honestly drops tool results that do not fit the budget', async () => {
    const result = await buildContext({
      query: 'q',
      budget: { maxTokens: 2 },
      sources: [{ type: 'tools', results: [{ name: 'x', output: 'word '.repeat(50) }] }],
    });
    expect(result.parts).toHaveLength(0);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].source).toBe('tools');
  });
});
