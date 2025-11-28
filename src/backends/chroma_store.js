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

    async addDocuments(docs) {
        await this._init();
        const ids = docs.map(() => uuidv4());
        const embeddings = docs.map(d => d.embedding);
        const metadatas = docs.map(d => d.metadata);
        const documents = docs.map(d => d.content);

        await this.collection.add({
            ids,
            embeddings,
            metadatas,
            documents
        });
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
}
module.exports = { ChromaVectorStore };