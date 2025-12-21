const OpenAI = require('openai');

class OpenRouterBackend {
  constructor(config) {
    this.config = config;
    const apiKey = config.apiKey || process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error('OpenRouter API Key missing. Set OPENROUTER_API_KEY.');
    this.client = new OpenAI({
      apiKey,
      baseURL: config.baseUrl || 'https://openrouter.ai/api/v1',
      defaultHeaders: config.defaultHeaders || {
        'HTTP-Referer': process.env.OPENROUTER_REFERER || '',
        'X-Title': process.env.OPENROUTER_TITLE || ''
      }
    });
  }

  async embedDocuments(texts) { throw new Error('OpenRouter does not support embeddings via this SDK.'); }
  async embedQuery(text) { throw new Error('OpenRouter does not support embeddings via this SDK.'); }

  async generate(prompt, sys) {
    const msgs = [];
    if (sys) msgs.push({ role: 'system', content: sys });
    msgs.push({ role: 'user', content: prompt });
    const res = await this.client.chat.completions.create({
      model: this.config.modelName,
      messages: msgs,
      temperature: this.config.temperature,
      max_tokens: this.config.maxTokens
    });
    return res.choices[0]?.message?.content || '';
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
      stream: true
    });
    for await (const chunk of stream) {
      const content = chunk.choices?.[0]?.delta?.content || '';
      if (content) yield { delta: content, finish_reason: null, usage: null };
    }
  }
}
module.exports = { OpenRouterBackend };
