// ingestion/crawler.js
// Crawls any documentation site: discovers URLs via sitemap → fetches each page's HTML
// Returns: Array<{ url, html, fetchedAt }>

import axios from "axios";
import * as cheerio from "cheerio";
import pLimit from "p-limit";

const CONCURRENCY  = parseInt(process.env.CRAWL_CONCURRENCY  ?? "3");
const DELAY_MS     = parseInt(process.env.CRAWL_DELAY_MS     ?? "500");
const MAX_PAGES    = parseInt(process.env.MAX_PAGES          ?? "200");

// ─── helpers ────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchXML(url) {
  const res = await axios.get(url, {
    timeout: 15_000,
    headers: { "User-Agent": "RAG-Crawler/1.0 (educational)" },
  });
  return res.data;
}

async function fetchHTML(url) {
  const res = await axios.get(url, {
    timeout: 15_000,
    headers: {
      "User-Agent": "RAG-Crawler/1.0 (educational)",
      "Accept": "text/html",
    },
  });
  return res.data;
}

// ─── URL discovery ───────────────────────────────────────────────────────────

/**
 * Given a base URL, derive candidate sitemap locations and try each one.
 */
function getSitemapCandidates(baseUrl) {
  const origin = new URL(baseUrl).origin;
  return [
    `${origin}/sitemap.xml`,
    `${origin}/sitemap_index.xml`,
    `${origin}/sitemap/sitemap.xml`,
    `${origin}/sitemap-index.xml`,
    `${origin}/sitemap-0.xml`,
  ];
}

/**
 * Parse one sitemap XML string and collect all <loc> URLs belonging to origin.
 */
async function collectUrlsFromXml(xml, origin) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const urls = [];

  $("url loc").each((_, el) => {
    const href = $(el).text().trim();
    try {
      if (new URL(href).origin === origin) urls.push(href);
    } catch { /* skip malformed */ }
  });

  // plain <loc> not under <url> (simple sitemaps)
  $("loc").each((_, el) => {
    const href = $(el).text().trim();
    try {
      if (new URL(href).origin === origin) urls.push(href);
    } catch { /* skip malformed */ }
  });

  // handle sitemap index — recursively fetch nested sitemaps
  const nestedSitemaps = [];
  $("sitemap loc").each((_, el) => {
    const href = $(el).text().trim();
    try { nestedSitemaps.push(href); } catch { /* skip */ }
  });

  for (const nested of nestedSitemaps) {
    try {
      const nestedXml = await fetchXML(nested);
      const sub = await collectUrlsFromXml(nestedXml, origin);
      urls.push(...sub);
    } catch {
      // ignore individual nested failures
    }
  }

  return urls;
}

/**
 * Discover all page URLs for a given baseUrl via sitemap.
 * Falls back to BFS link discovery if no sitemap is found.
 * @param {string} baseUrl  e.g. "https://nextjs.org/docs"
 * @returns {Promise<string[]>}
 */
export async function discoverUrls(baseUrl) {
  const origin = new URL(baseUrl).origin;
  const candidates = getSitemapCandidates(baseUrl);

  for (const sitemapUrl of candidates) {
    try {
      console.log(`[crawler] Trying sitemap: ${sitemapUrl}`);
      const xml = await fetchXML(sitemapUrl);
      const urls = await collectUrlsFromXml(xml, origin);

      if (urls.length > 0) {
        // filter to only pages under the given baseUrl path prefix (if any)
        const basePath = new URL(baseUrl).pathname.replace(/\/$/, "");
        const filtered = basePath
          ? urls.filter(u => {
              try { return new URL(u).pathname.startsWith(basePath); } catch { return false; }
            })
          : urls;

        const unique = [...new Set(filtered.length ? filtered : urls)].slice(0, MAX_PAGES);
        console.log(`[crawler] Discovered ${unique.length} URLs from sitemap (${sitemapUrl})`);
        return unique;
      }
    } catch (err) {
      console.warn(`[crawler] Sitemap ${sitemapUrl} failed: ${err.message}`);
    }
  }

  console.warn(`[crawler] No sitemap found for ${baseUrl}, falling back to BFS`);
  return discoverUrlsFromSeed(baseUrl);
}

/**
 * Fallback: BFS crawl starting from baseUrl, staying within the same origin + path prefix.
 * @param {string} baseUrl
 */
async function discoverUrlsFromSeed(baseUrl) {
  const origin   = new URL(baseUrl).origin;
  const basePath = new URL(baseUrl).pathname.replace(/\/$/, "");
  const visited  = new Set();
  const queue    = [baseUrl];
  const found    = [];

  while (queue.length && found.length < MAX_PAGES) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    try {
      const html = await fetchHTML(url);
      const $    = cheerio.load(html);
      found.push(url);

      $("a[href]").each((_, el) => {
        let href = $(el).attr("href");
        if (!href) return;
        // resolve relative URLs
        if (href.startsWith("/")) href = origin + href;
        // keep only same-origin pages under the same path prefix, no anchors
        try {
          const parsed = new URL(href);
          if (
            parsed.origin === origin &&
            (!basePath || parsed.pathname.startsWith(basePath)) &&
            !href.includes("#") &&
            !visited.has(href)
          ) {
            queue.push(href);
          }
        } catch { /* skip malformed */ }
      });

      await sleep(DELAY_MS);
    } catch {
      // skip broken pages
    }
  }

  console.log(`[crawler] Discovered ${found.length} URLs via BFS`);
  return found;
}

// ─── fetch pages ─────────────────────────────────────────────────────────────

/**
 * Fetch HTML for every URL, respecting concurrency + delay.
 * @param {string[]} urls
 * @returns {Promise<Array<{url, html, fetchedAt}>>}
 */
export async function fetchPages(urls) {
  const limit   = pLimit(CONCURRENCY);
  const results = [];

  const tasks = urls.map(url =>
    limit(async () => {
      try {
        const html      = await fetchHTML(url);
        const fetchedAt = new Date().toISOString();
        console.log(`[crawler] ✓ ${url}`);
        results.push({ url, html, fetchedAt });
      } catch (err) {
        console.warn(`[crawler] ✗ ${url} — ${err.message}`);
      }
      await sleep(DELAY_MS);
    })
  );

  await Promise.all(tasks);
  console.log(`[crawler] Fetched ${results.length}/${urls.length} pages`);
  return results;
}