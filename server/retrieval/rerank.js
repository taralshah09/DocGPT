// retrieval/rerank.js
// Optional second-stage reranking.
// Strategy: ask the LLM to score each candidate for relevance.
// Only runs when RERANK=true env var is set (adds ~1 LLM call latency).

import OpenAI from "openai";

const RERANK_MODEL = "gpt-4o-mini"; // fast + cheap for scoring

/**
 * Rerank search results using an LLM cross-encoder style prompt.
 * Returns the same results sorted by LLM-assigned relevance.
 *
 * @param {string}         query    User's original question
 * @param {SearchResult[]} results  Output of search()
 * @returns {Promise<SearchResult[]>}
 */
export async function rerank(query, results) {
  if (!results.length) return results;
  if (process.env.RERANK !== "true") return results; // disabled by default

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const prompt = `You are a relevance judge.
Score each passage from 0–10 for how well it answers the question.
Return ONLY a JSON array of numbers in the same order as the passages.

Question: ${query}

Passages:
${results.map((r, i) => `[${i}] ${r.content.slice(0, 300)}`).join("\n\n")}`;

  try {
    const res = await client.chat.completions.create({
      model: RERANK_MODEL,
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    });

    const raw = res.choices[0].message.content;
    const scores = JSON.parse(raw);          // e.g. [8, 3, 7, 9, 5]
    const arr = Array.isArray(scores) ? scores : Object.values(scores);

    return results
      .map((r, i) => ({ ...r, rerank_score: arr[i] ?? 0 }))
      .sort((a, b) => b.rerank_score - a.rerank_score);
  } catch (err) {
    console.warn("[rerank] Failed, returning original order:", err.message);
    return results;
  }
}