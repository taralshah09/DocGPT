import { searchVectors } from "../db/qdrant.js";
import { embedText } from "../embeddings/embedder.js";

export async function search(query, { topK = 5, threshold = 0.7, source, source_id, docId } = {}) {
  console.log("[search] Query:", query, "| topK:", topK, "| threshold:", threshold, "| source_id:", source_id, "| docId:", docId);

  const queryVec = await embedText(query);
  console.log("[search] Embedding generated, length:", queryVec?.length);

  const hits = await searchVectors(queryVec, { topK, threshold, source_id: source_id ?? source, docId });
  console.log("[search] Qdrant hits:", hits.length, hits.map(h => ({ chunk_id: h.chunk_id, score: h.score })));

  const { getChunksByIds } = await import("../db/client.js");
  const chunkIds = hits.map(h => h.chunk_id);
  console.log("[search] Hydrating chunk IDs:", chunkIds);

  const hydrated = await getChunksByIds(chunkIds);
  console.log("[search] Hydrated chunks:", hydrated.length);

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

export function loadIndex() { }
export function invalidateIndex() { }
