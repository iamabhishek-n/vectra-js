const { VectraClient, ProviderType } = require('../src/core');

function makeClient(maxFileSizeBytes) {
  return new VectraClient({
    embedding: { provider: ProviderType.OPENAI, apiKey: 'test-key' },
    llm: { provider: ProviderType.OPENAI, apiKey: 'test-key', modelName: 'gpt-4o-mini' },
    database: { type: 'chroma', clientInstance: { getOrCreateCollection: jest.fn() } },
    ingestion: maxFileSizeBytes !== undefined ? { maxFileSizeBytes } : undefined,
  });
}

describe('_validateFile file-size limit', () => {
  it('rejects a file over the configured limit', async () => {
    const client = makeClient(1000);
    await expect(client._validateFile('/tmp/big.txt', { size: 1001, mtimeMs: Date.now() }))
      .rejects.toThrow('File exceeds maximum allowed size');
  });

  it('accepts a file at the configured limit', async () => {
    const client = makeClient(1000);
    // A file at exactly the limit will proceed to hash — point at a real small file so fs.createReadStream succeeds.
    await expect(client._validateFile(__filename, { size: 1000, mtimeMs: Date.now() })).resolves.toBeDefined();
  });

  it('uses the default 50MB limit when not configured', async () => {
    const client = makeClient(undefined);
    await expect(client._validateFile('/tmp/huge.txt', { size: 52428801, mtimeMs: Date.now() }))
      .rejects.toThrow('File exceeds maximum allowed size');
  });

  it('rejects any file when maxFileSizeBytes is explicitly 0', async () => {
    const client = makeClient(0);
    await expect(client._validateFile('/tmp/tiny.txt', { size: 1, mtimeMs: Date.now() }))
      .rejects.toThrow('File exceeds maximum allowed size');
  });
});
