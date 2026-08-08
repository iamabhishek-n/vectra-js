describe('telemetry default-off behavior', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('is disabled by construction, before init() is ever called', () => {
    const mgr = require('../src/telemetry');
    expect(mgr.enabled).toBe(false);
  });

  it('stays disabled when init() is called with no config', () => {
    const mgr = require('../src/telemetry');
    mgr.init();
    expect(mgr.enabled).toBe(false);
  });

  it('stays disabled when telemetry.enabled is omitted from config', () => {
    const mgr = require('../src/telemetry');
    mgr.init({ telemetry: {} });
    expect(mgr.enabled).toBe(false);
  });

  it('enables only when telemetry.enabled is explicitly true', () => {
    jest.resetModules();
    jest.spyOn(require('fs'), 'existsSync').mockReturnValue(false);
    jest.spyOn(require('fs'), 'mkdirSync').mockImplementation(() => {});
    jest.spyOn(require('fs'), 'writeFileSync').mockImplementation(() => {});
    const mgr = require('../src/telemetry');
    mgr.init({ telemetry: { enabled: true } });
    expect(mgr.enabled).toBe(true);
    mgr.shutdown();
    jest.restoreAllMocks();
  });

  it('stays disabled when VECTRA_TELEMETRY_DISABLED=1 even if config says enabled', () => {
    jest.resetModules();
    process.env.VECTRA_TELEMETRY_DISABLED = '1';
    const mgr = require('../src/telemetry');
    mgr.init({ telemetry: { enabled: true } });
    expect(mgr.enabled).toBe(false);
    delete process.env.VECTRA_TELEMETRY_DISABLED;
  });
});
