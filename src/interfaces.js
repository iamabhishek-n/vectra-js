class VectorStore {
    async addDocuments(documents) { throw new Error("Method 'addDocuments' must be implemented."); }
    async similaritySearch(vector, limit = 5, filter = null) { throw new Error("Method 'similaritySearch' must be implemented."); }
    async hybridSearch(text, vector, limit = 5, filter = null) {
        // Default fallback
        return this.similaritySearch(vector, limit, filter);
    }
}
module.exports = { VectorStore };