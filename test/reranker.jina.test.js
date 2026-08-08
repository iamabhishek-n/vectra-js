const { CrossEncoderReranker } = require('../src/reranker');

function makeDocs(n) {
  return Array.from({ length: n }, (_, i) => ({ content: `doc ${i}`, metadata: {}, score: 1 - i * 0.01 }));
}

describe('CrossEncoderReranker - Jina', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; jest.restoreAllMocks(); });

  it('calls the Jina rerank API and reorders documents by relevance', async () => {
    const docs = makeDocs(3);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ index: 1, relevance_score: 0.88 }, { index: 0, relevance_score: 0.4 }] }),
    });
    const reranker = new CrossEncoderReranker({ provider: 'jina', apiKey: 'test-key', topN: 2 });

    const result = await reranker.rerank('a query', docs);

    expect(result).toEqual([docs[1], docs[0]]);
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.jina.ai/v1/rerank');
    expect(options.headers.Authorization).toBe('Bearer test-key');
    const body = JSON.parse(options.body);
    expect(body.query).toBe('a query');
    expect(body.documents).toEqual(['doc 0', 'doc 1', 'doc 2']);
    expect(body.top_n).toBe(2);
  });

  it('falls back to original order on a non-ok HTTP response, warning on the way out', async () => {
    const docs = makeDocs(3);
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 429 });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const reranker = new CrossEncoderReranker({ provider: 'jina', apiKey: 'test-key', topN: 2 });

    const result = await reranker.rerank('q', docs);

    expect(result).toEqual(docs.slice(0, 2));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Jina rerank failed'));
  });

  it('falls back to original order with no API key configured, warning on the way out', async () => {
    delete process.env.JINA_API_KEY;
    const docs = makeDocs(2);
    global.fetch = jest.fn();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const reranker = new CrossEncoderReranker({ provider: 'jina', topN: 2 });

    const result = await reranker.rerank('q', docs);

    expect(result).toEqual(docs);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Jina rerank failed'));
  });
});
