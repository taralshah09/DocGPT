import axios from "axios";

const DEFAULT_TIMEOUT = parseInt(process.env.CRAWL_TIMEOUT_MS ?? "20000");
const MAX_RETRIES = parseInt(process.env.CRAWL_MAX_RETRIES ?? "3");
const RETRY_BASE_MS = parseInt(process.env.CRAWL_RETRY_BASE ?? "1000");

const BASE_HEADERS = {
    "User-Agent": "RAG-Crawler/2.0 (educational; +https://github.com/your-repo)",
    "Accept-Language": "en-US,en;q=0.9",
};

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function isRetryable(err) {
    if (!err.response) return true;                   // network / timeout
    const s = err.response.status;
    return s === 429 || s === 503 || s === 502 || s === 504;
}

/**
 * Fetch any URL with automatic retry on transient errors.
 * @param {string} url
 * @param {object} [extraHeaders]
 * @returns {Promise<string>}  response body as string
 */
export async function fetchUrl(url, extraHeaders = {}) {
    let lastErr;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const res = await axios.get(url, {
                timeout: DEFAULT_TIMEOUT,
                headers: { ...BASE_HEADERS, ...extraHeaders },
                // Follow redirects, decompress gzip/br automatically
                maxRedirects: 5,
                responseType: "text",
                // Prevent axios from throwing on 4xx/5xx so we can inspect status
                validateStatus: null,
            });

            if (res.status === 404) {
                throw Object.assign(new Error(`404 Not Found`), { response: res, permanent: true });
            }
            if (res.status >= 400) {
                throw Object.assign(new Error(`HTTP ${res.status}`), { response: res });
            }

            return res.data;
        } catch (err) {
            lastErr = err;
            if (err.permanent) throw err; // don't retry 404s
            if (!isRetryable(err)) throw err;

            const delay = RETRY_BASE_MS * 2 ** attempt + Math.random() * 200;
            console.warn(`[fetcher] Attempt ${attempt + 1}/${MAX_RETRIES + 1} failed for ${url} — ${err.message}. Retrying in ${Math.round(delay)}ms`);
            await sleep(delay);
        }
    }

    throw lastErr;
}

/**
 * Best-effort fetch — returns null instead of throwing.
 * Use in discovery loops where a single failure is acceptable.
 */
export async function fetchSafe(url, extraHeaders = {}) {
    try {
        return await fetchUrl(url, extraHeaders);
    } catch {
        return null;
    }
}

export { sleep };