import "dotenv/config";
import express from "express";
import { ask, generateSuggestions } from "../llm/prompt.js";
import { search } from "../retrieval/search.js";
import { runIngestion } from "../ingestion/pipeline.js";
import { getStats, getPool } from "../db/client.js";
import cors from "cors"


const app = express();
const PORT = process.env.PORT ?? 3001;
const FRONTEND_URL = process.env.FRONTEND_URL;
app.use(express.json());

app.use(cors({
  origin: ['http://localhost:5173', FRONTEND_URL],
  allowedHeaders: ['Content-Type', 'Authorization'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
}));

app.post("/query", async (req, res) => {
  const { question, topK = 5, stream = false, source_id, docId } = req.body;
  console.log("[/query] Received:", { question, topK, stream, source_id, docId });

  if (!question?.trim()) {
    console.warn("[/query] Missing question in request body");
    return res.status(400).json({ error: "question is required" });
  }

  try {
    if (stream) {
      console.log("[/query] Starting SSE stream...");
      // Server-Sent Events
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      const { sources, chunks } = await ask(question, {
        topK,
        source_id,
        docId,
        onToken: (token) => {
          res.write(`data: ${JSON.stringify({ token })}\n\n`);
        },
      });

      console.log("[/query] Stream complete. Sources:", sources, "Chunks:", chunks.length);
      res.write(`data: ${JSON.stringify({ done: true, sources, chunk_count: chunks.length })}\n\n`);
      res.end();
    } else {
      console.log("[/query] Non-streaming mode...");
      const { answer, sources, chunks } = await ask(question, { topK, source_id, docId });
      console.log("[/query] Answer ready. Chunks:", chunks.length, "Sources:", sources);
      res.json({
        question,
        answer,
        sources,
        chunk_count: chunks.length,
        chunks: chunks.map(c => ({
          heading: c.heading,
          url: c.url,
          score: c.score?.toFixed(3),
          preview: c.content.slice(0, 200) + "…",
        })),
      });
    }
  } catch (err) {
    console.error("[/query] ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /suggestions
 * Body: { question: string }
 */
app.post("/suggestions", async (req, res) => {
  const { question } = req.body;
  if (!question?.trim()) {
    return res.status(400).json({ error: "question is required" });
  }

  try {
    const suggestions = await generateSuggestions(question);
    res.json({ suggestions });
  } catch (err) {
    console.error("[/suggestions] ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /suggestions
 * Body: { question: string }
 */
app.post("/suggestions", async (req, res) => {
  const { question } = req.body;
  if (!question?.trim()) {
    return res.status(400).json({ error: "question is required" });
  }

  try {
    const suggestions = await generateSuggestions(question);
    res.json({ suggestions });
  } catch (err) {
    console.error("[/suggestions] ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/search", async (req, res) => {
  const { q, topK = 5, threshold = 0.65 } = req.query;
  if (!q) return res.status(400).json({ error: "q param required" });

  try {
    const results = await search(q, {
      topK: parseInt(topK),
      threshold: parseFloat(threshold),
    });
    res.json({ query: q, count: results.length, results });
  } catch (err) {
    console.error("[/search]", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/ingest", async (req, res) => {
  const { urls } = req.body ?? {};
  try {
    // Run async; respond immediately with 202
    res.status(202).json({ message: "Ingestion started" });
    await runIngestion({ seedUrls: urls });
  } catch (err) {
    console.error("[/ingest]", err);
  }
});

/**
 * GET /stats
 */
app.get("/stats", async (_req, res) => {
  try {
    res.json(await getStats());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/sources", async (_req, res) => {
  try {
    const pool = getPool();
    const result = await pool.query("SELECT id, name, base_url FROM sources ORDER BY name");
    res.json(result.rows);
  } catch (err) {
    console.error("[/sources]", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/documents", async (_req, res) => {
  try {
    const pool = getPool();
    const result = await pool.query(
      "SELECT id, title, url, source_id FROM documents ORDER BY title"
    );
    res.json(result.rows);
  } catch (err) {
    console.error("[/documents]", err); res.status(500).json({ error: err.message });
  }
});

/**
 * GET /health
 */
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`\n🚀 RAG API running at http://localhost:${PORT}`);
  console.log("   POST /query    — ask a question");
  console.log("   GET  /search   — raw semantic search");
  console.log("   POST /ingest   — trigger crawl+embed");
  console.log("   GET  /stats    — DB stats\n");
});

export default app;