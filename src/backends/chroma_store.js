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

        await this.collection.add({
            ids,
            embeddings,
            metadatas,
            documents
        });
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

    async listDocuments({ filter = null, limit = 100, offset = 0 } = {}) {
        await this._init();
        const lim = Math.max(1, Math.min(1000, Number(limit) || 100));
        const off = Math.max(0, Number(offset) || 0);
        const res = await this.collection.get({
            where: filter || undefined,
            limit: lim,
            offset: off,
            include: ['documents', 'metadatas']
        });
        const ids = Array.isArray(res?.ids) ? res.ids : [];
        const documents = Array.isArray(res?.documents) ? res.documents : [];
        const metadatas = Array.isArray(res?.metadatas) ? res.metadatas : [];
        return ids.map((id, i) => ({ id, content: documents[i], metadata: metadatas[i] }));
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
