const { CrossEncoderReranker } = require('../src/reranker');

function makeDocs(n) {
  return Array.from({ length: n }, (_, i) => ({ content: `doc ${i}`, metadata: {}, score: 1 - i * 0.01 }));
}

describe('CrossEncoderReranker - Cohere', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; jest.restoreAllMocks(); });

  it('calls the Cohere rerank API and reorders documents by relevance', async () => {
    const docs = makeDocs(3);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ index: 2, relevance_score: 0.9 }, { index: 0, relevance_score: 0.5 }] }),
    });
    const reranker = new CrossEncoderReranker({ provider: 'cohere', apiKey: 'test-key', topN: 2 });

    const result = await reranker.rerank('a query', docs);

    expect(result).toEqual([docs[2], docs[0]]);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.cohere.com/v2/rerank');
    expect(options.method).toBe('POST');
    expect(options.headers.Authorization).toBe('Bearer test-key');
    const body = JSON.parse(options.body);
    expect(body.query).toBe('a query');
    expect(body.documents).toEqual(['doc 0', 'doc 1', 'doc 2']);
    expect(body.top_n).toBe(2);
  });

  it('falls back to passthrough when no API key is configured, warning on the way out', async () => {
    global.fetch = jest.fn();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const reranker = new CrossEncoderReranker({ provider: 'cohere', topN: 2 });
    delete process.env.COHERE_API_KEY;
    await expect(reranker.rerank('q', makeDocs(2))).resolves.toEqual(makeDocs(2).slice(0, 2));
    // Falls back to passthrough (fail-soft), not a thrown error to the caller —
    // but verify it didn't attempt a network call with no key.
    expect(global.fetch).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Cohere rerank failed'));
  });

  it('falls back to original order on a non-ok HTTP response, warning on the way out', async () => {
    const docs = makeDocs(3);
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const reranker = new CrossEncoderReranker({ provider: 'cohere', apiKey: 'test-key', topN: 2 });

    const result = await reranker.rerank('q', docs);

    expect(result).toEqual(docs.slice(0, 2));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Cohere rerank failed'));
  });

  it('falls back to original order when fetch itself rejects, warning on the way out', async () => {
    const docs = makeDocs(3);
    global.fetch = jest.fn().mockRejectedValue(new Error('network down'));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const reranker = new CrossEncoderReranker({ provider: 'cohere', apiKey: 'test-key', topN: 2 });

    const result = await reranker.rerank('q', docs);

    expect(result).toEqual(docs.slice(0, 2));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Cohere rerank failed'));
  });
});
