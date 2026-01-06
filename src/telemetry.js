const fs = require('fs');
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const packageJson = require('../package.json');

const TELEMETRY_DIR = path.join(os.homedir(), '.vectra');
const TELEMETRY_FILE = path.join(TELEMETRY_DIR, 'telemetry.json');

const BATCH_SIZE = 10;
const FLUSH_INTERVAL_MS = 60_000;

const API_ENDPOINT =
  process.env.VECTRA_TELEMETRY_ENDPOINT ||
  'https://thwcefdrkimerqztvfjj.supabase.co/functions/v1/vectra-collect';


class TelemetryManager {
  constructor() {
    this.distinctId = null;
    this.queue = [];
    this.timer = null;
    this.enabled = true;
    this.initialized = false;

    this.globalProperties = {
      sdk: 'vectra-node',
      sdk_version: packageJson.version,
      language: 'node',
      runtime: `node-${process.version}`,
      os: process.platform,
      ci: !!process.env.CI,
      telemetry_version: 1,
    };
  }

  init(config = {}) {
    if (this.initialized) return;

    if (config.telemetry?.enabled === false) {
      this.enabled = false;
      return;
    }

    if (
      process.env.VECTRA_TELEMETRY_DISABLED === '1' ||
      process.env.DO_NOT_TRACK === '1'
    ) {
      this.enabled = false;
      return;
    }

    this._loadIdentity();
    this._startFlushTimer();
    this.initialized = true;
  }

  _loadIdentity() {
    try {
      if (!fs.existsSync(TELEMETRY_DIR)) {
        fs.mkdirSync(TELEMETRY_DIR, { recursive: true });
      }

      if (fs.existsSync(TELEMETRY_FILE)) {
        const data = JSON.parse(fs.readFileSync(TELEMETRY_FILE, 'utf8'));
        if (data.distinct_id) {
          this.distinctId = data.distinct_id;
          return;
        }
      }

      this.distinctId = `anon_${uuidv4()}`;
      fs.writeFileSync(
        TELEMETRY_FILE,
        JSON.stringify({ distinct_id: this.distinctId }, null, 2)
      );
    } catch {
      this.enabled = false;
    }
  }

  track(event, properties = {}) {
  if (!this.enabled || !this.distinctId) return;

  this.queue.push({
    event,
    distinct_id: this.distinctId,
    timestamp: new Date().toISOString(),
    properties: {
      ...this.globalProperties,
      ...properties,
    },
  });

  if (this.queue.length >= BATCH_SIZE) {
    setImmediate(() => this.flush());
  }
}
  

  async flush() {
    if (!this.enabled || this.queue.length === 0) return;

    const batch = this.queue.splice(0, this.queue.length);

    if (!global.fetch || !SUPABASE_ANON_KEY) {
      if (process.env.VECTRA_TELEMETRY_DEBUG) {
        console.log('Telemetry batch (debug):', batch);
      }
      return;
    }

    try {
      await fetch(API_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(batch), 
        signal: AbortSignal.timeout(6000),
      });

      if (process.env.VECTRA_TELEMETRY_DEBUG) {
        console.log('Telemetry batch flushed');
      }
    } catch (err) {
      if (process.env.VECTRA_TELEMETRY_DEBUG) {
        console.error('Telemetry flush failed:', err);
      }
      // Drop on error (OSS-safe choice)
    }
  }

  _startFlushTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
  }

  shutdown() {
    if (this.timer) clearInterval(this.timer);
    return this.flush();
  }
}

module.exports = new TelemetryManager();
