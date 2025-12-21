const Anthropic = require('@anthropic-ai/sdk');

class AnthropicBackend {
  constructor(config) {
    this.config = config;
    this.client = new Anthropic({ apiKey: config.apiKey || process.env.ANTHROPIC_API_KEY });
  }

  async generate(prompt, sys) {
    const res = await this.client.messages.create({ 
        model: this.config.modelName, 
        max_tokens: this.config.maxTokens, 
        temperature: this.config.temperature, 
        system: sys, 
        messages: [{ role: 'user', content: prompt }] 
    });
    return res.content[0].text;
  }

  async *generateStream(prompt, sys) {
    const stream = await this.client.messages.create({
        model: this.config.modelName,
        max_tokens: this.config.maxTokens,
        temperature: this.config.temperature,
        system: sys,
        messages: [{ role: 'user', content: prompt }],
        stream: true
    });

    for await (const chunk of stream) {
        if (chunk.type === 'content_block_delta') {
            yield { delta: chunk.delta.text, finish_reason: null, usage: null };
        }
    }
  }
}
module.exports = { AnthropicBackend };
