const { VectraClient } = require('../src/core');

describe('mmrSelect - embedding-space path', () => {
  const mmr = VectraClient.prototype.mmrSelect;

  it('uses cosine similarity on embeddings when every candidate has one, preferring a diverse pick even when lexical overlap would suggest otherwise', () => {
    // Two candidates share zero lexical tokens with the top pick, but one is
    // embedding-similar to it (should be penalized) and one is embedding-dissimilar
    // (should be preferred) — a case lexical Jaccard alone cannot distinguish,
    // since Jaccard would score both candidates identically (0 overlap).
    const candidates = [
      { content: 'xyz abc def', score: 0.9, embedding: [1, 0, 0] },
      { content: 'qrs tuv wxy', score: 0.85, embedding: [0.99, 0.01, 0] }, // near-identical direction to the first
      { content: 'lmn opq rst', score: 0.8, embedding: [0, 1, 0] }, // orthogonal — genuinely diverse
    ];

    const result = mmr(candidates, 2, 0.3);

    expect(result).toHaveLength(2);
    expect(result[0].content).toBe('xyz abc def');
    expect(result[1].content).toBe('lmn opq rst');
  });

  it('falls back to lexical Jaccard when candidates have no embeddings (existing behavior unchanged)', () => {
    const candidates = [
      { content: 'the quick brown fox jumps over the lazy dog', score: 0.9 },
      { content: 'the quick brown fox jumps over the lazy cat', score: 0.85 },
      { content: 'completely unrelated content about space travel', score: 0.7 },
    ];

    const result = mmr(candidates, 2, 0.1);

    expect(result[1].content).toBe('completely unrelated content about space travel');
  });

  it('falls back to lexical when only SOME candidates have embeddings (partial data treated as none)', () => {
    const candidates = [
      { content: 'alpha beta gamma delta', score: 0.9, embedding: [1, 0] },
      { content: 'epsilon zeta eta theta', score: 0.8 }, // no embedding
    ];

    expect(() => mmr(candidates, 2, 0.5)).not.toThrow();
  });
});
