import { v5 as uuidv5 } from "uuid";
import crypto from "crypto";

const NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8"; // DNS namespace

/**
 * Derive a stable UUID from the URL.
 */
function makeDocId(url) {
  return uuidv5(url, NAMESPACE);
}

/**
 * Compute MD5 hash of content for change detection.
 */
function contentHash(text) {
  return crypto.createHash("md5").update(text).digest("hex");
}

/**
 * Derive source name from base URL.
 * e.g. "https://react.dev" → "react.dev"
 */
function sourceName(url) {
  return new URL(url).hostname;
}

/**
 * Normalize a single crawled page into a Document.
 *
 * @param {{ url: string, title: string, markdown: string, fetchedAt: string }} page
 * @returns {Document}
 */
export function normalizeDocument({ url, title, markdown, fetchedAt }) {
  const source = sourceName(url);
  return {
    doc_id:       makeDocId(url),
    url,
    title:        title || url,
    content:      markdown,
    source,
    content_hash: contentHash(markdown),
    last_crawled: fetchedAt ?? new Date().toISOString(),
  };
}


/**
 * Normalize an array of pages.
 * Skips pages with empty content.
 */
export function normalizeAll(pages) {
  return pages
    .filter(p => p.markdown?.trim().length > 0)
    .map(normalizeDocument);
}