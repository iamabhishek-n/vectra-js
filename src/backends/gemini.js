const { GoogleGenAI } = require('@google/genai');

class GeminiBackend {
  constructor(config) {
    this.config = config;
    const key = config.apiKey || process.env.GOOGLE_API_KEY || process.env.API_KEY;
    if (!key) throw new Error("Gemini API Key missing.");
    this.client = new GoogleGenAI({ apiKey: key });
  }

  async _retry(fn, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try { return await fn(); }
        catch (e) {
            if (i === retries - 1) throw e;
            await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i)));
        }
    }
  }

  async embedDocuments(texts) {
    const res = await this._retry(() => this.client.models.embedContent({
      model: this.config.modelName,
      contents: texts,
      config: { outputDimensionality: this.config.dimensions }
    }));
    const out = res?.embeddings || res?.data?.embeddings;
    if (!out || !Array.isArray(out)) throw new Error('Gemini embedding response missing embeddings');
    return out.map(e => e.values || e.embedding?.values || e);
  }
  async embedQuery(text) {
    const res = await this._retry(() => this.client.models.embedContent({
      model: this.config.modelName,
      contents: text,
      config: { outputDimensionality: this.config.dimensions }
    }));
    const out = res?.embeddings || res?.data?.embeddings;
    const values = Array.isArray(out) ? out[0]?.values : undefined;
    if (!values) throw new Error('Gemini embedding response missing values');
    return values;
  }
  
  async generate(prompt, sys) {
    const res = await this._retry(() => this.client.models.generateContent({
      model: this.config.modelName,
      contents: prompt,
      config: { systemInstruction: sys, temperature: this.config.temperature, maxOutputTokens: this.config.maxTokens }
    }));
    return res.text || "";
  }

  async *generateStream(prompt, sys) {
    const result = await this.client.models.generateContentStream({
      model: this.config.modelName,
      contents: prompt,
      config: {
        systemInstruction: sys,
        temperature: this.config.temperature,
        maxOutputTokens: this.config.maxTokens
      }
    });
    for await (const chunk of result) {
      const text = typeof chunk.text === 'function' ? chunk.text() : chunk.text;
      if (text) yield { delta: text, finish_reason: null, usage: null };
    }
  }
}
module.exports = { GeminiBackend };
