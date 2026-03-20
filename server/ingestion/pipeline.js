// ingestion/pipeline.js
// Orchestrates the full ingestion pipeline:
//   Crawl → Extract → Normalize → Chunk → Embed → Store
//
// Usage:
//   node ingestion/pipeline.js
//   node ingestion/pipeline.js --url https://nextjs.org/docs

import "dotenv/config";
import { discoverUrls, fetchPages } from "./crawler/index.js";
import { extractMarkdown } from "./extractor.js";
import { normalizeAll } from "./normalizer.js";
import { chunkAll } from "./chunker.js";
import { embedChunks } from "../embeddings/embedder.js";
import {
  initDb, upsertSource, upsertDocument,
  insertChunks, getStats
} from "../db/client.js";
import {
  ensureCollection, upsertVectors, deleteChunksByDocumentId
} from "../db/qdrant.js";
import { invalidateIndex as clearIdx } from "../retrieval/search.js";
import { v4 as uuid } from "uuid";

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Derive a human-readable source name and base_url from a URL string.
 * e.g. "https://nextjs.org/docs/app" → { name: "nextjs.org", base_url: "https://nextjs.org" }
 */
function sourceFromUrl(url) {
  try {
    const parsed = new URL(url);
    return {
      id: uuid(),
      name: parsed.hostname,         // e.g. "nextjs.org"
      base_url: parsed.origin,           // e.g. "https://nextjs.org"
    };
  } catch {
    return {
      id: uuid(),
      name: "unknown",
      base_url: url,
    };
  }
}

// ─── default source (react.dev) ───────────────────────────────────────────────

const DEFAULT_BASE_URL = "https://react.dev";

// ─── pipeline ─────────────────────────────────────────────────────────────────

/**
 * Run the full ingestion pipeline.
 * @param {object}   opts
 * @param {string[]} [opts.seedUrls]   If provided, sitemap discovery uses the
 *                                     first URL's domain. Any extra URLs are
 *                                     added to the discovered set.
 */
export async function runIngestion({ seedUrls } = {}) {
  // Determine which site we're ingesting
  const baseUrl = seedUrls?.length ? seedUrls[0] : DEFAULT_BASE_URL;
  const SOURCE = sourceFromUrl(baseUrl);

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  RAG Ingestion Pipeline  —  ${SOURCE.name}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  // 0. Init DB + source + Qdrant
  await initDb(); // triggers schema init from models.sql
  await ensureCollection(); // ensures Qdrant collection exists
  const actualId = await upsertSource(SOURCE);
  SOURCE.id = actualId; // ensure we use the ID from DB (could be new or existing)

  // 1. Discover URLs
  // Always run sitemap discovery from the base URL, then merge any explicit seed URLs
  console.log(`[pipeline] Target: ${baseUrl}`);
  const discovered = await discoverUrls(baseUrl);

  // Merge explicit seed URLs if caller passed them (deduplicate)
  const urls = [...new Set([...(seedUrls ?? []), ...discovered])].slice(
    0,
    parseInt(process.env.MAX_PAGES ?? "200")
  );

  if (!urls.length) {
    console.error("[pipeline] No URLs discovered. Aborting.");
    return;
  }

  console.log(`[pipeline] Total URLs to crawl: ${urls.length}`);

  // 2. Fetch HTML
  console.log(`\n[pipeline] STEP 1/5: Crawling ${urls.length} pages…`);
  const pages = await fetchPages(urls);

  // 3. Extract + normalize
  console.log("\n[pipeline] STEP 2/5: Extracting + normalizing…");
  const enriched = pages
    .map(p => {
      const { title, markdown } = extractMarkdown(p.html, p.url);
      return { ...p, title, markdown };
    })
    .filter(p => p.markdown.trim().length > 100); // drop near-empty pages

  const docs = normalizeAll(enriched);
  console.log(`[pipeline] Normalized ${docs.length} documents`);

  // 4. Store documents + detect changes
  console.log("\n[pipeline] STEP 3/5: Persisting documents…");
  let newDocs = 0;
  const changedDocs = [];

  for (const doc of docs) {
    const { changed } = await upsertDocument({
      id: doc.doc_id,
      source_id: SOURCE.id,
      url: doc.url,
      title: doc.title,
      content: doc.content,
      last_crawled: doc.last_crawled,
      content_hash: doc.content_hash,
    });
    if (changed) {
      // Clean up staleness in Qdrant too
      await deleteChunksByDocumentId(doc.doc_id);
      changedDocs.push(doc);
      newDocs++;
    }
  }
  console.log(`[pipeline] ${newDocs} new/changed docs (${docs.length - newDocs} unchanged — skipped)`);

  if (!changedDocs.length) {
    console.log("[pipeline] Nothing new to embed. Done.");
    return getStats();
  }

  // 5. Chunk — stamp source_id onto each doc so chunks inherit it for Qdrant filtering
  console.log("\n[pipeline] STEP 4/5: Chunking…");
  const docsWithSource = changedDocs.map(d => ({ ...d, source_id: SOURCE.id }));
  const chunks = chunkAll(docsWithSource);

  // 6. Embed
  console.log("\n[pipeline] STEP 5/5: Embedding…");
  await embedChunks(chunks);

  // 7. Store metadata (Postgres) and vectors (Qdrant)
  console.log("[pipeline] Storing metadata and vectors…");
  await insertChunks(chunks);
  await upsertVectors(chunks);

  // 8. Invalidate in-memory index
  clearIdx();

  // 9. Summary
  const stats = await getStats();
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  Ingestion complete!");
  console.log(`  Sources:   ${stats.sources}`);
  console.log(`  Documents: ${stats.documents}`);
  console.log(`  Chunks:    ${stats.chunks} (${stats.embedded} embedded)`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  return stats;
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

if (process.argv[1].endsWith("pipeline.js")) {
  const args = process.argv.slice(2);
  const urlFlag = args.findIndex(a => a === "--url");
  const seedUrls = urlFlag >= 0 ? [args[urlFlag + 1]] : [];

  runIngestion({ seedUrls }).catch(err => {
    console.error("[pipeline] Fatal error:", err);
    process.exit(1);
  });
}