const { VectraClient } = require('../src/core');

describe('tokenEstimate', () => {
  const estimate = VectraClient.prototype.tokenEstimate;

  it('returns 0 for empty text', () => {
    expect(estimate('')).toBe(0);
    expect(estimate(null)).toBe(0);
  });

  it('matches the known cl100k_base token count for a short, well-known string', () => {
    // "Hello, world!" is a standard tiktoken example that tokenizes to 4 tokens
    // under cl100k_base — this is a real, verifiable BPE count, not a heuristic.
    expect(estimate('Hello, world!')).toBe(4);
  });

  it('returns a materially different (more accurate) count than the old char/4 heuristic for repeated characters', () => {
    // 50 repetitions of "aaaa" = 200 chars.
    // Old heuristic: Math.floor((200+3)/4) = 50 tokens.
    // Real BPE tokenizes repeated characters far more efficiently.
    const text = 'aaaa'.repeat(50);
    const oldHeuristic = Math.max(1, Math.floor((text.length + 3) / 4));
    const real = estimate(text);
    expect(real).toBeLessThan(oldHeuristic);
  });
});
