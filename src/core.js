const fs = require('fs');
const path = require('path');
const { RAGConfigSchema, ProviderType, ChunkingStrategy, RetrievalStrategy } = require('./config');
const { DocumentProcessor } = require('./processor');
const { OpenAIBackend } = require('./backends/openai');
const { GeminiBackend } = require('./backends/gemini');
const { AnthropicBackend } = require('./backends/anthropic');
const { PrismaVectorStore } = require('./backends/prisma_store');
const { ChromaVectorStore } = require('./backends/chroma_store');
const { LLMReranker } = require('./reranker');

class RAGClient {
  constructor(config) {
    RAGConfigSchema.parse(config);
// ... existing constructor ...
    if (config.reranking && config.reranking.enabled) {
        const rerankLlm = config.reranking.llmConfig 
            ? this.createLLM(config.reranking.llmConfig) 
            : this.llm;
        this.reranker = new LLMReranker(rerankLlm, config.reranking);
    }
  }

// ... existing helper methods ...

  trigger(event, ...args) {
    this.callbacks.forEach(cb => {
        if (cb[event] && typeof cb[event] === 'function') cb[event](...args);
    });
  }

  async ingestDocuments(filePath) {
    try {
        const stats = await fs.promises.stat(filePath);
        if (stats.isDirectory()) {
            const files = await fs.promises.readdir(filePath);
            for (const file of files) {
                // Recursive call for each file/folder
                await this.ingestDocuments(path.join(filePath, file));
            }
            return;
        }

        this.trigger('onIngestStart', filePath);
        const rawText = await this.processor.loadDocument(filePath);
        
        this.trigger('onChunkingStart', this.config.chunking.strategy);
        const chunks = await this.processor.process(rawText);
        
        this.trigger('onEmbeddingStart', chunks.length);
        const embeddings = await this.embedder.embedDocuments(chunks);

        const documents = chunks.map((content, i) => ({
            content,
            embedding: embeddings[i],
            metadata: { source: filePath, chunkIndex: i }
        }));
        
        await this.vectorStore.addDocuments(documents);
        this.trigger('onIngestEnd', filePath, chunks.length);
    } catch (e) {
        this.trigger('onError', e);
        // If it's a specific file failure in a folder, we might want to suppress it, 
        // but here we throw to let the user decide. 
        // To be safe and consistent with Python, let's catch stats errors if path doesn't exist,
        // but generally bubbling up is fine for single files.
        // For folders, the recursive call awaits, so it will fail the whole batch if one fails.
        // Let's modify to be robust? No, keep simple for now. 
        // Actually, for folders, we probably want to continue.
        // But since this is a recursive function, handling "continue on error" is tricky 
        // without a separate flag.
        // I will stick to basic recursion.
        // Note: fs.stat might throw if file not found.
        throw e;
    }
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

  async queryRAG(query, filter = null, stream = false) {
    try {
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
            queries.push(query);
            const results = await Promise.all(queries.map(async (q) => {
                const vec = await this.embedder.embedQuery(q);
                return await this.vectorStore.similaritySearch(vec, k, filter);
            }));
            docs = this.reciprocalRankFusion(results, 1);
        } else if (strategy === RetrievalStrategy.HYBRID) {
            docs = await this.vectorStore.hybridSearch(query, queryVector, k, filter);
        } else {
            docs = await this.vectorStore.similaritySearch(queryVector, k, filter);
        }
        
        if (this.config.reranking && this.config.reranking.enabled && this.reranker) {
            this.trigger('onRerankingStart', docs.length);
            docs = await this.reranker.rerank(query, docs);
            this.trigger('onRerankingEnd', docs.length);
        }

        this.trigger('onRetrievalEnd', docs.length);
        const context = docs.map(d => d.content).join('\n---\n');
        const prompt = `Answer the question based on the context.\nContext:\n${context}\n\nQuestion: ${query}`;
        
        this.trigger('onGenerationStart', prompt);
        const systemInst = "You are a helpful RAG assistant.";
        
        if (stream) {
            // Streaming return
            if (!this.llm.generateStream) throw new Error("Streaming not implemented for this provider");
            return this.llm.generateStream(prompt, systemInst);
        } else {
            const answer = await this.llm.generate(prompt, systemInst);
            this.trigger('onGenerationEnd', answer);
            return { answer, sources: docs.map(d => d.metadata) };
        }
    } catch (e) {
        this.trigger('onError', e);
        throw e;
    }
  }
}

module.exports = { RAGClient };
