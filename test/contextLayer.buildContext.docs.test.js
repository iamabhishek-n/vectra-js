const { buildContext, _clearTokenCache } = require('../src/contextLayer');

describe('buildContext - docs source', () => {
  beforeEach(() => { _clearTokenCache(); });

  it('packs doc content into parts within budget', async () => {
    const result = await buildContext({
      query: 'what is vectra?',
      budget: { maxTokens: 1000 },
      sources: [{ type: 'docs', items: [
        { content: 'Vectra is a RAG orchestration SDK.', metadata: { source: 'readme.md' } },
      ] }],
    });

    expect(result.parts).toHaveLength(1);
    expect(result.parts[0].type).toBe('docs');
    expect(result.parts[0].content).toContain('Vectra is a RAG orchestration SDK.');
    expect(result.parts[0].tokens).toBeGreaterThan(0);
    expect(result.text).toContain('Vectra is a RAG orchestration SDK.');
    expect(result.tokensUsed).toBeGreaterThan(0);
    expect(result.tokensBudget).toBe(1000);
    expect(result.dropped).toEqual([]);
  });

  it('honestly reports dropped items when budget is exceeded', async () => {
    const longContent = 'word '.repeat(200);
    const result = await buildContext({
      query: 'q',
      budget: { maxTokens: 10 },
      sources: [{ type: 'docs', items: [
        { content: longContent, metadata: { source: 'a.md' } },
        { content: 'short', metadata: { source: 'b.md' } },
      ] }],
    });

    expect(result.dropped.length).toBeGreaterThan(0);
    expect(result.dropped[0].source).toBe('docs');
    const totalAccountedFor = result.parts.length + result.dropped.length;
    expect(totalAccountedFor).toBe(2);
  });

  it('returns an empty result for no sources', async () => {
    const result = await buildContext({ query: 'q', budget: { maxTokens: 100 }, sources: [] });
    expect(result.parts).toEqual([]);
    expect(result.text).toBe('');
    expect(result.tokensUsed).toBe(0);
  });
});
