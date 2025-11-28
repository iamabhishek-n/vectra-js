class LLMReranker {
    constructor(llm, config) {
        this.llm = llm;
        this.config = config;
    }

    async rerank(query, documents) {
        if (!documents || documents.length === 0) return [];
        const scored = await Promise.all(documents.map(async (doc) => {
            const score = await this.scoreDocument(query, doc.content);
            return { ...doc, score };
        }));
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, this.config.topN);
    }

    async scoreDocument(query, content) {
        const prompt = `Analyze relevance (0-10) of document to query. Return ONLY integer.\nQuery: "${query}"\nDoc: "${content.substring(0, 1000)}..."`;
        try {
            const res = await this.llm.generate(prompt);
            const match = res.match(/\d+/);
            return match ? parseInt(match[0], 10) : 0;
        } catch { return 0; }
    }
}
module.exports = { LLMReranker };