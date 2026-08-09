const { FactStore } = require('../../src/memory/factStore');

class FakeConn {
  constructor() {
    this.queries = [];
    this.query = jest.fn(async (q, params) => {
      this.queries.push(q);
      if (q.includes('information_schema.columns')) return { rows: [] };
      return { rows: [] };
    });
  }
}

describe('FactStore.ensureIndexes', () => {
  it('creates the fact table with the given dimension and both a vector index and a temporal index', async () => {
    const conn = new FakeConn();
    const store = new FactStore({ clientInstance: conn, tableName: 'VectraFact' });

    await store.ensureIndexes(768);

    const createTable = conn.queries.find(q => q.includes('CREATE TABLE IF NOT EXISTS'));
    expect(createTable).toBeDefined();
    expect(createTable).toContain('vector(768)');
    expect(createTable).toContain('"subject"');
    expect(createTable).toContain('"predicate"');
    expect(createTable).toContain('"object"');
    expect(createTable).toContain('"validAt"');
    expect(createTable).toContain('"invalidAt"');
    expect(createTable).toContain('"sessionId"');

    const vecIndex = conn.queries.find(q => q.includes('USING hnsw') || q.includes('USING ivfflat'));
    expect(vecIndex).toBeDefined();

    const temporalIndex = conn.queries.find(q => q.toLowerCase().includes('index') && q.includes('"sessionId"') && q.includes('"validAt"'));
    expect(temporalIndex).toBeDefined();
  });

  it('rejects an unsafe table name', () => {
    expect(() => new FactStore({ clientInstance: {}, tableName: 'Fact; DROP TABLE users;--' })).toThrow(/Invalid SQL identifier/);
  });
});
