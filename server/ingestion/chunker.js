import { v4 as uuid } from "uuid";

const APPROX_CHARS_PER_TOKEN = 4;

export function estimateTokens(text) {
  return Math.ceil(text.length / APPROX_CHARS_PER_TOKEN);
}

const MIN_TOKENS = 50;   // discard tiny slivers
const MAX_TOKENS = 500;  // split sections larger than this
const TARGET_TOKENS = 350; // aim for ~350 tokens per chunk

const HEADING_RE = /^#{1,4}\s.+$/m;

/**
 * Split markdown text into sections at heading boundaries.
 * Each returned section includes its heading as the first line.
 * @param {string} md
 * @returns {string[]}
 */
function splitByHeadings(md) {
  // Find all heading positions
  const lines    = md.split("\n");
  const sections = [];
  let current    = [];

  for (const line of lines) {
    if (HEADING_RE.test(line) && current.length > 0) {
      sections.push(current.join("\n").trim());
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length) sections.push(current.join("\n").trim());

  return sections.filter(s => s.trim().length > 0);
}

/**
 * Split a long section into paragraph-level chunks.
 * Keeps a "header breadcrumb" on every sub-chunk for context.
 */
function splitByParagraphs(section, heading) {
  const paragraphs = section.split(/\n\n+/);
  const chunks     = [];
  let   buffer     = heading ? `${heading}\n\n` : "";

  for (const para of paragraphs) {
    const candidate = buffer + para + "\n\n";
    if (estimateTokens(candidate) > MAX_TOKENS && buffer.trim()) {
      chunks.push(buffer.trim());
      buffer = heading ? `${heading} (cont.)\n\n${para}\n\n` : `${para}\n\n`;
    } else {
      buffer = candidate;
    }
  }
  if (buffer.trim()) chunks.push(buffer.trim());
  return chunks;
}

/**
 * Last resort: split by raw character windows with 20% overlap.
 */
function slidingWindowSplit(text, heading) {
  const windowChars = TARGET_TOKENS * APPROX_CHARS_PER_TOKEN;
  const overlapChars = Math.floor(windowChars * 0.2);
  const prefix = heading ? `${heading}\n\n` : "";
  const chunks  = [];
  let   pos     = 0;

  while (pos < text.length) {
    const slice = text.slice(pos, pos + windowChars);
    chunks.push((prefix + slice).trim());
    pos += windowChars - overlapChars;
  }
  return chunks;
}

/**
 * Extract the first heading from a section, or null.
 */
function extractHeading(section) {
  const match = section.match(/^#{1,4}\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

/**
 * Chunk a single Document's content.
 *
 * @param {Object} doc  Normalized document
 * @returns {Array<{
 *   chunk_id: string,
 *   doc_id: string,
 *   content: string,
 *   heading: string|null,
 *   token_count: number,
 *   url: string,
 *   source: string,
 * }>}
 */
export function chunkDocument(doc) {
  const sections = splitByHeadings(doc.content);
  const rawChunks = [];

  for (const section of sections) {
    const tokens  = estimateTokens(section);
    const heading = extractHeading(section);

    if (tokens < MIN_TOKENS) {
      // too small — skip (or merge with next; keep simple for now)
      continue;
    } else if (tokens <= MAX_TOKENS) {
      rawChunks.push(section);
    } else {
      // too large — split further
      const sub = splitByParagraphs(section, heading ? `## ${heading}` : "");
      for (const s of sub) {
        if (estimateTokens(s) > MAX_TOKENS) {
          rawChunks.push(...slidingWindowSplit(s, heading ? `## ${heading}` : ""));
        } else {
          rawChunks.push(s);
        }
      }
    }
  }

  // Build chunk objects
  return rawChunks
    .filter(c => estimateTokens(c) >= MIN_TOKENS)
    .map((content, i) => ({
      chunk_id:    uuid(),
      doc_id:      doc.doc_id,
      source_id:   doc.source_id ?? null,   // ← propagate source UUID to Qdrant
      content:     content.trim(),
      heading:     extractHeading(content),
      token_count: estimateTokens(content),
      url:         doc.url,
      source:      doc.source,
    }));
}

/**
 * Chunk all documents.
 * @param {Object[]} docs
 * @returns {Object[]} flat array of chunks
 */
export function chunkAll(docs) {
  const allChunks = docs.flatMap(chunkDocument);
  console.log(`[chunker] ${docs.length} docs → ${allChunks.length} chunks`);
  return allChunks;
}