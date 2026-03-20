// db/qdrant.js
// All vector operations against a local Qdrant instance (http://localhost:6333).
// Qdrant docs: https://qdrant.tech/documentation/
//
// Each point stored in Qdrant looks like:
//   { id: <chunk UUID>, vector: [...], payload: { chunk_id, doc_id, source_id } }
//
// After a similarity search, pass the returned chunk IDs to
// getChunksByIds() in client.js to hydrate the full metadata from Postgres.

const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const COLLECTION = process.env.QDRANT_COLLECTION || "chunks";

// Dimensionality must match your embedding model.
// BAAI/bge-small-en-v1.5 → 384
// text-embedding-3-small → 1536
const VECTOR_DIM = parseInt(process.env.QDRANT_VECTOR_DIM ?? "384", 10);

// ─── helpers ──────────────────────────────────────────────────────────────────

async function qdrantFetch(path, options = {}) {
    const headers = { "Content-Type": "application/json" };
    if (process.env.API_KEY) {
        headers["api-key"] = process.env.API_KEY;
    }

    const res = await fetch(`${QDRANT_URL}${path}`, {
        headers,
        ...options,
    });

    if (!res.ok) {
        const body = await res.text();
        throw new Error(`[qdrant] ${options.method ?? "GET"} ${path} → ${res.status}: ${body}`);
    }

    return res.json();
}

// ─── collection lifecycle ─────────────────────────────────────────────────────

/**
 * Create the Qdrant collection if it doesn't exist yet.
 * Safe to call on every startup (no-ops when already present).
 */
export async function ensureCollection() {
    try {
        const info = await qdrantFetch(`/collections/${COLLECTION}`);
        console.log("[qdrant] Info vectors:", JSON.stringify(info.result?.config?.params?.vectors));
        const currentDim = info.result?.config?.params?.vectors?.size || info.result?.config?.params?.vectors?.[""]?.size;

        if (currentDim && currentDim !== VECTOR_DIM) {
            console.warn(`[qdrant] Dimension mismatch: DB has ${currentDim}, code wants ${VECTOR_DIM}. Recreating collection...`);
            await qdrantFetch(`/collections/${COLLECTION}`, { method: "DELETE" });
        } else {
            console.log(`[qdrant] Collection "${COLLECTION}" already exists with correct dimension (${currentDim}).`);
            // Continue to ensure indexes exist
        }
    } catch (err) {
        // Collection doesn't exist or error — proceed to create
        console.log(`[qdrant] Creating collection "${COLLECTION}" (dim=${VECTOR_DIM})...`);
        await qdrantFetch(`/collections/${COLLECTION}`, {
            method: "PUT",
            body: JSON.stringify({
                vectors: {
                    size: VECTOR_DIM,
                    distance: "Cosine",
                },
                optimizers_config: { default_segment_number: 2 },
            }),
        });
    }

    // Index the payload fields we filter on so Qdrant can use them efficiently.
    // Qdrant's PUT /index is idempotent if the index already exists.
    const fieldsToIndex = ["doc_id", "source_id", "chunk_id"];
    for (const field_name of fieldsToIndex) {
        try {
            await qdrantFetch(`/collections/${COLLECTION}/index`, {
                method: "PUT",
                body: JSON.stringify({ field_name, field_schema: "keyword" }),
            });
            console.log(`[qdrant] Index ensured for field: ${field_name}`);
        } catch (err) {
            console.warn(`[qdrant] Indexed field ${field_name} warning:`, err.message);
        }
    }

    console.log(`[qdrant] Collection "${COLLECTION}" ready.`);
}

// ─── write ops ────────────────────────────────────────────────────────────────

/**
 * Upsert chunk vectors into Qdrant.
 *
 * @param {Array<{chunk_id: string, doc_id: string, source_id: string, embedding: number[]}>} chunks
 */
export async function upsertVectors(chunks) {
    if (!chunks.length) return;

    const points = chunks.map(c => ({
        id: c.chunk_id,          // UUID string — Qdrant accepts UUID point IDs
        vector: c.embedding,
        payload: {
            chunk_id: c.chunk_id,
            doc_id: c.doc_id,
            source_id: c.source_id ?? null,
        },
    }));

    await qdrantFetch(`/collections/${COLLECTION}/points`, {
        method: "PUT",
        body: JSON.stringify({ points }),
    });
}

/**
 * Delete all vectors that belong to a given document.
 * Call this when a document is updated so stale chunk vectors are removed.
 *
 * @param {string} documentId
 */
export async function deleteChunksByDocumentId(documentId) {
    await qdrantFetch(`/collections/${COLLECTION}/points/delete`, {
        method: "POST",
        body: JSON.stringify({
            filter: {
                must: [{ key: "doc_id", match: { value: documentId } }],
            },
        }),
    });
}

// ─── search ───────────────────────────────────────────────────────────────────

/**
 * Vector similarity search in Qdrant.
 *
 * @param {number[]} vector         - Query embedding.
 * @param {object}  opts
 * @param {number}  opts.topK       - Max results (default 5).
 * @param {number}  opts.threshold  - Min cosine similarity score (default 0.7).
 * @param {string}  [opts.source_id] - Optional: filter to a specific source UUID.
 * @param {string}  [opts.docId]    - Optional: filter to a specific document UUID.
 *
 * @returns {Promise<Array<{chunk_id, doc_id, score}>>}
 */
export async function searchVectors(vector, { topK = 5, threshold = 0.7, source_id, docId } = {}) {
    const filter = buildFilter({ source_id, docId });

    console.log("[qdrant] searchVectors — filter:", JSON.stringify(filter));
    console.log("[qdrant] searchVectors — topK:", topK, "| threshold:", threshold);

    const body = {
        vector,
        limit: topK,
        score_threshold: threshold,
        with_payload: true,
        ...(filter ? { filter } : {}),
    };

    const result = await qdrantFetch(`/collections/${COLLECTION}/points/search`, {
        method: "POST",
        body: JSON.stringify(body),
    });

    const hits = result.result ?? [];
    console.log("[qdrant] Raw hits:", hits.length, hits.map(h => ({ id: h.id, score: h.score, payload: h.payload })));

    if (hits.length === 0) {
        // Re-run without filter or threshold to check if ANY vectors exist
        console.warn("[qdrant] No hits with current filter/threshold. Running unfiltered probe (no threshold, no filter)...");
        const probe = await qdrantFetch(`/collections/${COLLECTION}/points/search`, {
            method: "POST",
            body: JSON.stringify({ vector, limit: 3, with_payload: true }),
        });
        const probeHits = probe.result ?? [];
        console.warn("[qdrant] Unfiltered probe hits:", probeHits.length, probeHits.map(h => ({ id: h.id, score: h.score, source_id: h.payload?.source_id })));
    }

    // result.result is an array of { id, score, payload }
    return hits.map(hit => ({
        chunk_id: hit.payload.chunk_id,
        doc_id: hit.payload.doc_id,
        source_id: hit.payload.source_id,
        score: hit.score,
    }));
}

// ─── internal helpers ─────────────────────────────────────────────────────────

function buildFilter({ source_id, docId } = {}) {
    const must = [];

    if (docId) must.push({ key: "doc_id", match: { value: docId } });
    if (source_id) must.push({ key: "source_id", match: { value: source_id } });

    return must.length ? { must } : null;
}

// ─── stats ────────────────────────────────────────────────────────────────────

export async function getCollectionInfo() {
    const res = await qdrantFetch(`/collections/${COLLECTION}`);
    const info = res.result;
    return {
        vectorsCount: info.vectors_count,
        pointsCount: info.points_count,
        status: info.status,
        optimizerStatus: info.optimizer_status?.status,
    };
}