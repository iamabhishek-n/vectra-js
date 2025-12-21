class OllamaBackend {
  constructor(config) {
    this.config = config;
    this.baseUrl = config.baseUrl || 'http://localhost:11434';
  }
  async embedDocuments(texts) {
    const out = [];
    for (const t of texts) {
      const res = await fetch(`${this.baseUrl}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.config.modelName, prompt: t })
      });
      const json = await res.json();
      out.push(json.embedding || json.data || []);
    }
    return out;
  }
  async embedQuery(text) {
    const res = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.config.modelName, prompt: text })
    });
    const json = await res.json();
    return json.embedding || json.data || [];
  }
  async generate(prompt, sys) {
    const res = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.config.modelName, prompt: sys ? `${sys}\n\n${prompt}` : prompt, stream: false })
    });
    const json = await res.json();
    return json.response || '';
  }
  async *generateStream(prompt, sys) {
    const res = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.config.modelName, prompt: sys ? `${sys}\n\n${prompt}` : prompt, stream: true })
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let done = false;
    while (!done) {
      const chunk = await reader.read();
      done = chunk.done;
      if (chunk.value) {
        const text = decoder.decode(chunk.value);
        const lines = text.split('\n').filter(l => l.trim().length > 0);
        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            const d = obj.response || '';
            if (d) yield { delta: d, finish_reason: obj.done ? 'stop' : null, usage: null };
          } catch {}
        }
      }
    }
  }
}
module.exports = { OllamaBackend };
