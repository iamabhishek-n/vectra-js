const { CrossEncoderReranker, getReranker } = require('../src/reranker');
const { RerankingProvider } = require('../src/config');

function makeDocs(n) {
  return Array.from({ length: n }, (_, i) => ({ content: `doc ${i}`, metadata: {}, score: 1 - i * 0.01 }));
}

describe('CrossEncoderReranker - CROSS_ENCODER (local, unimplemented)', () => {
  it('throws a clear "not implemented" error instead of silently falling back to passthrough', async () => {
    const reranker = new CrossEncoderReranker({ provider: RerankingProvider.CROSS_ENCODER, topN: 2 });

    await expect(reranker.rerank('q', makeDocs(3))).rejects.toThrow(/not implemented/i);
  });

  it('is the provider getReranker() returns for a CROSS_ENCODER config, and it still throws end-to-end', async () => {
    const reranker = getReranker({ provider: RerankingProvider.CROSS_ENCODER, topN: 2 }, null);

    expect(reranker).toBeInstanceOf(CrossEncoderReranker);
    await expect(reranker.rerank('q', makeDocs(3))).rejects.toThrow('RerankingProvider.CROSS_ENCODER');
  });

  it('does not throw for an empty document list (nothing to rerank, so nothing to fail on)', async () => {
    const reranker = new CrossEncoderReranker({ provider: RerankingProvider.CROSS_ENCODER, topN: 2 });

    await expect(reranker.rerank('q', [])).resolves.toEqual([]);
  });
});
