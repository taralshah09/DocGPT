// ingestion/pipeline.js
// Orchestrates the full ingestion pipeline:
//   Crawl → Extract → Normalize → Chunk → Embed → Store
//
// Optimized for memory (sequential processing) to avoid OOM on 512MB RAM.

import "dotenv/config";
import { discoverUrls } from "./crawler/index.js";
import { fetchUrl, sleep } from "./fetcher.js";
import { extractMarkdown } from "./extractor.js";
import { normalizeDocument } from "./normalizer.js";
import { chunkDocument } from "./chunker.js";
import { embedChunks } from "../embeddings/embedder.js";
import { resolveConfig } from "./crawler/site-configs.js";
import {
  initDb, upsertSource, upsertDocument,
  insertChunks, getStats
} from "../db/client.js";
import {
  ensureCollection, upsertVectors, deleteChunksByDocumentId
} from "../db/qdrant.js";
import { invalidateIndex as clearIdx } from "../retrieval/search.js";
import { v4 as uuid } from "uuid";

// ─── config ───────────────────────────────────────────────────────────────────

const MAX_PAGES = parseInt(process.env.MAX_PAGES ?? "200");
const CRAWL_DELAY = parseInt(process.env.CRAWL_DELAY_MS ?? "500");

// ─── helpers ──────────────────────────────────────────────────────────────────

function sourceFromUrl(url) {
  try {
    const parsed = new URL(url);
    return {
      id: uuid(),
      name: parsed.hostname,
      base_url: parsed.origin,
    };
  } catch {
    return {
      id: uuid(),
      name: "unknown",
      base_url: url,
    };
  }
}

const DEFAULT_BASE_URL = "https://react.dev";

// ─── pipeline ─────────────────────────────────────────────────────────────────

export async function runIngestion({ seedUrls } = {}) {
  const baseUrl = seedUrls?.length ? seedUrls[0] : DEFAULT_BASE_URL;
  const SOURCE = sourceFromUrl(baseUrl);

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  RAG Ingestion Pipeline (Iterative) — ${SOURCE.name}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  await initDb();
  await ensureCollection();
  const actualId = await upsertSource(SOURCE);
  SOURCE.id = actualId;

  console.log(`[pipeline] Step 1: Discovering URLs for ${baseUrl}...`);
  const discovered = await discoverUrls(baseUrl);
  const urls = [...new Set([...(seedUrls ?? []), ...discovered])].slice(0, MAX_PAGES);

  if (!urls.length) {
    console.error("[pipeline] No URLs discovered. Aborting.");
    return;
  }

  console.log(`[pipeline] Found ${urls.length} URLs. Starting iterative processing…`);
  console.log(`[pipeline] Strategy: Sequential process (Fetch → Store) to save memory.`);

  let successCount = 0;
  let skippedCount = 0;
  let errorCount = 0;
  let newChunksTotal = 0;

  // We resolve the site config once for headers
  const config = resolveConfig(baseUrl);

  // Use a simple loop ("linked list" style traversal) to process one URL at a time
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const progress = `[${i + 1}/${urls.length}]`;
    
    try {
      // 1. Fetch
      const html = await fetchUrl(url, config.headers ?? {});
      const fetchedAt = new Date().toISOString();

      // 2. Extract
      const { title, markdown } = extractMarkdown(html, url);
      
      if (markdown.trim().length < 100) {
        console.log(`${progress} Skipping ${url} (too little content)`);
        skippedCount++;
        continue;
      }

      // 3. Normalize
      const doc = normalizeDocument({ url, title, markdown, fetchedAt });

      // 4. Upsert & Check for changes
      const { changed } = await upsertDocument({
        id: doc.doc_id,
        source_id: SOURCE.id,
        url: doc.url,
        title: doc.title,
        content: doc.content,
        last_crawled: doc.last_crawled,
        content_hash: doc.content_hash,
      });

      if (!changed) {
        console.log(`${progress} Unchanged: ${url}`);
        skippedCount++;
        continue;
      }

      console.log(`${progress} Processing: ${url} (${title})`);

      // 5. Clean up old state if it changed
      await deleteChunksByDocumentId(doc.doc_id);

      // 6. Chunk
      const chunks = chunkDocument({ ...doc, source_id: SOURCE.id });
      
      // 7. Embed (in batches, but limited to this docs chunks)
      await embedChunks(chunks);

      // 8. Store
      await insertChunks(chunks);
      await upsertVectors(chunks);

      successCount++;
      newChunksTotal += chunks.length;

      // Force a small delay to let Event Loop and GC breathe
      await sleep(CRAWL_DELAY);

    } catch (err) {
      errorCount++;
      console.warn(`${progress} Error processing ${url}: ${err.message}`);
    }
  }

  // Finalize
  clearIdx();
  const stats = await getStats();

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  Ingestion complete!");
  console.log(`  Processed: ${successCount} new/updated`);
  console.log(`  Skipped:   ${skippedCount} unchanged/tiny`);
  console.log(`  Failed:    ${errorCount} errors`);
  console.log(`  New Chunks: ${newChunksTotal}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  return stats;
}

if (process.argv[1].endsWith("pipeline.js")) {
  const args = process.argv.slice(2);
  const urlFlag = args.findIndex(a => a === "--url");
  const seedUrls = urlFlag >= 0 ? [args[urlFlag + 1]] : [];

  runIngestion({ seedUrls }).catch(err => {
    console.error("[pipeline] Fatal error:", err);
    process.exit(1);
  });
}