const { PostgresVectorStore } = require('../../src/backends/postgres_store');
const { PrismaVectorStore } = require('../../src/backends/prisma_store');

describe('ensureIndexes respects a configured embedding dimension', () => {
  it('PostgresVectorStore creates the table with the given dimension, not 1536', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const store = new PostgresVectorStore({ tableName: 'document', clientInstance: { query } });

    await store.ensureIndexes(768);

    const createTableCall = query.mock.calls.find(([sql]) => sql.includes('CREATE TABLE'));
    expect(createTableCall[0]).toContain('vector(768)');
    expect(createTableCall[0]).not.toContain('vector(1536)');
  });

  it('PostgresVectorStore defaults to 1536 when no dimension is given', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const store = new PostgresVectorStore({ tableName: 'document', clientInstance: { query } });

    await store.ensureIndexes();

    const createTableCall = query.mock.calls.find(([sql]) => sql.includes('CREATE TABLE'));
    expect(createTableCall[0]).toContain('vector(1536)');
  });

  it('PrismaVectorStore creates the table with the given dimension, not 1536', async () => {
    const $executeRawUnsafe = jest.fn().mockResolvedValue(undefined);
    const $queryRawUnsafe = jest.fn().mockResolvedValue([]);
    const store = new PrismaVectorStore({ tableName: 'Document', clientInstance: { $executeRawUnsafe, $queryRawUnsafe } });

    await store.ensureIndexes(768);

    const createTableCall = $executeRawUnsafe.mock.calls.find(([sql]) => sql.includes('CREATE TABLE'));
    expect(createTableCall[0]).toContain('vector(768)');
    expect(createTableCall[0]).not.toContain('vector(1536)');
  });
});
