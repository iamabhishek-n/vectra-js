const { FactStore } = require('../../src/memory/factStore');

describe('FactStore read cache', () => {
  it('does not re-query for the same session+query within the TTL', async () => {
    const conn = { query: jest.fn(async () => ({ rows: [{ id: '1', subject: 'a', predicate: 'b', object: 'c' }] })) };
    const embedder = { embedQuery: jest.fn(async () => [0.1]) };
    const store = new FactStore({ clientInstance: conn, tableName: 'VectraFact', embedder, cacheTtlMs: 30000 });

    await store.read('session-1', 'same query');
    await store.read('session-1', 'same query');

    expect(conn.query).toHaveBeenCalledTimes(1);
  });

  it('re-queries for a different query text even within the TTL', async () => {
    const conn = { query: jest.fn(async () => ({ rows: [] })) };
    const embedder = { embedQuery: jest.fn(async () => [0.1]) };
    const store = new FactStore({ clientInstance: conn, tableName: 'VectraFact', embedder, cacheTtlMs: 30000 });

    await store.read('session-1', 'query A');
    await store.read('session-1', 'query B');

    expect(conn.query).toHaveBeenCalledTimes(2);
  });

  it('re-queries after the cache entry has expired', async () => {
    const conn = { query: jest.fn(async () => ({ rows: [] })) };
    const embedder = { embedQuery: jest.fn(async () => [0.1]) };
    const store = new FactStore({ clientInstance: conn, tableName: 'VectraFact', embedder, cacheTtlMs: 1 });

    await store.read('session-1', 'query');
    await new Promise(r => setTimeout(r, 10));
    await store.read('session-1', 'query');

    expect(conn.query).toHaveBeenCalledTimes(2);
  });
});
