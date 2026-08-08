const { RerankingProvider } = require('./config');

class LLMReranker {
    constructor(llm, config) {
        this.llm = llm;
        this.config = config;
    }

    async rerank(query, documents) {
        if (!documents || documents.length === 0) return [];
        
        const docsToRank = documents.slice(0, this.config.windowSize);
        const docList = docsToRank.map((d, i) => `[${i + 1}] ${d.content.substring(0, 500)}`).join('\n');
        
        const prompt = `Identify the most relevant documents to the following query. 
Rank them from most relevant to least relevant by their IDs (e.g., [1], [2]).
Query: "${query}"

Documents:
${docList}

Return a VALID JSON array of indices (starting from 1) in order of relevance. 
Example result format: [3, 1, 2]`;

        try {
            const res = await this.llm.generate(prompt);
            const match = res.match(/\[[\d,\s]+\]/);
            if (match) {
                const indices = JSON.parse(match[0]);
                const ranked = [];
                for (const idx of indices) {
                    if (typeof idx === 'number' && idx >= 1 && idx <= docsToRank.length) {
                        ranked.push(docsToRank[idx - 1]);
                    }
                }
                
                // Fill in missing docs from the window
                const seen = new Set(ranked);
                for (const d of docsToRank) {
                    if (!seen.has(d)) ranked.push(d);
                }
                
                // Add docs outside the window
                return [...ranked, ...documents.slice(this.config.windowSize)].slice(0, this.config.topN);
            }
        } catch (e) {
            // Fallback to original order on error
        }
        
        return documents.slice(0, this.config.topN);
    }
}

class CrossEncoderReranker {
    constructor(config) {
        this.config = config || {};
    }

    async rerank(query, documents) {
        if (!documents || documents.length === 0) return [];
        try {
            if (this.config.provider === RerankingProvider.COHERE) {
                return await this._cohereRerank(query, documents);
            }
            if (this.config.provider === RerankingProvider.JINA) {
                return await this._jinaRerank(query, documents);
            }
            if (this.config.provider === RerankingProvider.CROSS_ENCODER) {
                throw new Error('RerankingProvider.CROSS_ENCODER (local model) is not implemented in vectra-js. Use RerankingProvider.COHERE, RerankingProvider.JINA, or RerankingProvider.LLM instead.');
            }
            return documents.slice(0, this.config.topN || documents.length);
        } catch (e) {
            if (this.config.provider === RerankingProvider.CROSS_ENCODER) throw e;
            return documents.slice(0, this.config.topN || documents.length);
        }
    }

    async _cohereRerank(query, documents) {
        const apiKey = this.config.apiKey || process.env.COHERE_API_KEY;
        if (!apiKey) {
            console.warn('Cohere rerank failed (missing API key), falling back to unranked results');
            return documents.slice(0, this.config.topN || documents.length);
        }
        try {
            const res = await fetch('https://api.cohere.com/v2/rerank', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
                body: JSON.stringify({
                    model: this.config.modelName || 'rerank-v3.5',
                    query,
                    documents: documents.map(d => d.content),
                    top_n: Math.min(this.config.topN || documents.length, documents.length),
                }),
                signal: AbortSignal.timeout(10000),
            });
            if (!res.ok) throw new Error(`Cohere rerank API error: ${res.status}`);
            const data = await res.json();
            return data.results.map(r => documents[r.index]);
        } catch (e) {
            console.warn(`Cohere rerank failed (${e.message}), falling back to unranked results`);
            return documents.slice(0, this.config.topN || documents.length);
        }
    }

    async _jinaRerank(query, documents) {
        const apiKey = this.config.apiKey || process.env.JINA_API_KEY;
        if (!apiKey) {
            console.warn('Jina rerank failed (missing API key), falling back to unranked results');
            return documents.slice(0, this.config.topN || documents.length);
        }
        try {
            const res = await fetch('https://api.jina.ai/v1/rerank', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
                body: JSON.stringify({
                    model: this.config.modelName || 'jina-reranker-v2-base-multilingual',
                    query,
                    documents: documents.map(d => d.content),
                    top_n: Math.min(this.config.topN || documents.length, documents.length),
                }),
                signal: AbortSignal.timeout(10000),
            });
            if (!res.ok) throw new Error(`Jina rerank API error: ${res.status}`);
            const data = await res.json();
            return data.results.map(r => documents[r.index]);
        } catch (e) {
            console.warn(`Jina rerank failed (${e.message}), falling back to unranked results`);
            return documents.slice(0, this.config.topN || documents.length);
        }
    }
}

function getReranker(config, llm) {
    if (config.provider === RerankingProvider.LLM) {
        return new LLMReranker(llm, config);
    }
    return new CrossEncoderReranker(config);
}

module.exports = { LLMReranker, CrossEncoderReranker, getReranker };