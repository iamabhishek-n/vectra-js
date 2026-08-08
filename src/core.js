const fs = require('fs');
const path = require('path');
const { RAGConfigSchema, ProviderType, RetrievalStrategy } = require('./config');
const { checkGuardrails } = require('./guardrails');
const crypto = require('crypto');
const { DocumentProcessor } = require('./processor');
const { OpenAIBackend } = require('./backends/openai');
const { GeminiBackend } = require('./backends/gemini');
const { AnthropicBackend } = require('./backends/anthropic');
const { OpenRouterBackend } = require('./backends/openrouter');
const { HuggingFaceBackend } = require('./backends/huggingface');
const { PrismaVectorStore } = require('./backends/prisma_store');
const { ChromaVectorStore } = require('./backends/chroma_store');
const { PostgresVectorStore } = require('./backends/postgres_store');
const { QdrantVectorStore } = require('./backends/qdrant_store');
const { MilvusVectorStore } = require('./backends/milvus_store');
const { getReranker } = require('./reranker');
const { InMemoryHistory, RedisHistory, PostgresHistory } = require('./memory');
const { OllamaBackend } = require('./backends/ollama');
const { v5: uuidv5 } = require('uuid');
const { v4: uuidv4 } = require('uuid');
const SQLiteLogger = require('./observability');
const telemetry = require('./telemetry');
const EventEmitter = require('events');
const { getEncoding } = require('js-tiktoken');

class LRUCache {
  constructor(maxSize = 10000) {
    this.cache = new Map();
    this.maxSize = maxSize;
  }

  get(key) {
    if (!this.cache.has(key)) return undefined;
    const val = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, val);
    return val;
  }

  set(key, value) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }
    this.cache.set(key, value);
    if (this.cache.size > this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
  }

  has(key) {
    return this.cache.has(key);
  }
}

const DEFAULT_TOKEN_BUDGET = 2048;
const DEFAULT_PREFER_SUMMARY_BELOW = 1024;
const DEFAULT_SUMMARY_LENGTH = 800;
const DEFAULT_CHUNK_LENGTH = 1200;
const DEFAULT_FALLBACK_SUMMARY_LENGTH = 300;
const DEFAULT_KEYWORD_COUNT = 10;
const DEFAULT_MEMORY_MESSAGES = 20;
const DEFAULT_CONCURRENCY_LIMIT = 5;
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_INITIAL_RETRY_DELAY = 500;
const DEFAULT_MAX_RETRY_DELAY = 4000;

let _tokenEncoder = null;
function getTokenEncoder() {
  if (!_tokenEncoder) _tokenEncoder = getEncoding('cl100k_base');
  return _tokenEncoder;
}

class VectraClient {
  constructor(config) {
    const parsed = RAGConfigSchema.parse(config);
    this.config = parsed;
    this.callbacks = config.callbacks || [];
    this.middlewares = config.middlewares || [];

    // Initialize telemetry
    telemetry.init(this.config);
    telemetry.track('sdk_initialized', {
      vector_store: this.config.database.type,
      embedding_provider: this.config.embedding.provider,
      llm_provider: this.config.llm.provider,
      observability_enabled: !!(this.config.observability && this.config.observability.enabled),
      memory_enabled: !!(this.config.memory && this.config.memory.enabled),
      session_type: this.config.sessionType
    });
    
    // Initialize observability
    this.logger = (this.config.observability && this.config.observability.enabled) 
      ? new SQLiteLogger(this.config.observability) 
      : null;

    // Initialize processor
    const agenticLlm = (this.config.chunking && this.config.chunking.agenticLlm)
        ? this.createLLM(this.config.chunking.agenticLlm)
        : null;
    this.processor = new DocumentProcessor(this.config.chunking, agenticLlm);

    // Initialize embedding backend
    this.embedder = this.createLLM(this.config.embedding);

    // Initialize generation LLM
    this.llm = this.createLLM(this.config.llm);
    this.retrievalLlm = (this.config.retrieval && this.config.retrieval.llmConfig)
        ? this.createLLM(this.config.retrieval.llmConfig)
        : this.llm;

    // Initialize vector store
    this.vectorStore = this.createVectorStore(this.config.database);
    this._embeddingCache = new LRUCache(this.config.maxCacheSize || 10000);
    this._metadataEnrichmentEnabled = !!(this.config.metadata && this.config.metadata.enrichment);
    const mm = this.config.memory?.maxMessages || DEFAULT_MEMORY_MESSAGES;
    if (this.config.memory && this.config.memory.enabled) {
      if (this.config.memory.type === 'in-memory') {
        this.history = new InMemoryHistory(mm);
      } else if (this.config.memory.type === 'redis') {
        const rc = this.config.memory.redis || {};
        this.history = new RedisHistory(rc.clientInstance, rc.keyPrefix || 'vectra:chat:', mm);
      } else if (this.config.memory.type === 'postgres') {
        const pc = this.config.memory.postgres || {};
        this.history = new PostgresHistory(pc.clientInstance, pc.tableName || 'ChatMessage', pc.columnMap || { sessionId: 'sessionId', role: 'role', content: 'content', createdAt: 'createdAt' }, mm);
      } else {
        this.history = null;
      }
    } else {
      this.history = null;
    }
    this._isTemporaryFile = (p) => {
      const name = path.basename(p);
      if (name.startsWith('~$')) return true;
      if (name.endsWith('.tmp') || name.endsWith('.temp')) return true;
      if (name.endsWith('.crdownload') || name.endsWith('.part')) return true;
      if (name.startsWith('.')) return true;
      return false;
    };

    if (this.config.reranking && this.config.reranking.enabled) {
        const rerankLlm = this.config.reranking.llmConfig 
            ? this.createLLM(this.config.reranking.llmConfig) 
            : this.llm;
        this.reranker = getReranker(this.config.reranking, rerankLlm);
    }
  }

  createLLM(llmConfig) {
    if (!llmConfig || !llmConfig.provider) throw new Error('LLM config missing provider');
    const p = llmConfig.provider;
    if (p === ProviderType.OPENAI) return new OpenAIBackend(llmConfig);
    if (p === ProviderType.GEMINI) return new GeminiBackend(llmConfig);
    if (p === ProviderType.ANTHROPIC) return new AnthropicBackend(llmConfig);
    if (p === ProviderType.OPENROUTER) return new OpenRouterBackend(llmConfig);
    if (p === ProviderType.HUGGINGFACE) return new HuggingFaceBackend(llmConfig);
    if (p === ProviderType.OLLAMA) return new OllamaBackend(llmConfig);
    throw new Error(`Unsupported provider: ${p}`);
  }

  createVectorStore(dbConfig) {
    if (!dbConfig || !dbConfig.type) throw new Error('Database config missing type');
    const t = dbConfig.type.toLowerCase();
    if (t === 'prisma') return new PrismaVectorStore(dbConfig);
    if (t === 'postgres') return new PostgresVectorStore(dbConfig);
    if (t === 'chroma') return new ChromaVectorStore(dbConfig);
    if (t === 'qdrant') return new QdrantVectorStore(dbConfig);
    if (t === 'milvus') return new MilvusVectorStore(dbConfig);
    throw new Error(`Unsupported vector store type: ${t}`);
  }

  trigger(event, ...args) {
    const cbs = this.callbacks || [];
    cbs.forEach(cb => {
        if (cb[event] && typeof cb[event] === 'function') cb[event](...args);
    });
  }

  async runMiddlewares(methodName, ...args) {
    if (!this.middlewares || this.middlewares.length === 0) {
      return args.length === 1 ? args[0] : args;
    }
    let currentArgs = args;
    for (const mw of this.middlewares) {
      if (typeof mw[methodName] === 'function') {
        const res = await mw[methodName](...currentArgs);
        if (currentArgs.length > 1) {
          currentArgs = Array.isArray(res) ? res : [res];
        } else {
          currentArgs = [res];
        }
      }
    }
    return currentArgs.length === 1 ? currentArgs[0] : currentArgs;
  }

  async _enrichChunkMetadata(chunks, concurrency = 5) {
    const results = new Array(chunks.length);
    let index = 0;
    
    const worker = async () => {
      while (index < chunks.length) {
        const i = index++;
        const c = chunks[i];
        try {
          const prompt = `Summarize and extract keywords and questions from the following text. Return STRICT JSON with keys: summary (string), keywords (array of strings), hypothetical_questions (array of strings).\nText:\n${c}`;
          const out = await this.llm.generate(prompt, 'You are a helpful assistant that returns valid JSON only.');
          const clean = String(out).replace(/```json/g, '').replace(/```/g, '').trim();
          const parsed = JSON.parse(clean);
          results[i] = {
            summary: typeof parsed.summary === 'string' ? parsed.summary : '',
            keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
            hypothetical_questions: Array.isArray(parsed.hypothetical_questions) ? parsed.hypothetical_questions : []
          };
        } catch (_) {
          const words = c.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 3);
          const freq = {};
          for (const w of words) freq[w] = (freq[w] || 0) + 1;
          const top = Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0,DEFAULT_KEYWORD_COUNT).map(([w])=>w);
          const summary = c.slice(0, DEFAULT_FALLBACK_SUMMARY_LENGTH);
          results[i] = { summary, keywords: top, hypothetical_questions: [] };
        }
      }
    };
    
    const workers = [];
    for (let i = 0; i < Math.min(concurrency, chunks.length); i++) {
      workers.push(worker());
    }
    await Promise.all(workers);
    return results;
  }

  async _batchEmbedChunks(toEmbed, mapIndex, hashes) {
    const newEmbeds = new Array(toEmbed.length);
    if (toEmbed.length > 0) {
      const enabled = !!(this.config.ingestion && this.config.ingestion.rateLimitEnabled);
      const defaultLimit = (this.config.ingestion && typeof this.config.ingestion.concurrencyLimit === 'number') ? this.config.ingestion.concurrencyLimit : DEFAULT_CONCURRENCY_LIMIT;
      const limit = enabled ? defaultLimit : toEmbed.length;
      let batchStart = 0;
      for (let i = 0; i < toEmbed.length; i += limit) {
        const batch = toEmbed.slice(i, i + limit);
        let attempt = 0; let delay = DEFAULT_INITIAL_RETRY_DELAY;
        while (true) {
          try {
            const out = await this.embedder.embedDocuments(batch);
            for (let j = 0; j < out.length; j++) {
              newEmbeds[batchStart + j] = out[j];
            }
            break;
          } catch (err) {
            attempt++;
            if (attempt >= DEFAULT_RETRY_ATTEMPTS) throw err;
            await new Promise(r => setTimeout(r, delay));
            delay = Math.min(DEFAULT_MAX_RETRY_DELAY, delay * 2);
          }
        }
        batchStart += limit;
      }
      newEmbeds.forEach((vec, j) => {
        const h = hashes[mapIndex[j]];
        this._embeddingCache.set(h, vec);
      });
    }
  }

  async _processDirectory(filePath, summary = { processed: 0, succeeded: 0, failed: 0, errors: [] }, isTopLevel = true) {
    const entries = await fs.promises.readdir(filePath, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(filePath, entry.name);
      if (this._isTemporaryFile(full)) continue;
      if (entry.isDirectory()) {
        await this._processDirectory(full, summary, false);
      } else {
        summary.processed++;
        try {
          await this.ingestDocuments(full);
          summary.succeeded++;
        } catch (err) {
          summary.failed++;
          summary.errors.push({ file: full, message: err?.message || String(err) });
          this.trigger('onError', err);
        }
      }
    }
    if (isTopLevel) {
      this.trigger('onIngestSummary', summary);
    }
  }

  async _validateFile(filePath, stats) {
    const absPath = path.resolve(filePath);
    const size = stats.size || 0;
    const configuredMax = this.config.ingestion && this.config.ingestion.maxFileSizeBytes;
    const maxSize = typeof configuredMax === 'number' ? configuredMax : 52428800;
    if (size > maxSize) {
      throw new Error(`File exceeds maximum allowed size: ${filePath} (${size} bytes > ${maxSize} bytes limit)`);
    }
    const mtime = Math.floor(stats.mtimeMs || Date.now());
    const md5 = crypto.createHash('md5');
    const sha = crypto.createHash('sha256');
    await new Promise((resolve, reject) => {
      const s = fs.createReadStream(filePath);
      s.on('data', (chunk) => { md5.update(chunk); sha.update(chunk); });
      s.on('error', reject);
      s.on('end', resolve);
    });
    const fileMD5 = md5.digest('hex');
    const fileSHA256 = sha.digest('hex');
    return { absolutePath: absPath, fileMD5, fileSHA256, fileSize: size, lastModified: mtime, timestamp: Date.now() };
  }

  async _prepareDocuments(filePath, rawText, chunks, embeddings, hashes, validation) {
    const metas = this.processor.computeChunkMetadata(filePath, rawText, chunks);
    const idNamespace = uuidv5('vectra-js', uuidv5.DNS);
    let documents = chunks.map((content, i) => ({
      id: uuidv5(`${validation.fileSHA256}:${i}`, idNamespace),
      content,
      embedding: embeddings[i],
      metadata: { 
        docId: uuidv5(`${validation.fileSHA256}:${i}`, idNamespace),
        source: filePath,
        absolutePath: validation.absolutePath,
        fileMD5: validation.fileMD5,
        fileSHA256: validation.fileSHA256,
        fileSize: validation.fileSize,
        lastModified: validation.lastModified,
        chunkIndex: i,
        sha256: hashes[i],
        fileType: metas[i]?.fileType,
        docTitle: metas[i]?.docTitle,
        pageFrom: metas[i]?.pageFrom,
        pageTo: metas[i]?.pageTo,
        section: metas[i]?.section
      }
    }));

    if (this._metadataEnrichmentEnabled) {
      const extra = await this._enrichChunkMetadata(chunks);
      documents = documents.map((d, i) => ({
        ...d,
        metadata: {
          ...d.metadata,
          summary: extra[i]?.summary,
          keywords: extra[i]?.keywords,
          hypothetical_questions: extra[i]?.hypothetical_questions,
        }
      }));
    }
    return documents;
  }

  async _storeDocuments(documents, mode, absPath) {
    if (this.vectorStore && typeof this.vectorStore.ensureIndexes === 'function') {
      try { await this.vectorStore.ensureIndexes(this.config.embedding?.dimensions); } catch (_) {}
    }
    
    if (mode === 'replace' && this.vectorStore && typeof this.vectorStore.deleteDocuments === 'function') {
      try {
        await this.vectorStore.deleteDocuments({ filter: { absolutePath: absPath } });
      } catch (_) {}
    }
    
    let attempt = 0; let delay = DEFAULT_INITIAL_RETRY_DELAY;
    while (true) {
      try {
        if (mode === 'replace' && this.vectorStore && typeof this.vectorStore.upsertDocuments === 'function') {
          await this.vectorStore.upsertDocuments(documents);
        } else {
          await this.vectorStore.addDocuments(documents);
        }
        break;
      } catch (err) {
        attempt++;
        if (attempt >= DEFAULT_RETRY_ATTEMPTS) throw err;
        await new Promise(r => setTimeout(r, delay));
        delay = Math.min(DEFAULT_MAX_RETRY_DELAY, delay * 2);
      }
    }
  }

  async ingestBatch(filePaths, ingestionMode = 'append') {
    const allFiles = [];
    const collectFiles = async (p) => {
      const stats = await fs.promises.stat(p);
      if (stats.isDirectory()) {
        const entries = await fs.promises.readdir(p, { withFileTypes: true });
        for (const entry of entries) {
          const full = path.join(p, entry.name);
          if (!this._isTemporaryFile(full)) {
            await collectFiles(full);
          }
        }
      } else {
        if (!this._isTemporaryFile(p)) {
          allFiles.push(p);
        }
      }
    };

    for (const p of filePaths) {
      await collectFiles(p);
    }

    if (allFiles.length === 0) return;

    const mode = ingestionMode || (this.config.ingestion && this.config.ingestion.mode) || 'append';
    const tStart = Date.now();
    this.trigger('onIngestStart', `batch of ${allFiles.length} files`);
    
    telemetry.track('ingest_batch_started', {
      file_count: allFiles.length,
      ingestion_mode: mode
    });

    const fileInfoList = [];
    let allChunks = [];
    let allHashes = [];

    for (const filePath of allFiles) {
      const stats = await fs.promises.stat(filePath);
      const validation = await this._validateFile(filePath, stats);
      
      let exists = false;
      if (mode === 'skip' && this.vectorStore && typeof this.vectorStore.fileExists === 'function') {
        try { exists = await this.vectorStore.fileExists(validation.fileSHA256, validation.fileSize, validation.lastModified); } catch { exists = false; }
      }
      
      if (exists) continue;

      let rawText = await this.processor.loadDocument(filePath);
      const chunkRes = await this.runMiddlewares('onBeforeChunk', rawText, this.config);
      rawText = Array.isArray(chunkRes) ? chunkRes[0] : chunkRes;
      const chunks = await this.processor.process(rawText);
      const hashes = chunks.map(c => crypto.createHash('sha256').update(c).digest('hex'));
      
      fileInfoList.push({
        path: filePath,
        rawText,
        chunks,
        hashes,
        validation,
        chunkRange: [allChunks.length, allChunks.length + chunks.length]
      });
      
      allChunks.push(...chunks);
      allHashes.push(...hashes);
    }

    if (allChunks.length === 0) {
      this.trigger('onIngestEnd', 'batch', 0, Date.now() - tStart);
      return;
    }

    // Batch Embedding
    const uniqueHashes = [...new Set(allHashes)];
    const uncachedHashes = uniqueHashes.filter(h => !this._embeddingCache.has(h));
    
    if (uncachedHashes.length > 0) {
      const hashToChunk = {};
      allHashes.forEach((h, i) => {
        if (uncachedHashes.includes(h)) hashToChunk[h] = allChunks[i];
      });
      
      const uncachedTexts = uncachedHashes.map(h => hashToChunk[h]);
      const enabled = !!(this.config.ingestion && this.config.ingestion.rateLimitEnabled);
      const defaultLimit = (this.config.ingestion && typeof this.config.ingestion.concurrencyLimit === 'number') ? this.config.ingestion.concurrencyLimit : DEFAULT_CONCURRENCY_LIMIT;
      const limit = enabled ? defaultLimit : uncachedTexts.length;
      
      for (let i = 0; i < uncachedTexts.length; i += limit) {
        let batch = uncachedTexts.slice(i, i + limit);
        const batchHashes = uncachedHashes.slice(i, i + limit);
        let attempt = 0; let delay = DEFAULT_INITIAL_RETRY_DELAY;
        while (true) {
          try {
            let out = await this.embedder.embedDocuments(batch);
            [batch, out] = await this.runMiddlewares('onAfterEmbed', batch, out);
            out.forEach((vec, j) => this._embeddingCache.set(batchHashes[j], vec));
            break;
          } catch (err) {
            attempt++;
            if (attempt >= DEFAULT_RETRY_ATTEMPTS) throw err;
            await new Promise(r => setTimeout(r, delay));
            delay = Math.min(DEFAULT_MAX_RETRY_DELAY, delay * 2);
          }
        }
      }
    }

    // Prepare Documents
    let documents = [];
    for (const info of fileInfoList) {
      const fileDocs = await this._prepareDocuments(
        info.path, 
        info.rawText, 
        info.chunks, 
        info.hashes.map(h => this._embeddingCache.get(h)), 
        info.hashes, 
        info.validation
      );
      documents.push(...fileDocs);
    }

    // Store
    const absPaths = [...new Set(fileInfoList.map(info => info.validation.absolutePath))];
    if (this.vectorStore && typeof this.vectorStore.ensureIndexes === 'function') {
      try { await this.vectorStore.ensureIndexes(this.config.embedding?.dimensions); } catch (_) {}
    }
    
    if (mode === 'replace' && this.vectorStore && typeof this.vectorStore.deleteDocuments === 'function') {
      for (const absPath of absPaths) {
        try { await this.vectorStore.deleteDocuments({ filter: { absolutePath: absPath } }); } catch (_) {}
      }
    }

    let attempt = 0; let delay = DEFAULT_INITIAL_RETRY_DELAY;
    while (true) {
      try {
        if (mode === 'replace' && this.vectorStore && typeof this.vectorStore.upsertDocuments === 'function') {
          await this.vectorStore.upsertDocuments(documents);
        } else {
          await this.vectorStore.addDocuments(documents);
        }
        break;
      } catch (err) {
        attempt++;
        if (attempt >= DEFAULT_RETRY_ATTEMPTS) throw err;
        await new Promise(r => setTimeout(r, delay));
        delay = Math.min(DEFAULT_MAX_RETRY_DELAY, delay * 2);
      }
    }

    const durationMs = Date.now() - tStart;
    this.trigger('onIngestEnd', 'batch', allChunks.length, durationMs);
    
    telemetry.track('ingest_batch_completed', {
      file_count: allFiles.length,
      chunk_count: allChunks.length,
      duration_ms: durationMs
    });
  }

  async ingestDocuments(filePath) {
    return this.ingestBatch([filePath]);
  }

  async listDocuments({ filter = null, limit = 100, cursor = null } = {}) {
    if (!this.vectorStore || typeof this.vectorStore.listDocuments !== 'function') {
      throw new Error('Vector store does not support listDocuments');
    }
    return this.vectorStore.listDocuments({ filter, limit, cursor });
  }

  async deleteDocuments({ ids = null, filter = null } = {}) {
    if (!this.vectorStore || typeof this.vectorStore.deleteDocuments !== 'function') {
      throw new Error('Vector store does not support deleteDocuments');
    }
    return this.vectorStore.deleteDocuments({ ids, filter });
  }

  async updateDocuments(documents) {
    if (!Array.isArray(documents) || documents.length === 0) return;
    const texts = documents.map(d => d.content);
    const embeddings = await this.embedder.embedDocuments(texts);
    const docs = documents.map((d, i) => ({
      id: d.id,
      content: d.content,
      embedding: embeddings[i],
      metadata: d.metadata || {}
    }));
    if (!this.vectorStore || typeof this.vectorStore.upsertDocuments !== 'function') {
      throw new Error('Vector store does not support updateDocuments');
    }
    return this.vectorStore.upsertDocuments(docs);
  }

  async generateHydeQuery(query) {
    const prompt = `Please write a plausible passage that answers the question: "${query}".`;
    return await this.retrievalLlm.generate(prompt);
  }

  async generateMultiQueries(query) {
    const prompt = `Generate 3 different versions of the user question to retrieve relevant documents. Return them separated by newlines.\nOriginal: ${query}`;
    const response = await this.retrievalLlm.generate(prompt);
    return response.split('\n').filter(line => line.trim().length > 0).slice(0, 3);
  }

  async generateHypotheticalQuestions(query) {
    const prompt = `Generate 3 hypothetical questions related to the query. Return a VALID JSON array of strings.\nQuery: ${query}`;
    const out = await this.retrievalLlm.generate(prompt);
    const clean = String(out).replace(/```json/g, '').replace(/```/g, '').trim();
    try { const arr = JSON.parse(clean); return Array.isArray(arr) ? arr.slice(0,3) : []; } catch { return []; }
  }

  tokenEstimate(text) {
    if (!text) return 0;
    return getTokenEncoder().encode(String(text)).length;
  }

  buildContextParts(docs, query) {
    const budget = (this.config.queryPlanning && this.config.queryPlanning.tokenBudget) ? this.config.queryPlanning.tokenBudget : DEFAULT_TOKEN_BUDGET;
    const preferSumm = (this.config.queryPlanning && this.config.queryPlanning.preferSummariesBelow) ? this.config.queryPlanning.preferSummariesBelow : DEFAULT_PREFER_SUMMARY_BELOW;
    const parts = [];
    const docMap = [];
    let used = 0;
    for (const d of docs) {
      const t = d.metadata?.docTitle || '';
      const sec = d.metadata?.section || '';
      const pages = (d.metadata?.pageFrom && d.metadata?.pageTo) ? `pages ${d.metadata.pageFrom}-${d.metadata.pageTo}` : '';
      const sum = d.metadata?.summary ? d.metadata.summary : d.content.slice(0, DEFAULT_SUMMARY_LENGTH);
      const chosen = (this.tokenEstimate(sum) <= preferSumm) ? sum : d.content.slice(0, DEFAULT_CHUNK_LENGTH);
      const part = `${t} ${sec} ${pages}\n${chosen}`;
      const est = this.tokenEstimate(part);
      if (used + est > budget) break;
      parts.push(part);
      docMap.push({
        source: d.metadata?.source || d.metadata?.absolutePath || '',
        pageFrom: d.metadata?.pageFrom || null,
        pageTo: d.metadata?.pageTo || null,
        section: d.metadata?.section || null,
        docTitle: d.metadata?.docTitle || null,
        _content: chosen
      });
      used += est;
    }
    return { parts, docMap };
  }

  _extractFirstSentence(text, maxLen = 250) {
    if (!text) return '';
    const m = text.match(/^(.*?[.!?])\s/s);
    const sent = m ? m[1] : text;
    return sent.length > maxLen ? sent.slice(0, maxLen) + '...' : sent;
  }

  parseCitations(answer, docMap) {
    const citations = [];
    const seen = new Set();
    const regex = /\[(\d+)\]/g;
    let match;
    while ((match = regex.exec(answer)) !== null) {
      const idx = parseInt(match[1], 10);
      if (seen.has(idx) || idx < 1 || idx > docMap.length) continue;
      seen.add(idx);
      const doc = docMap[idx - 1];
      citations.push({
        index: idx,
        source: doc.source || '',
        page: doc.pageFrom || null,
        section: doc.section || null,
        quote: this._extractFirstSentence(doc._content || '', 250)
      });
    }
    return citations;
  }

  async extractSnippets(docs, query, queryVector, maxSnippets) {
    const allSentences = [];
    for (const d of docs) {
      const sents = d.content.split(/(?<=[.!?])\s+/);
      for (const s of sents) {
        allSentences.push({ doc: d, text: s });
      }
    }
    if (allSentences.length === 0) return [];
    
    // Batch embed sentences for semantic evaluation
    const sentenceTexts = allSentences.map(s => s.text);
    const sentenceEmbeddings = await this.embedder.embedDocuments(sentenceTexts);
    
    const scored = sentenceEmbeddings.map((emb, i) => {
      // Compute cosine similarity with query vector
      const score = emb.reduce((acc, v, j) => acc + (v * queryVector[j]), 0);
      return { text: allSentences[i].text, doc: allSentences[i].doc, score };
    });
    
    scored.sort((a, b) => b.score - a.score);
    
    return scored.slice(0, maxSnippets).map(s => {
      const d = s.doc;
      const pages = (d.metadata?.pageFrom && d.metadata?.pageTo) ? `pages ${d.metadata.pageFrom}-${d.metadata.pageTo}` : '';
      return `${d.metadata?.docTitle || ''} ${d.metadata?.section || ''} ${pages}\n${s.text}`;
    });
  }

  reciprocalRankFusion(docLists, k = 60) {
      const scores = {};
      const contentMap = {};
      docLists.forEach(list => {
          list.forEach((doc, rank) => {
              if (!contentMap[doc.content]) contentMap[doc.content] = doc;
              if (!scores[doc.content]) scores[doc.content] = 0;
              scores[doc.content] += 1 / (k + rank + 1);
          });
      });
      return Object.keys(scores)
        .sort((a, b) => scores[b] - scores[a])
        .map(content => contentMap[content]);
  }

  mmrSelect(candidates, k, mmrLambda) {
    if (!Array.isArray(candidates) || candidates.length === 0) return [];
    const kInt = Math.max(1, Number(k) || 1);
    const lam = Math.max(0, Math.min(1, Number(mmrLambda) || 0.5));

    const tokens = (text) => {
      const t = String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
      return new Set(t.filter(x => x.length > 2));
    };

    const jaccard = (a, b) => {
      if (!a || !b || a.size === 0 || b.size === 0) return 0;
      let inter = 0;
      for (const x of a) if (b.has(x)) inter++;
      if (inter === 0) return 0;
      const union = a.size + b.size - inter;
      return union ? inter / union : 0;
    };

    const cosineSimilarity = (a, b) => {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
      let dot = 0, normA = 0, normB = 0;
      for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
      }
      if (normA === 0 || normB === 0) return 0;
      return dot / (Math.sqrt(normA) * Math.sqrt(normB));
    };

    const useEmbeddings = candidates.every(d => Array.isArray(d.embedding) && d.embedding.length > 0);

    const pool = candidates.map((d) => ({
      ...d,
      _tokens: useEmbeddings ? null : tokens(d.content),
      _rel: typeof d.score === 'number' ? d.score : Number(d.score) || 0,
    })).sort((a, b) => (b._rel || 0) - (a._rel || 0));

    const selected = [];
    const selectedDiversityKeys = [];

    const first = pool.shift();
    selected.push(first);
    selectedDiversityKeys.push(useEmbeddings ? first.embedding : first._tokens);

    while (pool.length > 0 && selected.length < kInt) {
      let bestIdx = -1;
      let bestScore = null;
      for (let i = 0; i < pool.length; i++) {
        const d = pool[i];
        let div = 0;
        for (const key of selectedDiversityKeys) {
          div = Math.max(div, useEmbeddings ? cosineSimilarity(d.embedding, key) : jaccard(d._tokens, key));
        }
        const score = lam * d._rel - (1 - lam) * div;
        if (bestScore === null || score > bestScore) {
          bestScore = score;
          bestIdx = i;
        }
      }
      if (bestIdx < 0) break;
      const picked = pool.splice(bestIdx, 1)[0];
      selected.push(picked);
      selectedDiversityKeys.push(useEmbeddings ? picked.embedding : picked._tokens);
    }

    return selected.slice(0, kInt).map(({ _tokens, _rel, ...rest }) => rest);
  }

  async queryRAG(query, filter = null, stream = false, sessionId = null) {
    checkGuardrails(query, this.config.guardrails);
    const traceId = uuidv4();
    const rootSpanId = uuidv4();
    const tStart = Date.now();
    
    if (sessionId) {
        this.logger?.updateSession(sessionId, null, { lastQuery: query });
    }

    const provider = this.config.llm.provider;
    const modelName = this.config.llm.modelName;
    const embeddingProvider = this.config.embedding.provider;
    const embeddingModelName = this.config.embedding.modelName;

    try {
        const tRetrieval = Date.now();
        this.trigger('onRetrievalStart', query);
        
        const strategy = this.config.retrieval.strategy;
        let docs = [];
        const k = (this.config.reranking && this.config.reranking.enabled) 
            ? this.config.reranking.windowSize : 5;
        
        let queryVector = await this.embedder.embedQuery(query);
        [query, queryVector] = await this.runMiddlewares('onBeforeRetrieve', query, queryVector);

        if (strategy === RetrievalStrategy.HYDE) {
            const hypotheticalDoc = await this.generateHydeQuery(query);
            const hydeVector = await this.embedder.embedQuery(hypotheticalDoc);
            // Weighted average: 70% HyDE, 30% original query
            const combinedVector = hydeVector.map((h, i) => 0.7 * h + 0.3 * queryVector[i]);
            docs = await this.vectorStore.similaritySearch(combinedVector, k, filter);
        } else if (strategy === RetrievalStrategy.MULTI_QUERY) {
            const queries = await this.generateMultiQueries(query);
            if (this.config.queryPlanning) {
              const hyps = await this.generateHypotheticalQuestions(query);
              queries.push(...hyps);
            }
            queries.push(query);
            const results = await Promise.all(queries.map(async (q) => {
                const vec = await this.embedder.embedQuery(q);
                return await this.vectorStore.similaritySearch(vec, k, filter);
            }));
            docs = this.reciprocalRankFusion(results, 1);
        } else if (strategy === RetrievalStrategy.HYBRID) {
            docs = await this.vectorStore.hybridSearch(query, queryVector, k, filter);
        } else if (strategy === RetrievalStrategy.MMR) {
            const fetchK = Math.max(Number(this.config.retrieval?.mmrFetchK) || 20, k);
            const lam = Number(this.config.retrieval?.mmrLambda) || 0.5;
            const candidates = await this.vectorStore.similaritySearch(queryVector, fetchK, filter);
            if (fetchK <= k) {
                // fetchK is clamped to be at least k, so fetchK <= k means fetchK === k:
                // similaritySearch already returned at most k candidates, so mmrSelect
                // would have nothing to select from beyond that. Skip the batch
                // embedDocuments call (pure waste, e.g. when reranking sets k to
                // windowSize) and the mmrSelect pass entirely.
                docs = candidates;
            } else {
                if (candidates.length > 0 && typeof this.embedder.embedDocuments === 'function') {
                    try {
                        const candidateEmbeddings = await this.embedder.embedDocuments(candidates.map(c => c.content));
                        candidates.forEach((c, i) => { c.embedding = candidateEmbeddings[i]; });
                    } catch (_) {
                        // Embedding-space MMR is best-effort; mmrSelect falls back to
                        // lexical Jaccard diversity when embeddings aren't present.
                    }
                }
                docs = this.mmrSelect(candidates, k, lam);
            }
        } else {
            docs = await this.vectorStore.similaritySearch(queryVector, k, filter);
        }
        
        if (this.config.reranking && this.config.reranking.enabled && this.reranker) {
            this.trigger('onRerankingStart', docs.length);
            docs = await this.reranker.rerank(query, docs);
            this.trigger('onRerankingEnd', docs.length);
        }

        const retrievalMs = Date.now() - tRetrieval;
        this.trigger('onRetrievalEnd', docs.length, retrievalMs);
        
        telemetry.track('query_executed', {
           query_mode: 'rag',
           retrieval_strategy: strategy,
           reranking_enabled: !!(this.config.reranking && this.config.reranking.enabled),
           streaming: stream,
           memory_used: !!(this.history && sessionId),
           result_count: docs.length
        });
        
        this.logger?.logTrace({
            traceId,
            spanId: uuidv4(),
            parentSpanId: rootSpanId,
            name: 'retrieval',
            startTime: tRetrieval,
            endTime: Date.now(),
            input: { query, filter, strategy },
            output: { documentsFound: docs.length },
            provider: embeddingProvider,
            modelName: embeddingModelName
        });

        // Keyword-boost re-sort: only safe to apply to the plain vector-similarity
        // retrieval path. Reranking (Cohere/Jina/LLM), hybrid search (RRF fusion),
        // multi-query (also RRF fusion, see reciprocalRankFusion above), and MMR
        // (greedy diversity selection) already produce an authoritative final order —
        // recomputing a sort from raw `score` here would silently discard that order,
        // and for stores like Milvus (where raw score can be an unnormalized,
        // lower-is-better distance) would actively invert it.
        // See final-review-fix-brief Critical #1/#2 and round-2 Issue A.
        const rerankingApplied = !!(this.config.reranking && this.config.reranking.enabled && this.reranker);
        const hybridApplied = strategy === RetrievalStrategy.HYBRID;
        const multiQueryApplied = strategy === RetrievalStrategy.MULTI_QUERY;
        const mmrApplied = strategy === RetrievalStrategy.MMR;
        if (!rerankingApplied && !hybridApplied && !multiQueryApplied && !mmrApplied) {
          const terms = query.toLowerCase().split(/\W+/).filter(t=>t.length>2);
          docs = docs.map(d => {
            const kws = Array.isArray(d.metadata?.keywords) ? d.metadata.keywords.map(k=>String(k).toLowerCase()) : [];
            const match = terms.reduce((acc,t)=>acc + (kws.includes(t)?1:0), 0);
            return { ...d, _boost: match };
          }).sort((a,b)=> ((b.score||0) + 0.1 * (b._boost||0)) - ((a.score||0) + 0.1 * (a._boost||0)));
        }

        const citationsEnabled = !!(this.config.generation && this.config.generation.structuredOutput === 'citations')
          && !(this.config.grounding && this.config.grounding.enabled && this.config.grounding.strict);

        const { parts: contextParts, docMap } = this.buildContextParts(docs, query);
        if (citationsEnabled) {
          contextParts.forEach((p, i) => { contextParts[i] = `[${i + 1}] ${p}`; });
        }
        if (this.config.grounding && this.config.grounding.enabled) {
          const maxSnippets = this.config.grounding.maxSnippets || 3;
          const snippets = await this.extractSnippets(docs, query, queryVector, maxSnippets);
          if (this.config.grounding.strict) {
            contextParts.splice(0, contextParts.length, ...snippets);
          } else {
            contextParts.push(...snippets);
          }
        }
        const context = contextParts.join('\n---\n');
        let historyText = '';
        if (this.history && sessionId) {
          const fn = this.history.getRecent?.bind(this.history);
          if (typeof fn === 'function') {
            const out = fn.length >= 2 ? fn(sessionId, this.config.memory?.maxMessages || 10) : fn(sessionId);
            const recent = out && typeof out.then === 'function' ? await out : out;
            historyText = Array.isArray(recent) ? recent.map(m => `${String(m.role).toUpperCase()}: ${m.content}`).join('\n') : '';
          }
        }
        let prompt;
        if (this.config.prompts && this.config.prompts.query) {
          prompt = this.config.prompts.query.replace(/\{\{context\}\}/g, context).replace(/\{\{question\}\}/g, query);
          if (historyText) prompt = `Conversation:\n${historyText}\n\n${prompt}`;
        } else {
          if (citationsEnabled) {
            prompt = `Answer the question using the provided context. Cite sources using inline markers like [1], [2], etc., matching the numbered context chunks. Every factual claim must have a citation.\nContext:\n${context}\n\n${historyText ? `Conversation:\n${historyText}\n\n` : ''}Question: ${query}`;
          } else {
            prompt = `Answer the question using the provided summaries and cite titles/sections/pages where relevant.\nContext:\n${context}\n\n${historyText ? `Conversation:\n${historyText}\n\n` : ''}Question: ${query}`;
          }
        }
        
        const tGen = Date.now();
        this.trigger('onGenerationStart', prompt);
        const systemInst = citationsEnabled
          ? "You are a helpful RAG assistant. When answering, cite sources using inline markers like [1], [2], etc., matching the numbered context chunks provided. Every factual claim must have a citation."
          : "You are a helpful RAG assistant.";
        
        if (stream) {
            // Streaming return
            if (!this.llm.generateStream) throw new Error("Streaming not implemented for this provider");
            
            this.logger?.logTrace({
                traceId,
                spanId: uuidv4(),
                parentSpanId: rootSpanId,
                name: 'generation_stream_start',
                startTime: tGen,
                endTime: Date.now(),
                input: { prompt },
                output: { stream: true },
                provider,
                modelName
            });

            const originalStream = await this.llm.generateStream(prompt, systemInst);
            const self = this;
            
            async function* wrappedStream() {
                let fullAnswer = '';
                try {
                    for await (const chunk of originalStream) {
                        const delta = (chunk && chunk.delta) ? chunk.delta : (typeof chunk === 'string' ? chunk : '');
                        fullAnswer += delta;
                        yield chunk;
                    }
                } catch (e) {
                    self.trigger('onError', e);
                     self.logger?.logTrace({
                        traceId,
                        spanId: rootSpanId,
                        name: 'queryRAG',
                        startTime: tStart,
                        endTime: Date.now(),
                        input: { query, sessionId },
                        error: { message: e.message, stack: e.stack },
                        status: 'error',
                        provider,
                        modelName
                      });
                    throw e;
                }

                // Stream finished successfully
                const genMs = Date.now() - tGen;
                self.trigger('onGenerationEnd', fullAnswer, genMs);

                const promptChars = prompt.length;
                const answerChars = fullAnswer.length;

                self.logger?.logTrace({
                    traceId,
                    spanId: uuidv4(),
                    parentSpanId: rootSpanId,
                    name: 'generation',
                    startTime: tGen,
                    endTime: Date.now(),
                    input: { prompt },
                    output: { answer: fullAnswer.substring(0, 1000) }, 
                    attributes: { prompt_chars: promptChars, completion_chars: answerChars },
                    provider,
                    modelName
                });

                self.logger?.logMetric({ name: 'prompt_chars', value: promptChars });
                self.logger?.logMetric({ name: 'completion_chars', value: answerChars });

                self.logger?.logTrace({
                    traceId,
                    spanId: rootSpanId,
                    name: 'queryRAG',
                    startTime: tStart,
                    endTime: Date.now(),
                    input: { query, sessionId },
                    output: { success: true },
                    attributes: { retrievalMs, genMs, docCount: docs.length },
                    provider,
                    modelName
                });
                
                self.logger?.logMetric({ name: 'query_latency', value: Date.now() - tStart, tags: { type: 'total' } });
                self.logger?.logMetric({ name: 'retrieval_latency', value: retrievalMs, tags: { type: 'retrieval' } });
                self.logger?.logMetric({ name: 'generation_latency', value: genMs, tags: { type: 'generation' } });

                if (citationsEnabled) {
                  yield { type: 'citations', citations: self.parseCitations(fullAnswer, docMap) };
                }
            }

            return wrappedStream();
        } else {
            let answer = await this.llm.generate(prompt, systemInst);
            let sources = docs.map(d => d.metadata);
            [answer, sources] = await this.runMiddlewares('onAfterGenerate', answer, sources);
            if (this.history && sessionId) {
              const add = this.history.addMessage?.bind(this.history);
              if (typeof add === 'function') {
                const r1 = add(sessionId, 'user', query);
                if (r1 && typeof r1.then === 'function') await r1;
                const r2 = add(sessionId, 'assistant', String(answer));
                if (r2 && typeof r2.then === 'function') await r2;
              }
            }
            const genMs = Date.now() - tGen;
            this.trigger('onGenerationEnd', answer, genMs);

            const promptChars = prompt.length;
            const answerChars = answer ? String(answer).length : 0;

            this.logger?.logTrace({
                traceId,
                spanId: uuidv4(),
                parentSpanId: rootSpanId,
                name: 'generation',
                startTime: tGen,
                endTime: Date.now(),
                input: { prompt },
                output: { answer: String(answer).substring(0, 1000) }, // Truncate for log
                attributes: { prompt_chars: promptChars, completion_chars: answerChars },
                provider,
                modelName
            });

            this.logger?.logMetric({ name: 'prompt_chars', value: promptChars });
            this.logger?.logMetric({ name: 'completion_chars', value: answerChars });

            this.logger?.logTrace({
                traceId,
                spanId: rootSpanId,
                name: 'queryRAG',
                startTime: tStart,
                endTime: Date.now(),
                input: { query, sessionId },
                output: { success: true },
                attributes: { retrievalMs, genMs, docCount: docs.length },
                provider,
                modelName
            });
            
            this.logger?.logMetric({ name: 'query_latency', value: Date.now() - tStart, tags: { type: 'total' } });
            this.logger?.logMetric({ name: 'retrieval_latency', value: retrievalMs, tags: { type: 'retrieval' } });
            this.logger?.logMetric({ name: 'generation_latency', value: genMs, tags: { type: 'generation' } });

            if (this.config.generation && this.config.generation.outputFormat === 'json') {
              try {
                const parsed = JSON.parse(String(answer));
                const result = { answer: parsed, sources: docs.map(d => d.metadata) };
                if (citationsEnabled) result.citations = this.parseCitations(String(answer), docMap);
                return result;
              } catch {
                const result = { answer, sources: docs.map(d => d.metadata) };
                if (citationsEnabled) result.citations = this.parseCitations(String(answer), docMap);
                return result;
              }
            }
            if (citationsEnabled) {
              const citations = this.parseCitations(String(answer), docMap);
              return { answer, citations, sources: docs.map(d => d.metadata) };
            }
            return { answer, sources: docs.map(d => d.metadata) };
        }
    } catch (e) {
      telemetry.track('error_occurred', {
        stage: 'retrieval_or_generation',
        error_type: e.name || 'unknown'
      });
      this.trigger('onError', e);
      this.logger?.logTrace({
        traceId,
        spanId: rootSpanId,
        name: 'queryRAG',
        startTime: tStart,
        endTime: Date.now(),
        input: { query, sessionId },
        error: { message: e.message, stack: e.stack },
        status: 'error',
        provider,
        modelName
      });
      throw e;
    }
  }

  async evaluate(testSet) {
    const bucket = testSet.length < 5 ? '1-5' : testSet.length < 20 ? '5-20' : '20+';
    telemetry.track('evaluation_run', {
      dataset_size_bucket: bucket
    });

    const report = [];
    for (const item of testSet) {
      const query = item.question;
      const groundTruth = item.expectedGroundTruth || '';
      const res = await this.queryRAG(query);
      const answer = typeof res.answer === 'string' ? res.answer : JSON.stringify(res.answer);
      const sources = Array.isArray(res.sources) ? res.sources : [];
      const context = sources.map((s, i) => `[Source ${i+1}] ${s.content || s.summary || ''}`).join('\n');

      // 1. Faithfulness
      const faithPrompt = `Given the context and the answer, determine if every claim in the answer is supported by the context.
Context: ${context}
Answer: ${answer}
Return JSON: {"claims": [{"claim": "...", "supported": true, "evidence": "..."}], "score": 0.0-1.0}`;

      // 2. Context Precision
      const precisionResults = [];
      for (const src of sources) {
        const chunk = src.content || src.summary || '';
        const precPrompt = `Query: ${query}\nChunk: ${chunk}\nIs this chunk relevant to the query? Return JSON: {"relevant": true}`;
        try {
          const pRes = await this.llm.generate(precPrompt, "Return valid JSON.");
          const pJson = JSON.parse(pRes.match(/\{.*\}/s)[0]);
          precisionResults.push(pJson.relevant ? 1.0 : 0.0);
        } catch { precisionResults.push(0.0); }
      }
      const contextPrecision = precisionResults.length > 0 ? precisionResults.reduce((a, b) => a + b, 0) / precisionResults.length : 0;

      // 3. Context Recall
      const recallPrompt = `Ground Truth: ${groundTruth}\nContext: ${context}\nDoes the context contain the facts needed for the ground truth? Return JSON: {"facts": [{"fact": "...", "present": true}], "score": 0.0-1.0}`;

      // 4. Answer Correctness
      const correctnessPrompt = `Question: ${query}\nGenerated Answer: ${answer}\nGround Truth: ${groundTruth}\nRate correctness (0-1). Return JSON: {"score": 0.0-1.0, "reason": "..."}`;

      const metrics = { faithfulness: 0, contextRecall: 0, answerCorrectness: 0 };
      const metricConfigs = [
        { key: 'faithfulness', prompt: faithPrompt },
        { key: 'contextRecall', prompt: recallPrompt },
        { key: 'answerCorrectness', prompt: correctnessPrompt }
      ];

      for (const m of metricConfigs) {
        try {
          const mRes = await this.llm.generate(m.prompt, "Return valid JSON.");
          const mJson = JSON.parse(mRes.match(/\{.*\}/s)[0]);
          metrics[m.key] = mJson.score || 0;
        } catch {}
      }

      report.push({
        question: query,
        expectedGroundTruth: groundTruth,
        answer: answer,
        metrics: {
          faithfulness: metrics.faithfulness,
          relevance: metrics.answerCorrectness,
          contextPrecision,
          contextRecall: metrics.contextRecall,
          answerCorrectness: metrics.answerCorrectness
        }
      });
    }
    return report;
  }
}

module.exports = { VectraClient, ProviderType };

