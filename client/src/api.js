const BASE = import.meta.env.VITE_BACKEND_URL || "https://docgpt-90lx.onrender.com";

export async function querySources() {
  const res = await fetch(`${BASE}/sources`);
  if (!res.ok) throw new Error(`[/sources] ${res.status}`);
  return res.json();
}

export async function queryDocuments() {
  const res = await fetch(`${BASE}/documents`);
  if (!res.ok) throw new Error(`[/documents] ${res.status}`);
  return res.json();
}

export async function fetchStats() {
  const res = await fetch(`${BASE}/stats`);
  if (!res.ok) throw new Error(`[/stats] ${res.status}`);
  return res.json();
}

/**
 * Send a question to the server and stream back tokens.
 *
 * @param {string}   question
 * @param {object}   opts
 * @param {number}   [opts.topK=5]
 * @param {string}   [opts.source_id]   – filter by source UUID
 * @param {string}   [opts.docId]      – filter by document UUID
 * @param {Function} opts.onToken      – called with each text token
 * @param {Function} opts.onDone       – called with { sources, chunk_count } when stream ends
 */
export async function sendQueryStream(question, { topK = 5, source_id, docId, onToken, onDone } = {}) {
  // console.log("[sendQueryStream] Sending request:", { question, topK, source_id, docId });

  const res = await fetch(`${BASE}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, topK, stream: true, source_id, docId }),
  });

  // console.log("[sendQueryStream] Response status:", res.status, res.statusText);

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    console.error("[sendQueryStream] Request failed:", err);
    throw new Error(err.error ?? "Query failed");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      // console.log("[sendQueryStream] Stream done.");
      break;
    }
    buf += decoder.decode(value, { stream: true });

    const lines = buf.split("\n");
    buf = lines.pop() ?? ""; // keep last incomplete line

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      // console.log("[sendQueryStream] SSE line:", line);
      try {
        const payload = JSON.parse(line.slice(6));
        if (payload.token !== undefined) onToken?.(payload.token);
        if (payload.done) {
          // console.log("[sendQueryStream] Stream complete. Sources:", payload.sources);
          onDone?.(payload);
        }
      } catch (parseErr) {
        console.warn("[sendQueryStream] Failed to parse SSE line:", line, parseErr);
      }
    }
  }
}

export async function ingestUrl(url, { onStatus, onDone } = {}) {
  const res = await fetch(`${BASE}/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ urls: [url] }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? "Ingest failed");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    const lines = buf.split("\n");
    buf = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try {
        const payload = JSON.parse(line.slice(6));
        if (payload.status) onStatus?.(payload.status);
        if (payload.done) {
          onDone?.(payload);
          return payload;
        }
        if (payload.error) throw new Error(payload.error);
      } catch (parseErr) {
        if (parseErr instanceof SyntaxError) continue; // partial JSON maybe
        console.warn("[ingestUrl] SSE error:", parseErr);
      }
    }
  }
}

// ── get AI suggestions ────────────────────────────────────────────────────────
export async function fetchSuggestions(question) {
  const res = await fetch(`${BASE}/suggestions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
  });
  if (!res.ok) throw new Error(`[/suggestions] ${res.status}`);
  return res.json(); // { suggestions: [string, string, string] }
}
