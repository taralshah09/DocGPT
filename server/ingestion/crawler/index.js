// ingestion/crawler/index.js
// Modular crawler orchestrator — drop-in replacement for the old crawler.js.
//
// Discovery waterfall (each step merges into a shared URL pool):
//   1. llms.txt        — fastest; AI-friendly URL list if the site publishes one
//   2. Sitemap XML     — standard; works for most static/SSG doc sites
//   3. Nav sidebar     — single-page scrape of the seed URL's sidebar links
//   4. BFS crawl       — broadest; follows every qualifying <a href>
//
// Steps 3 & 4 only run if the previous steps didn't find enough pages
// (threshold: MIN_URLS_BEFORE_BFS, default 5).
//
// Usage (same API as the old crawler.js):
//   import { discoverUrls, fetchPages } from "./crawler/index.js";

import pLimit from "p-limit";
import { resolveConfig } from "./site-configs.js";
import { discoverViaLlmsTxt } from "./strategies/llms-txt.js";
import { discoverViaSitemap } from "./strategies/sitemap.js";
import { discoverViaNav, discoverViaBfs } from "./strategies/bfs.js";
import { fetchUrl, fetchSafe, sleep } from "./fetcher.js";

const CONCURRENCY = parseInt(process.env.CRAWL_CONCURRENCY ?? "3");
const DELAY_MS = parseInt(process.env.CRAWL_DELAY_MS ?? "400");
const MAX_PAGES = parseInt(process.env.MAX_PAGES ?? "200");
const MIN_URLS_BEFORE_BFS = parseInt(process.env.MIN_URLS_BEFORE_BFS ?? "5");

// ─── URL discovery ────────────────────────────────────────────────────────────

/**
 * Discover all documentation page URLs for a given seed URL.
 * Tries multiple strategies in order, merging results.
 *
 * @param {string} seedUrl  e.g. "https://nextjs.org/docs"
 * @returns {Promise<string[]>}
 */
export async function discoverUrls(seedUrl, onStatus) {
    let origin;
    try {
        origin = new URL(seedUrl).origin;
    } catch {
        throw new Error(`[crawler] Invalid seed URL: ${seedUrl}`);
    }

    const config = resolveConfig(seedUrl);
    
    const report = (msg) => {
        console.log(msg);
        if (onStatus) onStatus(msg);
    };

    report(`[crawler] Site config for ${origin}:
    docPathPrefix: ${config.docPathPrefix}
    sitemapPaths: ${config.sitemapPaths}
    navSelectors: ${config.navSelectors?.length}`);

    const pool = new Set([seedUrl]);  // always include the seed itself

    // ── Strategy 1: llms.txt ──────────────────────────────────────────────────
    report("\n[crawler] Strategy 1/4: llms.txt");
    const llmsUrls = await discoverViaLlmsTxt(origin, config);
    llmsUrls.forEach(u => pool.add(u));
    report(`[crawler] Pool after llms.txt: ${pool.size} URLs`);

    // ── Strategy 2: Sitemap XML ───────────────────────────────────────────────
    report("\n[crawler] Strategy 2/4: Sitemap XML");
    const sitemapUrls = await discoverViaSitemap(origin, config, onStatus);
    sitemapUrls.forEach(u => pool.add(u));
    report(`[crawler] Pool after sitemap: ${pool.size} URLs`);

    // ── Strategy 3 & 4: Nav scrape + BFS (only if pool is still small) ────────
    if (pool.size < MIN_URLS_BEFORE_BFS) {
        report(`\n[crawler] Pool is small (${pool.size}), trying nav scrape + BFS`);

        // Strategy 3: Nav sidebar (1 request, fast)
        report("[crawler] Strategy 3/4: Nav sidebar scrape");
        const navUrls = await discoverViaNav(seedUrl, origin, config);
        navUrls.forEach(u => pool.add(u));
        report(`[crawler] Pool after nav scrape: ${pool.size} URLs`);

        // Strategy 4: Full BFS — always run if still small, seeds with everything found so far
        report("[crawler] Strategy 4/4: BFS crawl");
        const bfsUrls = await discoverViaBfs([...pool], origin, config);
        bfsUrls.forEach(u => pool.add(u));
        report(`[crawler] Pool after BFS: ${pool.size} URLs`);
    } else {
        report(`[crawler] Skipping BFS (pool size ${pool.size} ≥ ${MIN_URLS_BEFORE_BFS})`);

        // Still run nav scrape to catch any pages the sitemap missed
        report("\n[crawler] Strategy 3/4: Nav sidebar scrape (supplemental)");
        const navUrls = await discoverViaNav(seedUrl, origin, config);
        navUrls.forEach(u => pool.add(u));
        report(`[crawler] Pool after supplemental nav: ${pool.size} URLs`);
    }

    const discovered = [...pool]
        .filter(u => {
            try {
                const { pathname } = new URL(u);
                return pathname.startsWith(config.docPathPrefix);
            } catch {
                return false;
            }
        })
        .slice(0, MAX_PAGES);

    report(`\n[crawler] ✓ Discovery complete — ${discovered.length} URLs (capped at ${MAX_PAGES})`);
    return discovered;
}

// ─── page fetching ────────────────────────────────────────────────────────────

/**
 * Fetch HTML for every URL with concurrency control.
 * Returns only successfully fetched pages.
 *
 * @param {string[]} urls
 * @returns {Promise<Array<{url: string, html: string, fetchedAt: string}>>}
 */
export async function fetchPages(urls) {
    const limit = pLimit(CONCURRENCY);
    const results = [];
    let success = 0, failure = 0;

    const config = urls.length ? resolveConfig(urls[0]) : {};

    const tasks = urls.map(url =>
        limit(async () => {
            try {
                const html = await fetchUrl(url, config.headers ?? {});
                const fetchedAt = new Date().toISOString();
                results.push({ url, html, fetchedAt });
                success++;
                if (success % 10 === 0) {
                    console.log(`[crawler] Fetched ${success}/${urls.length}…`);
                }
            } catch (err) {
                failure++;
                console.warn(`[crawler] ✗ ${url} — ${err.message}`);
            }
            await sleep(DELAY_MS);
        })
    );

    await Promise.all(tasks);
    console.log(`[crawler] Fetch complete: ${success} OK, ${failure} failed (${urls.length} total)`);
    return results;
}