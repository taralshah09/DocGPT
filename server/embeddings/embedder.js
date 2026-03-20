const MODEL     = "BAAI/bge-small-en-v1.5";
const BATCH_SIZE = 32;
const MAX_RETRY  = 3;

// New HF router endpoint (api-inference.huggingface.co is no longer supported)
const HF_ENDPOINT = `https://router.huggingface.co/hf-inference/models/${MODEL}/pipeline/feature-extraction`;

// ─── retry helper ────────────────────────────────────────────────────────────

async function withRetry(fn, retries = MAX_RETRY) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isRetryable =
        err?.message?.includes("503") || err?.message?.includes("429");
      if (attempt === retries || !isRetryable) throw err;
      const delay = 1000 * 2 ** attempt; // 2s, 4s, 8s
      console.warn(
        `[embedder] Error hit, retrying in ${delay}ms… (attempt ${attempt}/${retries})`
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// ─── batch embed ──────────────────────────────────────────────────────────────

async function embedBatch(texts) {
  const token = process.env.HF_TOKEN || process.env.HUGGINGFACE_API_KEY;
  if (!token) {
    throw new Error(
      "HF_TOKEN is not set. Get a free token at huggingface.co/settings/tokens"
    );
  }

  return withRetry(async () => {
    const response = await fetch(HF_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ inputs: texts }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`[embedder] HF API Error: ${response.status} - ${error}`);
    }

    const embeddings = await response.json();
    return embeddings; // number[][]
  });
}

// ─── public API ───────────────────────────────────────────────────────────────

/**
 * Embed a single string.
 * @param {string} text
 * @returns {Promise<number[]>}
 */
export async function embedText(text) {
  const vecs = await embedBatch([text]);
  return vecs[0];
}

/**
 * Embed an array of chunk objects in batches.
 * Attaches `.embedding` to each chunk (mutates in place).
 *
 * @param {Object[]} chunks  Must have a `.content` property
 * @returns {Promise<Object[]>}
 */
export async function embedChunks(chunks) {
  console.log(
    `[embedder] Embedding ${chunks.length} chunks in batches of ${BATCH_SIZE}…`
  );
  let done = 0;

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const texts = batch.map((c) => c.content);
    const vecs  = await embedBatch(texts);

    batch.forEach((chunk, j) => {
      chunk.embedding = vecs[j];
    });

    done += batch.length;
    console.log(`[embedder] ${done}/${chunks.length} embedded`);
  }

  return chunks;
}