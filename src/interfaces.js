class VectorStore {
    async addDocuments(documents) { throw new Error("Method 'addDocuments' must be implemented."); }
    async upsertDocuments(documents) {
        throw new Error("Method 'upsertDocuments' must be implemented.");
    }
    async similaritySearch(vector, limit = 5, filter = null) { throw new Error("Method 'similaritySearch' must be implemented."); }
    async hybridSearch(text, vector, limit = 5, filter = null) {
        // Default fallback
        return this.similaritySearch(vector, limit, filter);
    }
    async listDocuments({ filter = null, limit = 100, offset = 0 } = {}) {
        throw new Error("Method 'listDocuments' must be implemented.");
    }
    async deleteDocuments({ ids = null, filter = null } = {}) {
        throw new Error("Method 'deleteDocuments' must be implemented.");
    }
    async fileExists(sha256, size, lastModified) {
        return false;
    }
}
module.exports = { VectorStore };
