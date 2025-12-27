const fs = require('fs');
const path = require('path');
const { RAGConfigSchema, ProviderType, ChunkingStrategy, RetrievalStrategy } = require('./config');
const crypto = require('crypto');
const { DocumentProcessor } = require('./processor');
const { OpenAIBackend } = require('./backends/openai');
const { GeminiBackend } = require('./backends/gemini');
const { AnthropicBackend } = require('./backends/anthropic');
const { OpenRouterBackend } = require('./backends/openrouter');
const { HuggingFaceBackend } = require('./backends/huggingface');
const { PrismaVectorStore } = require('./backends/prisma_store');
const { ChromaVectorStore } = require('./backends/chroma_store');
const { QdrantVectorStore } = require('./backends/qdrant_store');
const { MilvusVectorStore } = require('./backends/milvus_store');
const { LLMReranker } = require('./reranker');
const { InMemoryHistory, RedisHistory, PostgresHistory } = require('./memory');
const { OllamaBackend } = require('./backends/ollama');
const { v5: uuidv5 } = require('uuid');
const { v4: uuidv4 } = require('uuid');
const SQLiteLogger = require('./observability');

class VectraClient {
  constructor(config) {
    const parsed = RAGConfigSchema.parse(config);
    this.config = parsed;
    this.callbacks = config.callbacks || [];
    
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
    this._embeddingCache = new Map();
    this._metadataEnrichmentEnabled = !!(this.config.metadata && this.config.metadata.enrichment);
    const mm = this.config.memory?.maxMessages || 20;
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
        this.reranker = new LLMReranker(rerankLlm, this.config.reranking);
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

  async _enrichChunkMetadata(chunks) {
    const enriched = [];
    for (const c of chunks) {
      try {
        const prompt = `Summarize and extract keywords and questions from the following text. Return STRICT JSON with keys: summary (string), keywords (array of strings), hypothetical_questions (array of strings).\nText:\n${c}`;
        const out = await this.llm.generate(prompt, 'You are a helpful assistant that returns valid JSON only.');
        const clean = String(out).replace(/```json/g, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(clean);
        const summary = typeof parsed.summary === 'string' ? parsed.summary : '';
        const keywords = Array.isArray(parsed.keywords) ? parsed.keywords : [];
        const hqs = Array.isArray(parsed.hypothetical_questions) ? parsed.hypothetical_questions : [];
        enriched.push({ summary, keywords, hypothetical_questions: hqs });
      } catch (_) {
        const words = c.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 3);
        const freq = {};
        for (const w of words) freq[w] = (freq[w] || 0) + 1;
        const top = Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([w])=>w);
        const summary = c.slice(0, 300);
        enriched.push({ summary, keywords: top, hypothetical_questions: [] });
      }
    }
    return enriched;
  }

  async ingestDocuments(filePath) {
    const traceId = uuidv4();
    const rootSpanId = uuidv4();
    const tStart = Date.now();
    const provider = this.config.embedding.provider;
    const modelName = this.config.embedding.modelName;
    
    try {
      const stats = await fs.promises.stat(filePath);

      if (stats.isDirectory()) {
        const files = await fs.promises.readdir(filePath);
        const summary = { processed: 0, succeeded: 0, failed: 0, errors: [] };
        for (const file of files) {
          const full = path.join(filePath, file);
          if (this._isTemporaryFile(full)) continue;
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
        this.trigger('onIngestSummary', summary);
        return;
      }

      const t0 = Date.now();
      this.trigger('onIngestStart', filePath);
      const absPath = path.resolve(filePath);
      const size = stats.size || 0;
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
      const validation = { absolutePath: absPath, fileMD5, fileSHA256, fileSize: size, lastModified: mtime, timestamp: Date.now() };
      this.trigger('onPreIngestionValidation', validation);
      const mode = (this.config.ingestion && this.config.ingestion.mode) ? this.config.ingestion.mode : 'skip';
      let exists = false;
      if (this.vectorStore && typeof this.vectorStore.fileExists === 'function') {
        try { exists = await this.vectorStore.fileExists(fileSHA256, size, mtime); } catch { exists = false; }
      }
      if (mode === 'skip' && exists) {
        this.trigger('onIngestSkipped', validation);
        return;
      }
      const rawText = await this.processor.loadDocument(filePath);

      this.trigger('onChunkingStart', this.config.chunking.strategy);
      const chunks = await this.processor.process(rawText);

      this.trigger('onEmbeddingStart', chunks.length);
      // Compute hashes and use cache for known chunks
      const hashes = chunks.map(c => crypto.createHash('sha256').update(c).digest('hex'));
      const toEmbed = [];
      const mapIndex = [];
      hashes.forEach((h, i) => {
        if (this._embeddingCache.has(h)) return;
        toEmbed.push(chunks[i]);
        mapIndex.push(i);
      });
      const newEmbeds = [];
      if (toEmbed.length > 0) {
        const enabled = !!(this.config.ingestion && this.config.ingestion.rateLimitEnabled);
        const defaultLimit = (this.config.ingestion && typeof this.config.ingestion.concurrencyLimit === 'number') ? this.config.ingestion.concurrencyLimit : 5;
        const limit = enabled ? defaultLimit : toEmbed.length;
        const batches = [];
        for (let i = 0; i < toEmbed.length; i += limit) batches.push(toEmbed.slice(i, i + limit));
        for (const batch of batches) {
          let attempt = 0; let delay = 500;
          while (true) {
            try {
              const out = await this.embedder.embedDocuments(batch);
              newEmbeds.push(...out);
              break;
            } catch (err) {
              attempt++;
              if (attempt >= 3) throw err;
              await new Promise(r => setTimeout(r, delay));
              delay = Math.min(4000, delay * 2);
            }
          }
        }
        newEmbeds.forEach((vec, j) => {
          const h = hashes[mapIndex[j]];
          this._embeddingCache.set(h, vec);
        });
      }
      const embeddings = hashes.map((h) => this._embeddingCache.get(h));

      const metas = this.processor.computeChunkMetadata(filePath, rawText, chunks);
      const idNamespace = uuidv5('vectra-js', uuidv5.DNS);
      let documents = chunks.map((content, i) => ({
        id: uuidv5(`${fileSHA256}:${i}`, idNamespace),
        content,
        embedding: embeddings[i],
        metadata: { 
          docId: uuidv5(`${fileSHA256}:${i}`, idNamespace),
          source: filePath,
          absolutePath: absPath,
          fileMD5,
          fileSHA256,
          fileSize: size,
          lastModified: mtime,
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

      if (this.vectorStore && typeof this.vectorStore.ensureIndexes === 'function') {
        try { await this.vectorStore.ensureIndexes(); } catch (_) {}
      }
      let existsServer = false;
      if (this.vectorStore && typeof this.vectorStore.fileExists === 'function') {
        try { existsServer = await this.vectorStore.fileExists(fileSHA256, size, mtime); } catch { existsServer = false; }
      }
      if (mode === 'skip' && existsServer) {
        this.trigger('onIngestSkipped', validation);
        return;
      }
      if (mode === 'replace' && this.vectorStore && typeof this.vectorStore.deleteDocuments === 'function') {
        try {
          await this.vectorStore.deleteDocuments({ filter: { absolutePath: absPath } });
        } catch (_) {}
      }
      let attempt = 0; let delay = 500;
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
          if (attempt >= 3) throw err;
          await new Promise(r => setTimeout(r, delay));
          delay = Math.min(4000, delay * 2);
        }
      }
      const durationMs = Date.now() - t0;
      this.trigger('onIngestEnd', filePath, chunks.length, durationMs);
      
      this.logger.logTrace({
        traceId,
        spanId: rootSpanId,
        name: 'ingestDocuments',
        startTime: tStart,
        endTime: Date.now(),
        input: { filePath },
        output: { chunks: chunks.length, durationMs },
        attributes: { fileSize: size },
        provider,
        modelName
      });
      this.logger.logMetric({ name: 'ingest_latency', value: durationMs, tags: { type: 'single_file' } });

    } catch (e) {
      this.trigger('onError', e);
      this.logger.logTrace({
        traceId,
        spanId: rootSpanId,
        name: 'ingestDocuments',
        startTime: tStart,
        endTime: Date.now(),
        input: { filePath },
        error: { message: e.message },
        status: 'error',
        provider,
        modelName
      });
      throw e;
    }
  }

  async listDocuments({ filter = null, limit = 100, offset = 0 } = {}) {
    if (!this.vectorStore || typeof this.vectorStore.listDocuments !== 'function') {
      throw new Error('Vector store does not support listDocuments');
    }
    return this.vectorStore.listDocuments({ filter, limit, offset });
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
    const len = text ? text.length : 0;
    return Math.ceil(len / 4);
  }

  buildContextParts(docs, query) {
    const budget = (this.config.queryPlanning && this.config.queryPlanning.tokenBudget) ? this.config.queryPlanning.tokenBudget : 2048;
    const preferSumm = (this.config.queryPlanning && this.config.queryPlanning.preferSummariesBelow) ? this.config.queryPlanning.preferSummariesBelow : 1024;
    const parts = [];
    let used = 0;
    for (const d of docs) {
      const t = d.metadata?.docTitle || '';
      const sec = d.metadata?.section || '';
      const pages = (d.metadata?.pageFrom && d.metadata?.pageTo) ? `pages ${d.metadata.pageFrom}-${d.metadata.pageTo}` : '';
      const sum = d.metadata?.summary ? d.metadata.summary : d.content.slice(0, 800);
      const chosen = (this.tokenEstimate(sum) <= preferSumm) ? sum : d.content.slice(0, 1200);
      const part = `${t} ${sec} ${pages}\n${chosen}`;
      const est = this.tokenEstimate(part);
      if (used + est > budget) break;
      parts.push(part);
      used += est;
    }
    return parts;
  }

  extractSnippets(docs, query, maxSnippets) {
    const terms = query.toLowerCase().split(/\W+/).filter(t=>t.length>2);
    const out = [];
    for (const d of docs) {
      const sents = d.content.split(/(?<=[.!?])\s+/);
      for (const s of sents) {
        const l = s.toLowerCase();
        const score = terms.reduce((acc,t)=> acc + (l.includes(t) ? 1 : 0), 0);
        if (score > 0) {
          const pages = (d.metadata?.pageFrom && d.metadata?.pageTo) ? `pages ${d.metadata.pageFrom}-${d.metadata.pageTo}` : '';
          out.push(`${d.metadata?.docTitle || ''} ${d.metadata?.section || ''} ${pages}\n${s}`);
          if (out.length >= maxSnippets) return out;
        }
      }
    }
    return out;
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

    const pool = candidates.map((d) => ({
      ...d,
      _tokens: tokens(d.content),
      _rel: typeof d.score === 'number' ? d.score : Number(d.score) || 0,
    })).sort((a, b) => (b._rel || 0) - (a._rel || 0));

    const selected = [];
    const selectedTokens = [];

    const first = pool.shift();
    selected.push(first);
    selectedTokens.push(first._tokens);

    while (pool.length > 0 && selected.length < kInt) {
      let bestIdx = -1;
      let bestScore = null;
      for (let i = 0; i < pool.length; i++) {
        const d = pool[i];
        let div = 0;
        for (const st of selectedTokens) div = Math.max(div, jaccard(d._tokens, st));
        const score = lam * d._rel - (1 - lam) * div;
        if (bestScore === null || score > bestScore) {
          bestScore = score;
          bestIdx = i;
        }
      }
      if (bestIdx < 0) break;
      const picked = pool.splice(bestIdx, 1)[0];
      selected.push(picked);
      selectedTokens.push(picked._tokens);
    }

    return selected.slice(0, kInt).map(({ _tokens, _rel, ...rest }) => rest);
  }

  async queryRAG(query, filter = null, stream = false, sessionId = null) {
    const traceId = uuidv4();
    const rootSpanId = uuidv4();
    const tStart = Date.now();
    
    if (sessionId) {
        this.logger.updateSession(sessionId, null, { lastQuery: query });
    }

    const provider = this.config.llm.provider;
    const modelName = this.config.llm.modelName;

    try {
        const tRetrieval = Date.now();
        this.trigger('onRetrievalStart', query);
        
        const strategy = this.config.retrieval.strategy;
        let docs = [];
        const k = (this.config.reranking && this.config.reranking.enabled) 
            ? this.config.reranking.windowSize : 5;
        
        const queryVector = await this.embedder.embedQuery(query);

        if (strategy === RetrievalStrategy.HYDE) {
            const hypotheticalDoc = await this.generateHydeQuery(query);
            const hydeVector = await this.embedder.embedQuery(hypotheticalDoc);
            docs = await this.vectorStore.similaritySearch(hydeVector, k, filter);
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
            docs = this.mmrSelect(candidates, k, lam);
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
        
        this.logger.logTrace({
            traceId,
            spanId: uuidv4(),
            parentSpanId: rootSpanId,
            name: 'retrieval',
            startTime: tRetrieval,
            endTime: Date.now(),
            input: { query, filter, strategy },
            output: { documentsFound: docs.length }
        });

        const terms = query.toLowerCase().split(/\W+/).filter(t=>t.length>2);
        docs = docs.map(d => {
          const kws = Array.isArray(d.metadata?.keywords) ? d.metadata.keywords.map(k=>String(k).toLowerCase()) : [];
          const match = terms.reduce((acc,t)=>acc + (kws.includes(t)?1:0), 0);
          return { ...d, _boost: match };
        }).sort((a,b)=> (b._boost||0) - (a._boost||0));

        const contextParts = this.buildContextParts(docs, query);
        if (this.config.grounding && this.config.grounding.enabled) {
          const maxSnippets = this.config.grounding.maxSnippets || 3;
          const snippets = this.extractSnippets(docs, query, maxSnippets);
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
          prompt = `Answer the question using the provided summaries and cite titles/sections/pages where relevant.\nContext:\n${context}\n\n${historyText ? `Conversation:\n${historyText}\n\n` : ''}Question: ${query}`;
        }
        
        const tGen = Date.now();
        this.trigger('onGenerationStart', prompt);
        const systemInst = "You are a helpful RAG assistant.";
        
        if (stream) {
            // Streaming return
            if (!this.llm.generateStream) throw new Error("Streaming not implemented for this provider");
            
            this.logger.logTrace({
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
                     self.logger.logTrace({
                        traceId,
                        spanId: rootSpanId,
                        name: 'queryRAG',
                        startTime: tStart,
                        endTime: Date.now(),
                        input: { query, sessionId },
                        error: { message: e.message, stack: e.stack },
                        status: 'error'
                      });
                    throw e;
                }

                // Stream finished successfully
                const genMs = Date.now() - tGen;
                self.trigger('onGenerationEnd', fullAnswer, genMs);

                const promptChars = prompt.length;
                const answerChars = fullAnswer.length;

                self.logger.logTrace({
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

                self.logger.logMetric({ name: 'prompt_chars', value: promptChars });
                self.logger.logMetric({ name: 'completion_chars', value: answerChars });

                self.logger.logTrace({
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
                
                self.logger.logMetric({ name: 'query_latency', value: Date.now() - tStart, tags: { type: 'total' } });
                self.logger.logMetric({ name: 'retrieval_latency', value: retrievalMs, tags: { type: 'retrieval' } });
                self.logger.logMetric({ name: 'generation_latency', value: genMs, tags: { type: 'generation' } });
            }

            return wrappedStream();
        } else {
            const answer = await this.llm.generate(prompt, systemInst);
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

            this.logger.logTrace({
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

            this.logger.logMetric({ name: 'prompt_chars', value: promptChars });
            this.logger.logMetric({ name: 'completion_chars', value: answerChars });

            this.logger.logTrace({
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
            
            this.logger.logMetric({ name: 'query_latency', value: Date.now() - tStart, tags: { type: 'total' } });
            this.logger.logMetric({ name: 'retrieval_latency', value: retrievalMs, tags: { type: 'retrieval' } });
            this.logger.logMetric({ name: 'generation_latency', value: genMs, tags: { type: 'generation' } });

            if (this.config.generation && this.config.generation.outputFormat === 'json') {
              try { const parsed = JSON.parse(String(answer)); return { answer: parsed, sources: docs.map(d => d.metadata) }; } catch { return { answer, sources: docs.map(d => d.metadata) }; }
            }
            return { answer, sources: docs.map(d => d.metadata) };
        }
    } catch (e) {
      this.trigger('onError', e);
      this.logger.logTrace({
        traceId,
        spanId: rootSpanId,
        name: 'queryRAG',
        startTime: tStart,
        endTime: Date.now(),
        input: { query, sessionId },
        error: { message: e.message, stack: e.stack },
        status: 'error'
      });
      throw e;
    }
  }

  async evaluate(testSet) {
    const report = [];
    for (const item of testSet) {
      const res = await this.queryRAG(item.question);
      const context = Array.isArray(res.sources) ? res.sources.map(s => s.summary || '').join('\n') : '';
      const faithPrompt = `Rate 0-1: Is the following Answer derived only from the Context?\nContext:\n${context}\n\nAnswer:\n${typeof res.answer === 'string' ? res.answer : JSON.stringify(res.answer)}`;
      const relevancePrompt = `Rate 0-1: Does the Answer correctly answer the Question?\nQuestion:\n${item.question}\n\nAnswer:\n${typeof res.answer === 'string' ? res.answer : JSON.stringify(res.answer)}`;
      let faith = 0; let rel = 0;
      try { faith = Math.max(0, Math.min(1, parseFloat(String(await this.llm.generate(faithPrompt, 'You return a single number between 0 and 1.'))))); } catch {}
      try { rel = Math.max(0, Math.min(1, parseFloat(String(await this.llm.generate(relevancePrompt, 'You return a single number between 0 and 1.'))))); } catch {}
      report.push({ question: item.question, expectedGroundTruth: item.expectedGroundTruth, faithfulness: faith, relevance: rel });
    }
    return report;
  }
}

module.exports = { VectraClient };
