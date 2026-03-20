# RAG App — react.dev Documentation Q&A

A production-ready Retrieval-Augmented Generation (RAG) pipeline that crawls,
indexes, and answers questions about React documentation.

## Architecture

```
react.dev
   │
   ▼
[Crawler]  → discovers URLs via sitemap, fetches HTML
   │
   ▼
[Extractor] → strips nav/footer/ads, converts HTML → Markdown
   │
   ▼
[Normalizer] → canonical Document shape + content_hash
   │
   ▼
[Chunker] → heading-based chunks (200–500 tokens each)
   │
   ▼
[Embedder] → OpenAI text-embedding-3-small (1536 dims)
   │
   ▼
[DB] ─────┬── SQLite (local dev)  ── JSON blob embeddings + cosine sim in JS
          └── PostgreSQL (prod)   ── pgvector ANN index

User Question
   │
   ▼
[Embed query] → same model
   │
   ▼
[Vector Search] → top-K chunks by cosine similarity
   │
   ▼
[Reranker] (optional) → LLM cross-encoder scoring
   │
   ▼
[LLM] → GPT-4o-mini with retrieved context
   │
   ▼
Answer + Sources
```

## Quick Start

### 1. Install

```bash
npm install
cp .env.example .env
# Edit .env and add your OPENAI_API_KEY
```

### 2. Run ingestion

```bash
# Crawl all of react.dev (first run takes a few minutes)
npm run ingest

# Or ingest a single URL to test
node ingestion/pipeline.js --url https://react.dev/reference/react/useRef
```

### 3. Start the API

```bash
npm start
# or for development with auto-reload:
npm run dev
```

### 4. Ask a question

```bash
# Simple query
curl -X POST http://localhost:3000/query \
  -H "Content-Type: application/json" \
  -d '{"question": "What is the difference between useRef and useState?"}'

# Streaming response
curl -X POST http://localhost:3000/query \
  -H "Content-Type: application/json" \
  -d '{"question": "How do I use useEffect?", "stream": true}'

# Raw semantic search (no LLM)
curl "http://localhost:3000/search?q=useCallback+memoization&topK=3"

# DB stats
curl http://localhost:3000/stats
```

## API Reference

| Method | Path      | Body / Params                              | Description                  |
|--------|-----------|--------------------------------------------|------------------------------|
| POST   | /query    | `{ question, topK?, stream? }`             | Q&A with LLM answer          |
| GET    | /search   | `?q=...&topK=5&threshold=0.65`             | Semantic search, raw chunks  |
| POST   | /ingest   | `{ urls?: string[] }`                      | Trigger ingestion (async)    |
| GET    | /stats    | —                                          | Document/chunk counts        |
| GET    | /health   | —                                          | Liveness check               |

## Configuration

| Env Var              | Default          | Description                        |
|----------------------|------------------|------------------------------------|
| `OPENAI_API_KEY`     | (required)       | OpenAI API key                     |
| `PORT`               | `3000`           | HTTP server port                   |
| `DB_PATH`            | `./data/rag.db`  | SQLite file path                   |
| `CRAWL_CONCURRENCY`  | `3`              | Parallel HTTP requests             |
| `CRAWL_DELAY_MS`     | `500`            | Delay between requests (ms)        |
| `MAX_PAGES`          | `200`            | Max URLs to crawl per run          |
| `RERANK`             | `false`          | Enable LLM reranker (adds latency) |
| `CRON_SCHEDULE`      | `0 2 * * *`      | Re-crawl schedule (cron syntax)    |

## Production Checklist

- [ ] Swap SQLite → PostgreSQL with pgvector (see `db/models.sql`)
- [ ] Enable `pgvector` extension and the IVFFlat index after bulk insert
- [ ] Set `RERANK=true` for higher-precision answers
- [ ] Add authentication to `/ingest` endpoint
- [ ] Deploy scheduler as a separate worker process
- [ ] Add more sources beyond react.dev (generalize `SOURCE` in `pipeline.js`)

## Project Structure

```
rag-app/
├── ingestion/
│   ├── crawler.js      Sitemap + BFS discovery; HTML fetcher
│   ├── extractor.js    HTML → clean Markdown (strips nav/footer/ads)
│   ├── normalizer.js   → canonical Document + content_hash
│   ├── chunker.js      Heading-based chunking (200–500 tokens)
│   └── pipeline.js     Orchestrator (run with: npm run ingest)
├── embeddings/
│   └── embedder.js     OpenAI text-embedding-3-small, batched + retry
├── db/
│   ├── models.sql      PostgreSQL + pgvector schema (production)
│   └── client.js       SQLite client (local dev; swap for pg in prod)
├── retrieval/
│   ├── search.js       Cosine similarity search over in-memory index
│   └── rerank.js       Optional LLM cross-encoder reranker
├── llm/
│   └── prompt.js       Prompt builder + GPT-4o-mini answer generation
├── api/
│   └── main.js         Express REST API
├── scheduler/
│   └── cron.js         Periodic re-crawl via node-cron
├── .env.example
└── package.json
```