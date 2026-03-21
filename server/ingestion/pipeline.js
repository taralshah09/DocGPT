import "dotenv/config";
import { discoverUrls } from "./crawler/index.js";
import { fetchUrl, sleep } from "./crawler/fetcher.js";
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

const MAX_PAGES = parseInt(process.env.MAX_PAGES ?? "200");
const CRAWL_DELAY = parseInt(process.env.CRAWL_DELAY_MS ?? "500");

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

export async function runIngestion({ seedUrls, onStatus } = {}) {
  const baseUrl = seedUrls?.length ? seedUrls[0] : DEFAULT_BASE_URL;
  const SOURCE = sourceFromUrl(baseUrl);

  const report = (msg) => {
    console.log(msg);
    if (onStatus) onStatus(msg);
  };

  report(`  RAG Ingestion Pipeline (Iterative) — ${SOURCE.name}`);

  await initDb();
  await ensureCollection();
  const actualId = await upsertSource(SOURCE);
  SOURCE.id = actualId;

  report(`[pipeline] Step 1: Discovering URLs for ${baseUrl}...`);
  const discovered = await discoverUrls(baseUrl, onStatus);
  const urls = [...new Set([...(seedUrls ?? []), ...discovered])].slice(0, MAX_PAGES);

  if (!urls.length) {
    report("[pipeline] No URLs discovered. Aborting.");
    return;
  }

  report(`[pipeline] Found ${urls.length} URLs. Starting iterative processing…`);
  report(`[pipeline] Strategy: Sequential process (Fetch → Store) to save memory.`);

  let successCount = 0;
  let skippedCount = 0;
  let errorCount = 0;
  let newChunksTotal = 0;

  const config = resolveConfig(baseUrl);

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const progress = `[${i + 1}/${urls.length}]`;

    try {
      const html = await fetchUrl(url, config.headers ?? {});
      const fetchedAt = new Date().toISOString();

      const { title, markdown } = extractMarkdown(html, url);

      if (markdown.trim().length < 100) {
        report(`${progress} Skipping ${url} (too little content)`);
        skippedCount++;
        continue;
      }

      const doc = normalizeDocument({ url, title, markdown, fetchedAt });

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
        report(`${progress} Unchanged: ${url}`);
        skippedCount++;
        continue;
      }

      report(`${progress} Processing: ${url} (${title})`);

      await deleteChunksByDocumentId(doc.doc_id);

      const chunks = chunkDocument({ ...doc, source_id: SOURCE.id });

      await embedChunks(chunks);

      await insertChunks(chunks);
      await upsertVectors(chunks);

      successCount++;
      newChunksTotal += chunks.length;

      // Force a small delay to let Event Loop and GC breathe
      await sleep(CRAWL_DELAY);

    } catch (err) {
      errorCount++;
      report(`${progress} Error processing ${url}: ${err.message}`);
    }
  }

  // Finalize
  clearIdx();
  const stats = await getStats();

  report("  Ingestion complete!");
  report(`  Processed: ${successCount} new/updated`);
  report(`  Skipped:   ${skippedCount} unchanged/tiny`);
  report(`  Failed:    ${errorCount} errors`);
  report(`  New Chunks: ${newChunksTotal}`);

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