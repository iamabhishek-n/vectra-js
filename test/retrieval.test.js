const { VectraClient } = require('../src/core');

describe('reciprocalRankFusion', () => {
  const rrf = VectraClient.prototype.reciprocalRankFusion;

  it('merges two ranked lists and favors docs that appear in both', () => {
    const listA = [{ content: 'alpha' }, { content: 'beta' }];
    const listB = [{ content: 'beta' }, { content: 'gamma' }];
    const result = rrf([listA, listB]);
    expect(result.map(d => d.content)).toEqual(['beta', 'alpha', 'gamma']);
  });

  it('returns an empty array for empty input', () => {
    expect(rrf([])).toEqual([]);
  });

  it('deduplicates by content, keeping the first-seen doc object', () => {
    const listA = [{ content: 'same', tag: 'first' }];
    const listB = [{ content: 'same', tag: 'second' }];
    const result = rrf([listA, listB]);
    expect(result).toHaveLength(1);
    expect(result[0].tag).toBe('first');
  });
});

describe('mmrSelect', () => {
  const mmr = VectraClient.prototype.mmrSelect;

  it('returns an empty array for empty candidates', () => {
    expect(mmr([], 5, 0.5)).toEqual([]);
  });

  it('always includes the highest-scoring candidate first', () => {
    const candidates = [
      { content: 'low score doc about cats', score: 0.2 },
      { content: 'high score doc about dogs', score: 0.9 },
    ];
    const result = mmr(candidates, 2, 0.5);
    expect(result[0].content).toBe('high score doc about dogs');
  });

  it('prefers a diverse second pick over a near-duplicate of the first', () => {
    const candidates = [
      { content: 'the quick brown fox jumps over the lazy dog', score: 0.9 },
      { content: 'the quick brown fox jumps over the lazy cat', score: 0.85 },
      { content: 'completely unrelated content about space travel', score: 0.7 },
    ];
    const result = mmr(candidates, 2, 0.1);
    expect(result).toHaveLength(2);
    expect(result[1].content).toBe('completely unrelated content about space travel');
  });

  it('respects the k limit', () => {
    const candidates = Array.from({ length: 10 }, (_, i) => ({
      content: `doc number ${i} with unique words ${i}${i}${i}`,
      score: 1 - i * 0.05,
    }));
    const result = mmr(candidates, 3, 0.5);
    expect(result).toHaveLength(3);
  });
});
