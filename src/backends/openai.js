const OpenAI = require('openai');

class OpenAIBackend {
  constructor(config) {
    this.config = config;
    this.client = new OpenAI({ apiKey: config.apiKey || process.env.OPENAI_API_KEY });
  }

  async embedDocuments(texts) {
    const res = await this.client.embeddings.create({ model: this.config.modelName, input: texts, dimensions: this.config.dimensions });
    return res.data.map(d => d.embedding);
  }

  async embedQuery(text) {
    const res = await this.client.embeddings.create({ model: this.config.modelName, input: text, dimensions: this.config.dimensions });
    return res.data[0].embedding;
  }

  async generate(prompt, sys) {
    const msgs = [];
    if (sys) msgs.push({ role: 'system', content: sys });
    msgs.push({ role: 'user', content: prompt });
    const res = await this.client.chat.completions.create({ model: this.config.modelName, messages: msgs, temperature: this.config.temperature, max_tokens: this.config.maxTokens });
    return res.choices[0].message.content || "";
  }

  async *generateStream(prompt, sys) {
    const msgs = [];
    if (sys) msgs.push({ role: 'system', content: sys });
    msgs.push({ role: 'user', content: prompt });
    
    const stream = await this.client.chat.completions.create({
      model: this.config.modelName,
      messages: msgs,
      temperature: this.config.temperature,
      max_tokens: this.config.maxTokens,
      stream: true,
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || '';
      if (content) yield { delta: content, finish_reason: null, usage: null };
    }
  }
}
module.exports = { OpenAIBackend };
