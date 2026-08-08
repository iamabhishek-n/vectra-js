const { PostgresVectorStore } = require('../../src/backends/postgres_store');

describe('PostgresVectorStore', () => {
  it('throws when constructed without a clientInstance', () => {
    expect(() => new PostgresVectorStore({ tableName: 'document' })).toThrow('clientInstance');
  });

  it('addDocuments issues one parameterized INSERT per document', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const store = new PostgresVectorStore({ tableName: 'document', clientInstance: { query } });

    await store.addDocuments([
      { id: 'doc-1', content: 'hello world', metadata: { a: 1 }, embedding: [0.1, 0.2, 0.3] },
    ]);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('INSERT INTO "document"');
    expect(params[0]).toBe('doc-1');
    expect(params[1]).toBe('hello world');
  });

  it('similaritySearch returns mapped results from the query rows', async () => {
    const query = jest.fn().mockResolvedValue({
      rows: [{ content: 'hello world', metadata: { a: 1 }, score: 0.87 }],
    });
    const store = new PostgresVectorStore({ tableName: 'document', clientInstance: { query } });

    const results = await store.similaritySearch([0.1, 0.2, 0.3], 5);

    expect(results).toEqual([{ content: 'hello world', metadata: { a: 1 }, score: 0.87 }]);
    expect(query.mock.calls[0][0]).toContain('ORDER BY');
  });
});
