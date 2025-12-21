class LoggingCallbackHandler {
  onIngestStart(filePath) { console.info(`[RAG] Starting ingestion: ${filePath}`); }
  onIngestEnd(file, count, durationMs) { console.info(`[RAG] Finished ingestion. Chunks: ${count} (${durationMs} ms)`); }
  onIngestSummary(summary) { console.info(`[RAG] Ingest summary: processed=${summary.processed}, ok=${summary.succeeded}, failed=${summary.failed}`); }
  onChunkingStart(strategy) { console.debug(`[RAG] Chunking strategy: ${strategy}`); }
  onEmbeddingStart(count) { console.debug(`[RAG] Embedding ${count} chunks...`); }
  onRetrievalStart(query) { console.info(`[RAG] Querying: "${query}"`); }
  onRetrievalEnd(count, durationMs) { console.info(`[RAG] Retrieved ${count} docs (${durationMs} ms).`); }
  onRerankingStart(count) { console.debug(`[RAG] Reranking ${count} docs...`); }
  onRerankingEnd(count) { console.debug(`[RAG] Reranking finished. Keeping top ${count}.`); }
  onGenerationStart() { console.debug(`[RAG] Generating answer...`); }
  onGenerationEnd(answer, durationMs) { console.info(`[RAG] Answer generated (${durationMs} ms).`); }
  onError(err) { console.error(`[RAG] Error: ${err.message || err}`); }
}

class StructuredLoggingCallbackHandler {
  constructor() { this.enabled = true; }
  onIngestStart(filePath) { console.log(JSON.stringify({ event: 'ingest_start', filePath })); }
  onIngestEnd(filePath, chunkCount, durationMs) { console.log(JSON.stringify({ event: 'ingest_end', filePath, chunkCount, durationMs })); }
  onIngestSummary(summary) { console.log(JSON.stringify({ event: 'ingest_summary', ...summary })); }
  onChunkingStart(strategy) { console.log(JSON.stringify({ event: 'chunking_start', strategy })); }
  onEmbeddingStart(count) { console.log(JSON.stringify({ event: 'embedding_start', count })); }
  onRetrievalStart(query) { console.log(JSON.stringify({ event: 'retrieval_start', query })); }
  onRetrievalEnd(count, durationMs) { console.log(JSON.stringify({ event: 'retrieval_end', count, durationMs })); }
  onRerankingStart(count) { console.log(JSON.stringify({ event: 'reranking_start', count })); }
  onRerankingEnd(count) { console.log(JSON.stringify({ event: 'reranking_end', count })); }
  onGenerationStart(promptPreview) { console.log(JSON.stringify({ event: 'generation_start', promptPreview: String(promptPreview).slice(0, 120) })); }
  onGenerationEnd(answerPreview, durationMs) { console.log(JSON.stringify({ event: 'generation_end', answerPreview: String(answerPreview).slice(0, 120), durationMs })); }
  onError(err) { console.log(JSON.stringify({ event: 'error', message: err?.message || String(err) })); }
}
module.exports = { LoggingCallbackHandler, StructuredLoggingCallbackHandler };
