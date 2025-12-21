async function evaluateTestSet(client, testSet) {
  const report = [];
  for (const item of testSet) {
    const res = await client.queryRAG(item.question);
    const context = Array.isArray(res.sources) ? res.sources.map(s => s.summary || '').join('\n') : '';
    const faithPrompt = `Rate 0-1: Is the following Answer derived only from the Context?\nContext:\n${context}\n\nAnswer:\n${typeof res.answer === 'string' ? res.answer : JSON.stringify(res.answer)}`;
    const relevancePrompt = `Rate 0-1: Does the Answer correctly answer the Question?\nQuestion:\n${item.question}\n\nAnswer:\n${typeof res.answer === 'string' ? res.answer : JSON.stringify(res.answer)}`;
    let faith = 0; let rel = 0;
    try { faith = Math.max(0, Math.min(1, parseFloat(String(await client.llm.generate(faithPrompt, 'You return a single number between 0 and 1.'))))); } catch {}
    try { rel = Math.max(0, Math.min(1, parseFloat(String(await client.llm.generate(relevancePrompt, 'You return a single number between 0 and 1.'))))); } catch {}
    report.push({ question: item.question, expectedGroundTruth: item.expectedGroundTruth, faithfulness: faith, relevance: rel });
  }
  return report;
}
module.exports = { evaluateTestSet };
