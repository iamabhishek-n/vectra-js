const { v4: uuidv4 } = require('uuid');
const { VectorStore } = require('../interfaces');

class ChromaVectorStore extends VectorStore {
    constructor(config) {
        super();
        this.client = config.clientInstance;
        this.collectionName = config.tableName || "rag_collection";
        this.collection = null;
    }

    async _init() {
        if (!this.client) {
            const { ChromaClient } = require('chromadb');
            this.client = new ChromaClient();
        }
        if (!this.collection) {
            this.collection = await this.client.getOrCreateCollection({ name: this.collectionName });
        }
    }

    _cleanMetadata(meta) {
        if (!meta) return {};
        const out = {};
        for (const [k, v] of Object.entries(meta)) {
            if (v !== undefined && v !== null) {
                out[k] = v;
            }
        }
        return out;
    }

    async addDocuments(docs) {
        await this._init();
        const ids = docs.map((d) => d.id || uuidv4());
        const embeddings = docs.map(d => d.embedding);
        const metadatas = docs.map(d => this._cleanMetadata(d.metadata));
        const documents = docs.map(d => d.content);

        console.log(`Adding ${docs.length} docs to Chroma collection: ${this.collectionName}`);
        try {
            await this.collection.add({
                ids,
                embeddings,
                metadatas,
                documents
            });
            console.log("Success adding docs to Chroma.");
        } catch (e) {
            console.error("Error in collection.add:", e);
            throw e;
        }
    }

    async upsertDocuments(docs) {
        await this._init();
        const ids = docs.map((d) => d.id || uuidv4());
        const embeddings = docs.map(d => d.embedding);
        const metadatas = docs.map(d => this._cleanMetadata(d.metadata));
        const documents = docs.map(d => d.content);
        if (typeof this.collection.upsert === 'function') {
            await this.collection.upsert({ ids, embeddings, metadatas, documents });
            return;
        }
        if (typeof this.collection.delete === 'function') {
            try { await this.collection.delete({ ids }); } catch (_) {}
        }
        await this.collection.add({ ids, embeddings, metadatas, documents });
    }
    
    async fileExists(sha256, size, lastModified) {
        await this._init();
        try {
            const res = await this.collection.get({ where: { fileSHA256: sha256, fileSize: size, lastModified } });
            return !!(res && Array.isArray(res.ids) && res.ids.length > 0);
        } catch (_) {
            return false;
        }
    }

    async similaritySearch(vector, limit = 5, filter = null) {
        await this._init();
        const results = await this.collection.query({
            queryEmbeddings: [vector],
            nResults: limit,
            where: filter || undefined
        });

        if (!results.documents || results.documents.length === 0) return [];

        const out = [];
        // Chroma returns array of arrays for batch queries
        for (let i = 0; i < results.documents[0].length; i++) {
            out.push({
                content: results.documents[0][i],
                metadata: results.metadatas[0][i],
                score: 1.0 - (results.distances ? results.distances[0][i] : 0)
            });
        }
        return out;
    }

    _lexicalOverlap(query, content) {
        const tokenize = (s) => new Set(String(s || '').toLowerCase().match(/[a-z0-9]+/g)?.filter(t => t.length > 2) || []);
        const queryTokens = tokenize(query);
        if (queryTokens.size === 0) return 0;
        const contentTokens = tokenize(content);
        let matches = 0;
        for (const t of queryTokens) if (contentTokens.has(t)) matches++;
        return matches / queryTokens.size;
    }

    async hybridSearch(text, vector, limit = 5, filter = null) {
        const pool = await this.similaritySearch(vector, Math.max(limit * 4, 20), filter);
        if (pool.length === 0) return [];
        const withLexical = pool.map(d => ({ ...d, _lexical: this._lexicalOverlap(text, d.content) }));
        const semanticRanked = [...withLexical].sort((a, b) => b.score - a.score);
        const lexicalRanked = [...withLexical].sort((a, b) => b._lexical - a._lexical);
        const rrfScores = new Map();
        const addRanks = (ranked) => {
            ranked.forEach((d, idx) => {
                const key = d.content;
                const prior = rrfScores.get(key) || 0;
                rrfScores.set(key, prior + 1 / (60 + idx + 1));
            });
        };
        addRanks(semanticRanked);
        addRanks(lexicalRanked);
        const seen = new Map();
        for (const d of withLexical) if (!seen.has(d.content)) seen.set(d.content, d);
        return Array.from(seen.values())
            .sort((a, b) => (rrfScores.get(b.content) || 0) - (rrfScores.get(a.content) || 0))
            .slice(0, limit)
            .map(({ _lexical, ...rest }) => rest);
    }

    async listDocuments({ filter = null, limit = 100, cursor = null } = {}) {
        await this._init();
        const lim = Math.max(1, Math.min(1000, Number(limit) || 100));
        const off = cursor ? Number(cursor) : 0;
        const res = await this.collection.get({
            where: filter || undefined,
            limit: lim,
            offset: off,
            include: ['documents', 'metadatas']
        });
        const ids = Array.isArray(res?.ids) ? res.ids : [];
        const documents = Array.isArray(res?.documents) ? res.documents : [];
        const metadatas = Array.isArray(res?.metadatas) ? res.metadatas : [];
        const docs = ids.map((id, i) => ({ id, content: documents[i], metadata: metadatas[i] }));
        const nextCursor = docs.length === lim ? String(off + docs.length) : null;
        return { documents: docs, nextCursor };
    }

    async deleteDocuments({ ids = null, filter = null } = {}) {
        await this._init();
        if (Array.isArray(ids) && ids.length > 0) {
            await this.collection.delete({ ids });
            return;
        }
        if (filter) {
            await this.collection.delete({ where: filter });
            return;
        }
        throw new Error('deleteDocuments requires ids or filter');
    }
}
module.exports = { ChromaVectorStore };
