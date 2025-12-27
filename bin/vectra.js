#!/usr/bin/env node
const { start: startWebConfig } = require('../src/webconfig_server');
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
  
  if (cmd === 'webconfig') {
      const cfgPath = configPath || path.join(process.cwd(), 'vectra-config.json');
      startWebConfig(cfgPath, 'webconfig');
      return;
  }

  if (cmd === 'dashboard') {
      const cfgPath = configPath || path.join(process.cwd(), 'vectra-config.json');
      startWebConfig(cfgPath, 'dashboard');
      return;
  }

  if (!cmd || (!target && cmd !== 'webconfig' && cmd !== 'dashboard')) {
    console.error('Usage: vectra <ingest|query|webconfig|dashboard> <path|text> [--config=path] [--stream]');
    process.exit(1);
  }

  // Lazy load VectraClient to avoid overhead when just running help or webconfig
  const { VectraClient } = require('..');
  
  let cfg = null;
  if (configPath) {
    cfg = JSON.parse(fs.readFileSync(path.resolve(configPath), 'utf-8'));
  } else {
    // Fallback to test config if exists, or null
    try {
      cfg = require(path.resolve(process.cwd(), 'nodejs-test/index.js')).config;
    } catch (e) {
      cfg = null;
    }
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
    process.exit(1);
  }
}

run().catch(e => { console.error(e && e.message ? e.message : String(e)); process.exit(1); });
