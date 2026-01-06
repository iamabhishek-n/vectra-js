#!/usr/bin/env node
const { start: startWebConfig } = require('../src/webconfig_server');
const telemetry = require('../src/telemetry');
const fs = require('fs');
const path = require('path');

async function run() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  
  // Parse args manually to support --config=path and --config path
  let configPath = null;
  let stream = false;
  let target = null;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--config=')) {
      configPath = arg.split('=')[1];
    } else if (arg === '--config') {
      configPath = args[i + 1];
      i++; // Skip next arg
    } else if (arg === '--stream') {
      stream = true;
    } else if (!target && !arg.startsWith('--')) {
      target = arg;
    }
  }

  // Load config for telemetry init if possible
  let cfg = null;
  try {
      const p = configPath ? path.resolve(configPath) : path.join(process.cwd(), 'vectra-config.json');
      if (fs.existsSync(p)) cfg = JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (_) {}

  telemetry.init(cfg || {});
  if (cmd) {
      telemetry.track('cli_command_used', {
          command: cmd,
          flags: stream ? ['--stream'] : []
      });
  }
  
  if (cmd === 'webconfig') {
      const cfgPath = configPath || path.join(process.cwd(), 'vectra-config.json');
      startWebConfig(cfgPath, 'webconfig');
      await telemetry.flush();
      return;
  }

  if (cmd === 'dashboard') {
      const cfgPath = configPath || path.join(process.cwd(), 'vectra-config.json');
      startWebConfig(cfgPath, 'dashboard');
      await telemetry.flush();
      return;
  }

  if (!cmd || (!target && cmd !== 'webconfig' && cmd !== 'dashboard')) {
    console.error('Usage: vectra <ingest|query|webconfig|dashboard> <path|text> [--config=path] [--stream]');
    await telemetry.flush();
    process.exit(1);
  }

  // Lazy load VectraClient to avoid overhead when just running help or webconfig
  const { VectraClient } = require('..');
  
  // Re-load config if we just did a quick check earlier
  if (configPath && !cfg) {
    cfg = JSON.parse(fs.readFileSync(path.resolve(configPath), 'utf-8'));
  } else if (!cfg) {
    // Fallback to test config if exists, or null
    try {
      cfg = require(path.resolve(process.cwd(), 'nodejs-test/index.js')).config;
    } catch (e) {
      cfg = null;
    }
  }
  
  // VectraClient will re-init telemetry but that's fine (idempotent)
  if (cfg) {
      cfg.sessionType = 'cli';
  }
  const client = new VectraClient(cfg);
  if (cmd === 'ingest') {
    await client.ingestDocuments(path.resolve(process.cwd(), target));
    console.log('Ingestion complete');
  } else if (cmd === 'query') {
    const res = await client.queryRAG(target, null, stream);
    if (stream) {
      for await (const chunk of res) {
        const t = chunk.delta || chunk;
        process.stdout.write(String(t));
      }
      process.stdout.write('\n');
    } else {
      console.log(JSON.stringify(res, null, 2));
    }
  } else {
    console.error('Unknown command');
    await telemetry.flush();
    process.exit(1);
  }
  await telemetry.flush();
}

run().catch(async e => { 
    console.error(e && e.message ? e.message : String(e)); 
    try { await telemetry.flush(); } catch {}
    process.exit(1); 
});
