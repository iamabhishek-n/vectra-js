const fs = require('fs');
const path = require('path');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const xlsx = require('xlsx');
const { ChunkingStrategy } = require('./config');

class DocumentProcessor {
  constructor(config, agenticLlm) {
    this.config = config;
    this.agenticLlm = agenticLlm;
  }

  async loadDocument(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const buffer = await fs.promises.readFile(filePath);
    if (ext === '.pdf') return (await pdf(buffer)).text;
    if (ext === '.docx') return (await mammoth.extractRawText({ buffer })).value;
    if (['.txt','.md'].includes(ext)) return buffer.toString('utf-8');
    if (['.xlsx','.xls'].includes(ext)) {
        const wb = xlsx.read(buffer, { type: 'buffer' });
        return xlsx.utils.sheet_to_txt(wb.Sheets[wb.SheetNames[0]]);
    }
    throw new Error(`Unsupported file: ${ext}`);
  }

  async process(text) {
    return this.config.strategy === ChunkingStrategy.AGENTIC 
      ? this.agenticSplit(text) 
      : this.recursiveSplit(text);
  }

  recursiveSplit(text) {
    const chunks = [];
    let start = 0;
    const { chunkSize, chunkOverlap, separators } = this.config;
    while (start < text.length) {
      let end = start + chunkSize;
      if (end >= text.length) { chunks.push(text.slice(start)); break; }
      let splitIndex = -1;
      for (const sep of separators) {
        const idx = text.lastIndexOf(sep, end);
        if (idx > start && idx < end) { splitIndex = sep === '' ? end : idx + sep.length; break; }
      }
      if (splitIndex === -1) splitIndex = end;
      chunks.push(text.slice(start, splitIndex));
      start = splitIndex - chunkOverlap;
    }
    return chunks;
  }

  async agenticSplit(text) {
    if (!this.agenticLlm) throw new Error("Agentic LLM not configured.");
    const windows = this.recursiveSplit(text);
    const finalChunks = [];
    for (const window of windows) {
      const prompt = `Split this text into semantically complete propositions. Return a VALID JSON list of strings. Do not include Markdown formatting.\nText: "${window}"`;
      try {
        const response = await this.agenticLlm.generate(prompt);
        // Attempt to clean markdown
        const cleanJson = response.replace(/```json/g, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(cleanJson);
        if (Array.isArray(parsed)) finalChunks.push(...parsed);
        else finalChunks.push(window);
      } catch (e) { 
        // Fallback to window if parsing fails
        finalChunks.push(window); 
      }
    }
    return finalChunks;
  }
}
module.exports = { DocumentProcessor };