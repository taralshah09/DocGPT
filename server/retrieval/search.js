// retrieval/search.js
// Semantic similarity search over stored chunk embeddings using pgvector.

import { searchVectors } from "../db/qdrant.js";
import { embedText } from "../embeddings/embedder.js";

/**
 * Semantic search: embed the query then find the most similar chunks via pgvector.
 *
 * @param {string}  query
 * @param {Object}  opts
 * @param {number}  opts.topK          – number of results to return (default 5)
 * @param {number}  opts.threshold     – minimum similarity score (default 0.7)
 * @param {string}  [opts.source]      – filter by source hostname
 * @returns {Promise<SearchResult[]>}
 */
export async function search(query, { topK = 5, threshold = 0.7, source, source_id, docId } = {}) {
  console.log("[search] Query:", query, "| topK:", topK, "| threshold:", threshold, "| source_id:", source_id, "| docId:", docId);

  const queryVec = await embedText(query);
  console.log("[search] Embedding generated, length:", queryVec?.length);

  const hits = await searchVectors(queryVec, { topK, threshold, source_id: source_id ?? source, docId });
  console.log("[search] Qdrant hits:", hits.length, hits.map(h => ({ chunk_id: h.chunk_id, score: h.score })));

  // Hydrate from Postgres
  const { getChunksByIds } = await import("../db/client.js");
  const chunkIds = hits.map(h => h.chunk_id);
  console.log("[search] Hydrating chunk IDs:", chunkIds);

  const hydrated = await getChunksByIds(chunkIds);
  console.log("[search] Hydrated chunks:", hydrated.length);

  // Return formatted results
  const results = hydrated.map(h => {
    const hit = hits.find(hit => hit.chunk_id === h.chunk_id);
    return {
      ...h,
      score: hit?.score ?? 0,
    };
  }).sort((a, b) => b.score - a.score);

  console.log("[search] Final results:", results.length, results.map(r => ({ url: r.url, score: r.score })));
  return results;
}

// These are no longer needed for PG but kept as stubs to avoid breaking imports
export function loadIndex() { }
export function invalidateIndex() { }
