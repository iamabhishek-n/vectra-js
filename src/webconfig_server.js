const http = require('http');
const fs = require('fs');
const path = require('path');
const { RAGConfigSchema, ProviderType, ChunkingStrategy, RetrievalStrategy } = require('./config');

// Simple browser opener using child_process since 'open' package might not be installed
const { exec } = require('child_process');
const openBrowser = (url) => {
  const start = (process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open');
  exec(start + ' ' + url);
};

const DEFAULT_CONFIG = {
  embedding: {
    provider: ProviderType.OPENAI,
    apiKey: "",
    modelName: "text-embedding-3-small",
    dimensions: null
  },
  llm: {
    provider: ProviderType.GEMINI,
    apiKey: "",
    modelName: "gemini-1.5-pro-latest",
    temperature: 0,
    maxTokens: 1024
  },
  database: {
    type: "prisma",
    tableName: "Document",
    columnMap: { content: "content", vector: "vector", metadata: "metadata" }
  },
  chunking: {
    strategy: ChunkingStrategy.RECURSIVE,
    chunkSize: 1000,
    chunkOverlap: 200,
    separators: ["\n\n", "\n", " ", ""]
  },
  retrieval: {
    strategy: RetrievalStrategy.NAIVE,
    hybridAlpha: 0.5
  },
  reranking: {
    enabled: false,
    provider: "llm",
    topN: 5,
    windowSize: 20
  }
};

function serveStatic(res, filePath, contentType) {
  if (fs.existsSync(filePath)) {
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404);
    res.end();
  }
}

function start(configPath, port = 8766, openInBrowser = true) {
  const absConfigPath = path.resolve(configPath);
  
  const createServer = (currentPort) => {
    const server = http.createServer((req, res) => {
      const sendJson = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };

      // Serve index.html
      if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        const filePath = path.join(__dirname, 'ui', 'index.html');
        serveStatic(res, filePath, 'text/html; charset=utf-8');
        return;
      }

      // Serve static assets
      if (req.method === 'GET' && !req.url.startsWith('/config')) {
        const possiblePath = path.join(__dirname, 'ui', req.url.substring(1));
        if (fs.existsSync(possiblePath) && fs.lstatSync(possiblePath).isFile()) {
          const ext = path.extname(possiblePath).toLowerCase();
          let contentType = 'text/plain';
          if (ext === '.css') contentType = 'text/css';
          if (ext === '.js') contentType = 'application/javascript';
          if (ext === '.html') contentType = 'text/html';
          
          serveStatic(res, possiblePath, contentType);
          return;
        }
      }

      if (req.method === 'GET' && req.url === '/config') {
        if (fs.existsSync(absConfigPath)) {
          try {
            const raw = fs.readFileSync(absConfigPath, 'utf-8');
            const json = JSON.parse(raw);
            // Optional: validate with RAGConfigSchema if strictly needed, but for UI we might just load it
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(json));
          } catch (e) {
            sendJson(400, { error: e.message });
          }
        } else {
          sendJson(200, DEFAULT_CONFIG);
        }
        return;
      }

      if (req.method === 'POST' && req.url === '/config') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            // Clean undefined for JSON payload if present
            const cleanJson = data.config ? JSON.parse(JSON.stringify(data.config)) : null;
            
            // Ensure directory exists
            const dir = path.dirname(absConfigPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

            // Write JSON config (for tooling compatibility)
            if (cleanJson) {
              fs.writeFileSync(absConfigPath, JSON.stringify(cleanJson, null, 2), 'utf-8');
            }

            // Write code file if provided
            if (data.code && data.backend) {
              const targetFile = data.backend === 'python' 
                ? path.join(dir, 'vectra_config.py')
                : path.join(dir, 'vectra-config.js');
              fs.writeFileSync(targetFile, String(data.code), 'utf-8');
              sendJson(200, { message: 'Configuration saved successfully!', file: targetFile });
              return;
            }

            sendJson(200, { message: 'Configuration saved successfully!' });
          } catch (e) {
            sendJson(400, { error: e.message });
          }
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        console.log(`Port ${currentPort} is in use, trying ${currentPort + 1}...`);
        if (currentPort + 1 > 65535) {
            console.error("No available ports found.");
            return;
        }
        // Try next port with a new server instance
        createServer(currentPort + 1);
      } else {
        throw e;
      }
    });

    server.listen(currentPort, () => {
      const url = `http://localhost:${currentPort}/`;
      console.log(`Vectra WebConfig running at ${url}`);
      if (openInBrowser) {
        openBrowser(url);
      }
    });
  };

  createServer(port);
}

module.exports = { start };
