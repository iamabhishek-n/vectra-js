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
        this.config = config;
    }

    async rerank(query, documents) {
        if (!documents || documents.length === 0) return [];
        const docsToRank = documents.slice(0, this.config.windowSize);
        
        // Placeholder for specific providers (Cohere, Jina, etc.)
        if (this.config.provider === RerankingProvider.COHERE) {
            return this._mockApiRerank(query, docsToRank);
        }
        
        return documents.slice(0, this.config.topN);
    }

    async _mockApiRerank(query, docs) {
        return docs.slice(0, this.config.topN);
    }
}

function getReranker(config, llm) {
    if (config.provider === RerankingProvider.LLM) {
        return new LLMReranker(llm, config);
    }
    return new CrossEncoderReranker(config);
}

module.exports = { LLMReranker, CrossEncoderReranker, getReranker };