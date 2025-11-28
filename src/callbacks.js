class LoggingCallbackHandler {
  onIngestStart(filePath) { console.info(`[RAG] Starting ingestion: ${filePath}`); }
  onIngestEnd(file, count) { console.info(`[RAG] Finished ingestion. Chunks: ${count}`); }
  onChunkingStart(strategy) { console.debug(`[RAG] Chunking strategy: ${strategy}`); }
  onEmbeddingStart(count) { console.debug(`[RAG] Embedding ${count} chunks...`); }
  onRetrievalStart(query) { console.info(`[RAG] Querying: "${query}"`); }
  onRetrievalEnd(count) { console.info(`[RAG] Retrieved ${count} docs.`); }
  onRerankingStart(count) { console.debug(`[RAG] Reranking ${count} docs...`); }
  onRerankingEnd(count) { console.debug(`[RAG] Reranking finished. Keeping top ${count}.`); }
  onGenerationStart() { console.debug(`[RAG] Generating answer...`); }
  onGenerationEnd() { console.info(`[RAG] Answer generated.`); }
  onError(err) { console.error(`[RAG] Error: ${err.message}`); }
}
module.exports = { LoggingCallbackHandler };