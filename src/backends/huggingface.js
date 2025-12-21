class HuggingFaceBackend {
  constructor(config) {
    this.config = config;
    this.apiKey = config.apiKey || process.env.HUGGINGFACE_API_KEY;
    if (!this.apiKey) throw new Error('HuggingFace API Key missing. Set HUGGINGFACE_API_KEY.');
    this.baseUrl = 'https://api-inference.huggingface.co/models';
  }

  async _post(model, payload) {
    const res = await fetch(`${this.baseUrl}/${encodeURIComponent(model)}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`HF error ${res.status}: ${t}`);
    }
    return await res.json();
  }

  async embedDocuments(texts) {
    const out = [];
    for (const text of texts) {
      const r = await this._post(this.config.modelName, { inputs: text, options: { wait_for_model: true } });
      const vec = Array.isArray(r) ? r.flat(2) : (r.embedding || r);
      out.push(vec);
    }
    return out;
  }

  async embedQuery(text) {
    const r = await this._post(this.config.modelName, { inputs: text, options: { wait_for_model: true } });
    const vec = Array.isArray(r) ? r.flat(2) : (r.embedding || r);
    return vec;
  }

  async generate(prompt, sys) {
    const inputs = sys ? `${sys}\n${prompt}` : prompt;
    const r = await this._post(this.config.modelName, { inputs, parameters: { temperature: this.config.temperature }, options: { wait_for_model: true } });
    if (Array.isArray(r) && r[0]?.generated_text) return r[0].generated_text;
    if (typeof r === 'string') return r;
    if (r?.generated_text) return r.generated_text;
    return String(r);
  }

  async *generateStream(prompt, sys) {
    const text = await this.generate(prompt, sys);
    yield { delta: text, finish_reason: null, usage: null };
  }
}
module.exports = { HuggingFaceBackend };
