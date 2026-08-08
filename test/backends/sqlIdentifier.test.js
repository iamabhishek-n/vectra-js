const postgres = require('../../src/backends/postgres_store');
const prisma = require('../../src/backends/prisma_store');

describe.each([
  ['postgres_store', postgres],
  ['prisma_store', prisma],
])('%s SQL identifier safety', (_name, mod) => {
  it('accepts a plain alphanumeric identifier', () => {
    expect(mod.isSafeIdentifier('content')).toBe(true);
    expect(mod.isSafeIdentifier('_private_col')).toBe(true);
  });

  it('rejects identifiers containing SQL metacharacters', () => {
    expect(mod.isSafeIdentifier('content"; DROP TABLE users; --')).toBe(false);
    expect(mod.isSafeIdentifier("content' OR '1'='1")).toBe(false);
    expect(mod.isSafeIdentifier('content column')).toBe(false);
  });

  it('rejects an identifier starting with a digit', () => {
    expect(mod.isSafeIdentifier('1content')).toBe(false);
  });

  it('quoteIdentifier wraps a safe value in double quotes', () => {
    expect(mod.quoteIdentifier('content', 'test')).toBe('"content"');
  });

  it('quoteIdentifier throws on an unsafe value', () => {
    expect(() => mod.quoteIdentifier('a"; DROP TABLE x; --', 'test')).toThrow('Unsafe SQL identifier');
  });

  it('quoteTableName accepts a plain table name', () => {
    expect(mod.quoteTableName('documents', 'test')).toBe('"documents"');
  });

  it('quoteTableName accepts a schema-qualified table name', () => {
    expect(mod.quoteTableName('public.documents', 'test')).toBe('"public"."documents"');
  });

  it('quoteTableName throws on an injection attempt', () => {
    expect(() => mod.quoteTableName('documents"; DROP TABLE users; --', 'test')).toThrow('Unsafe SQL identifier');
  });

  it('quoteTableName throws on more than one dot-separated part', () => {
    expect(() => mod.quoteTableName('a.b.c', 'test')).toThrow('Unsafe SQL identifier');
  });
});
