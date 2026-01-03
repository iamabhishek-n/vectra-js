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
    this._lastPages = null;
  }

  async loadDocument(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const buffer = await fs.promises.readFile(filePath);
    if (ext === '.pdf') {
      let PDFParse = pdf.PDFParse;
      if (!PDFParse && pdf.default && pdf.default.PDFParse) {
        PDFParse = pdf.default.PDFParse;
      }

      if (PDFParse) {
        // Handle pdf-parse v2
        const parser = new PDFParse({ data: buffer });
        const info = await parser.getInfo();
        const total = info.total;
        const pages = [];
        let fullText = '';

        for (let i = 1; i <= total; i++) {
          const pageRes = await parser.getText({ partial: [i] });
          const pageText = pageRes.text || '';
          pages.push(pageText);
          fullText += pageText + '\n'; 
        }
        await parser.destroy();
        this._lastPages = pages;
        return fullText;
      }

      // Fallback for v1 (or if PDFParse class not found)
      let pdfFunc = pdf;
      if (typeof pdfFunc !== 'function' && pdfFunc.default) {
        pdfFunc = pdfFunc.default;
      }
      
      const pages = [];
      const res = await pdfFunc(buffer, {
        pagerender: pageData => pageData.getTextContent().then(tc => {
          const s = tc.items.map(it => it.str).join(' ');
          pages.push(s);
          return s;
        })
      });
      this._lastPages = pages;
      return res.text;
    }
    if (ext === '.docx') return (await mammoth.extractRawText({ buffer })).value;
    if (['.txt','.md'].includes(ext)) return buffer.toString('utf-8');
    if (['.xlsx','.xls'].includes(ext)) {
        const wb = xlsx.read(buffer, { type: 'buffer' });
        return xlsx.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]]);
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
    const sizeChars = Math.max(500, this.config.chunkSize || 1000);
    const baseOverlap = Math.max(0, this.config.chunkOverlap || 200);
    const sentences = text.split(/(?<=[.!?])\s+/);
    let current = '';
    for (const s of sentences) {
      const candidate = current.length ? current + ' ' + s : s;
      if (candidate.length >= sizeChars) {
        const entropy = this._entropy(candidate);
        const overlap = Math.min(baseOverlap + Math.floor(entropy * 50), Math.floor(sizeChars / 3));
        chunks.push(candidate);
        // create overlap window from end of candidate
        current = candidate.slice(Math.max(0, candidate.length - overlap));
      } else {
        current = candidate;
      }
    }
    if (current) chunks.push(current);
    return chunks;
  }

  _entropy(str) {
    const freq = {};
    for (const ch of str) freq[ch] = (freq[ch] || 0) + 1;
    const len = str.length;
    let H = 0;
    Object.values(freq).forEach(c => { const p = c / len; H += -p * Math.log2(p); });
    return H;
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
        if (Array.isArray(parsed)) {
          const dedup = new Set();
          for (const item of parsed) {
            if (typeof item === 'string') {
              const norm = item.trim().replace(/\s+/g, ' ');
              if (norm.length > 1 && !dedup.has(norm)) { dedup.add(norm); finalChunks.push(norm); }
            }
          }
        } else {
          finalChunks.push(window);
        }
      } catch (_) { 
        // Fallback to window if parsing fails
        finalChunks.push(window); 
      }
    }
    return finalChunks;
  }

  computeChunkMetadata(filePath, rawText, chunks) {
    const ext = path.extname(filePath).toLowerCase();
    const title = path.basename(filePath);
    const positions = [];
    let cursor = 0;
    for (const c of chunks) {
      const idx = rawText.indexOf(c, cursor);
      const start = idx >= 0 ? idx : 0;
      const end = start + c.length;
      positions.push({ start, end });
      cursor = end;
    }
    let pagesMeta = null;
    if (ext === '.pdf' && Array.isArray(this._lastPages)) {
      const lens = this._lastPages.map(p => p.length);
      const cum = [];
      let acc = 0;
      for (const l of lens) { acc += l; cum.push(acc); }
      pagesMeta = positions.map(pos => {
        const pf = cum.findIndex(x => x >= pos.start) + 1;
        const pt = cum.findIndex(x => x >= pos.end) + 1;
        return { pageFrom: pf || 1, pageTo: pt || pf || 1 };
      });
    }
    let sections = null;
    if (ext === '.md' || ext === '.txt') {
      const lines = rawText.split(/\n/);
      let offset = 0;
      const heads = [];
      for (const ln of lines) {
        if (/^#{1,6}\s+/.test(ln)) heads.push({ pos: offset, text: ln.replace(/^#{1,6}\s+/, '') });
        offset += ln.length + 1;
      }
      sections = positions.map(pos => {
        const candidates = heads.filter(h => h.pos <= pos.start);
        const h = candidates.length ? candidates[candidates.length - 1] : null;
        return h ? h.text : null;
      });
    }
    return positions.map((pos, i) => ({
      fileType: ext,
      docTitle: title,
      chunkIndex: i,
      pageFrom: pagesMeta ? pagesMeta[i].pageFrom : undefined,
      pageTo: pagesMeta ? pagesMeta[i].pageTo : undefined,
      section: sections ? sections[i] : undefined
    }));
  }
}
module.exports = { DocumentProcessor };
