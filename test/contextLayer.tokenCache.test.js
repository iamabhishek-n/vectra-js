const { estimateTokensCached, _clearTokenCache } = require('../src/contextLayer');

describe('estimateTokensCached', () => {
  beforeEach(() => { _clearTokenCache(); });

  it('returns a real token count for text', () => {
    expect(estimateTokensCached('Hello, world!')).toBe(4);
  });

  it('does not re-tokenize identical content on a second call', () => {
    const spy = jest.spyOn(require('../src/contextLayer'), '_encodeForTest');
    estimateTokensCached('the quick brown fox');
    estimateTokensCached('the quick brown fox');
    const callsForThisString = spy.mock.calls.filter(c => c[0] === 'the quick brown fox').length;
    expect(callsForThisString).toBeLessThanOrEqual(1);
    spy.mockRestore();
  });

  it('returns 0 for empty/falsy input', () => {
    expect(estimateTokensCached('')).toBe(0);
    expect(estimateTokensCached(null)).toBe(0);
  });
});
