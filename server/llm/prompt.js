import OpenAI from "openai";

const LLM_MODEL = "llama-3.3-70b-versatile";
const MAX_CONTEXT = 3000;

function buildPrompt(question, chunks) {
  const contextParts = chunks.map((c, i) => {
    const header = c.heading ? `### ${c.heading}` : `### Passage ${i + 1}`;
    const source = `Source: ${c.url}`;
    return `${header}\n${source}\n\n${c.content}`;
  });

  let context = contextParts.join("\n\n---\n\n");
  if (context.length > MAX_CONTEXT * 4) {
    context = context.slice(0, MAX_CONTEXT * 4) + "\n\n[context truncated]";
  }

  const system = `You are a helpful documentation assistant for React.
Answer questions using ONLY the context provided below.
If the context does not contain enough information, say so honestly.
Always cite the relevant source URL when answering.
Be concise, accurate, and developer-friendly.`;

  const user = `Context:
${context}

---

Question: ${question}

Answer clearly and concisely. Include code examples if the context contains them.`;

  return { system, user };
}

export async function generateAnswer(question, chunks, { onToken } = {}) {
  if (!chunks.length) {
    return {
      answer: "I couldn't find relevant documentation to answer that question. Try rephrasing or ask about a specific React concept.",
      sources: [],
    };
  }

  const { system, user } = buildPrompt(question, chunks);
  const client = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1"
  });
  const sourcesMap = new Map();
  chunks.forEach(c => {
    if (c.url && !sourcesMap.has(c.url)) {
      sourcesMap.set(c.url, { url: c.url, title: c.title || c.url });
    }
  });
  const sources = Array.from(sourcesMap.values());

  if (onToken) {
    const stream = await client.chat.completions.create({
      model: LLM_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      stream: true,
    });

    let answer = "";
    for await (const chunk of stream) {
      const token = chunk.choices[0]?.delta?.content ?? "";
      answer += token;
      onToken(token);
    }
    return { answer, sources };
  } else {
    const res = await client.chat.completions.create({
      model: LLM_MODEL,
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    const answer = res.choices[0].message.content;
    return { answer, sources };
  }
}

import { search } from "../retrieval/search.js";
import { rerank } from "../retrieval/rerank.js";

export async function ask(question, opts = {}) {
  console.log("[ask] Question:", question, "| Opts:", { topK: opts.topK, source_id: opts.source_id, docId: opts.docId });

  const rawChunks = await search(question, {
    topK: (opts.topK ?? 5) * 2, // fetch extra for reranker
    threshold: opts.threshold ?? 0.60,
    source_id: opts.source_id,
    docId: opts.docId,
  });
  console.log("[ask] Raw search results:", rawChunks.length, rawChunks.map(c => ({ score: c.score, url: c.url })));

  const ranked = await rerank(question, rawChunks);
  const chunks = ranked.slice(0, opts.topK ?? 5);
  console.log("[ask] Chunks after rerank:", chunks.length);

  if (chunks.length === 0) {
    console.warn("[ask] No chunks found — LLM will respond with fallback message");
  }

  const { answer, sources } = await generateAnswer(question, chunks, {
    onToken: opts.onToken,
  });
  console.log("[ask] LLM answered. Sources:", sources);

  return { answer, sources, chunks };
}