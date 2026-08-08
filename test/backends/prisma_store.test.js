const { PrismaVectorStore } = require('../../src/backends/prisma_store');

describe('PrismaVectorStore', () => {
  it('rejects an unsafe table name at construction', () => {
    const clientInstance = { $executeRawUnsafe: jest.fn(), $queryRawUnsafe: jest.fn() };
    expect(() => new PrismaVectorStore({ tableName: 'a"; DROP TABLE x; --', clientInstance }))
      .toThrow('Unsafe SQL identifier');
  });

  it('addDocuments issues one $executeRawUnsafe call per document', async () => {
    const $executeRawUnsafe = jest.fn().mockResolvedValue(undefined);
    const store = new PrismaVectorStore({ tableName: 'Document', clientInstance: { $executeRawUnsafe } });

    await store.addDocuments([
      { id: 'doc-1', content: 'hello world', metadata: { a: 1 }, embedding: [0.3, 0.4] },
    ]);

    expect($executeRawUnsafe).toHaveBeenCalledTimes(1);
    const [sql, id, content] = $executeRawUnsafe.mock.calls[0];
    expect(sql).toContain('INSERT INTO "Document"');
    expect(id).toBe('doc-1');
    expect(content).toBe('hello world');
  });

  it('similaritySearch returns mapped results from $queryRawUnsafe', async () => {
    const $queryRawUnsafe = jest.fn().mockResolvedValue([{ content: 'hello world', metadata: { a: 1 }, score: 0.9 }]);
    const store = new PrismaVectorStore({ tableName: 'Document', clientInstance: { $queryRawUnsafe } });

    const results = await store.similaritySearch([0.3, 0.4], 5);

    expect(results).toEqual([{ content: 'hello world', metadata: { a: 1 }, score: 0.9 }]);
  });
});
