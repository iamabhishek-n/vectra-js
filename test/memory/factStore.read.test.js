const { FactStore } = require('../../src/memory/factStore');

class FakeConn {
  constructor(rows) {
    this.rows = rows;
    this.lastQuery = null;
    this.lastParams = null;
    this.query = jest.fn(async (q, params) => {
      this.lastQuery = q;
      this.lastParams = params;
      return { rows: this.rows };
    });
  }
}

describe('FactStore.read', () => {
  it('runs a single query combining vector similarity and temporal validity, scoped to the session', async () => {
    const conn = new FakeConn([
      { id: '1', subject: 'user', predicate: 'likes', object: 'coffee', validAt: new Date(), invalidAt: null },
    ]);
    const embedder = { embedQuery: jest.fn(async () => [0.1, 0.2]) };
    const store = new FactStore({ clientInstance: conn, tableName: 'VectraFact', embedder });

    const facts = await store.read('session-1', 'what does the user like?', { limit: 5 });

    expect(conn.query).toHaveBeenCalledTimes(1); // single batched query, no N+1
    expect(conn.lastQuery).toContain('"invalidAt" IS NULL');
    expect(conn.lastQuery).toContain('"sessionId" = $1');
    expect(conn.lastQuery.toLowerCase()).toContain('order by');
    expect(conn.lastParams[0]).toBe('session-1');

    expect(facts).toHaveLength(1);
    expect(facts[0]).toEqual({ id: '1', subject: 'user', predicate: 'likes', object: 'coffee', validAt: expect.any(Date), invalidAt: null });
    expect(facts[0].embedding).toBeUndefined();
  });

  it('returns an empty array and does not query when sessionId is missing', async () => {
    const conn = new FakeConn([]);
    const embedder = { embedQuery: jest.fn(async () => [0.1, 0.2]) };
    const store = new FactStore({ clientInstance: conn, tableName: 'VectraFact', embedder });

    const facts = await store.read(null, 'query');

    expect(facts).toEqual([]);
    expect(conn.query).not.toHaveBeenCalled();
  });

  it('respects the limit parameter', async () => {
    const conn = new FakeConn([]);
    const embedder = { embedQuery: jest.fn(async () => [0.1, 0.2]) };
    const store = new FactStore({ clientInstance: conn, tableName: 'VectraFact', embedder });

    await store.read('session-1', 'query', { limit: 3 });

    expect(conn.lastQuery.toLowerCase()).toContain('limit');
    expect(conn.lastParams).toContain(3);
  });
});
