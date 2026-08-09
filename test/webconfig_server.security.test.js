const fs = require('fs');
const os = require('os');
const path = require('path');
const { start } = require('../src/webconfig_server');

describe('webconfig_server security', () => {
  let tmpDir, configPath, handle;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vectra-webconfig-test-'));
    configPath = path.join(tmpDir, 'vectra-config.json');
    fs.writeFileSync(configPath, JSON.stringify({ embedding: { apiKey: 'sk-secret-123' } }));
    handle = await start(configPath, 'webconfig', 0, false);
  });

  afterEach(async () => {
    await new Promise((resolve) => handle.server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const baseUrl = () => `http://127.0.0.1:${handle.port}`;

  it('binds to loopback, not all interfaces', () => {
    const addr = handle.server.address();
    expect(['127.0.0.1', '::1']).toContain(addr.address);
  });

  it('blocks path traversal on the /dashboard/ static asset route (no auth needed to prove this, static assets are open by design)', async () => {
    const res = await fetch(`${baseUrl()}/dashboard/${encodeURIComponent('../../../../../../etc/passwd')}`);
    expect(res.status).not.toBe(200);
    const body = await res.text();
    expect(body).not.toContain('root:');
  });

  it('blocks path traversal on the legacy /ui static asset route', async () => {
    const res = await fetch(`${baseUrl()}/${encodeURIComponent('../../../../../../etc/passwd')}`);
    expect(res.status).not.toBe(200);
    const body = await res.text();
    expect(body).not.toContain('root:');
  });

  it('rejects GET /config with no token', async () => {
    const res = await fetch(`${baseUrl()}/config`);
    expect(res.status).toBe(401);
  });

  it('rejects GET /config with a wrong token', async () => {
    const res = await fetch(`${baseUrl()}/config`, { headers: { 'X-Vectra-Token': 'not-the-real-token' } });
    expect(res.status).toBe(401);
  });

  it('allows GET /config with the correct token via header', async () => {
    const res = await fetch(`${baseUrl()}/config`, { headers: { 'X-Vectra-Token': handle.authToken } });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.embedding.apiKey).toBe('sk-secret-123');
  });

  it('rejects POST /config with no token, and does not write the file', async () => {
    const before = fs.readFileSync(configPath, 'utf-8');
    const res = await fetch(`${baseUrl()}/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: { embedding: { apiKey: 'PWNED' } } }),
    });
    expect(res.status).toBe(401);
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);
  });

  it('rejects POST /config with no token even when Content-Type is text/plain (CSRF-style simple request)', async () => {
    const before = fs.readFileSync(configPath, 'utf-8');
    const res = await fetch(`${baseUrl()}/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ config: { embedding: { apiKey: 'PWNED' } } }),
    });
    expect(res.status).toBe(401);
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);
  });

  it('allows POST /config with the correct token and writes the file', async () => {
    const res = await fetch(`${baseUrl()}/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Vectra-Token': handle.authToken },
      body: JSON.stringify({ config: { embedding: { apiKey: 'sk-new-key' } } }),
    });
    expect(res.status).toBe(200);
    const written = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(written.embedding.apiKey).toBe('sk-new-key');
  });

  it('rejects GET /api/observability/stats with no token', async () => {
    const res = await fetch(`${baseUrl()}/api/observability/stats`);
    expect(res.status).toBe(401);
  });

  it('injects the auth token into served HTML (unauthenticated fetch) so the dashboard UI can call protected routes', async () => {
    const res = await fetch(`${baseUrl()}/dashboard/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(handle.authToken);
  });
});
