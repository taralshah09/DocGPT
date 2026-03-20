// ingestion/crawler/strategies/bfs.js
// Strategy 3: Breadth-first crawl starting from a seed URL.
//
// Two passes:
//   a) Nav-sidebar scrape  — fast; extracts links from the doc sidebar/nav
//   b) Full BFS            — slower; follows every qualifying <a href>
//
// Nav scraping alone often discovers 90%+ of a doc site's pages in a single
// request if the sidebar is server-rendered (Next.js App Router, Docusaurus, etc.).

import * as cheerio from "cheerio";
import pLimit from "p-limit";
import { fetchSafe, sleep } from "../fetcher.js";

const CONCURRENCY = parseInt(process.env.CRAWL_CONCURRENCY ?? "3");
const DELAY_MS = parseInt(process.env.CRAWL_DELAY_MS ?? "400");
const MAX_PAGES = parseInt(process.env.MAX_PAGES ?? "200");

// ─── nav sidebar scrape (single request) ─────────────────────────────────────

/**
 * Fetch the seed page and extract all hrefs from known nav/sidebar selectors.
 * This is tried first; it's fast and often complete for SSR doc sites.
 *
 * @param {string}     seedUrl
 * @param {string}     origin
 * @param {SiteConfig} config
 * @returns {Promise<string[]>}
 */
export async function discoverViaNav(seedUrl, origin, config) {
    if (!config.navSelectors?.length) return [];

    console.log(`[bfs/nav] Scraping nav from ${seedUrl}`);
    const html = await fetchSafe(seedUrl, config.headers ?? {});
    if (!html) return [];

    const $ = cheerio.load(html);
    const urls = new Set();

    for (const sel of config.navSelectors) {
        $(sel).each((_, el) => {
            const href = $(el).attr("href");
            if (href) addIfAllowed(href, origin, config, urls);
        });
    }

    // Also grab all links with the docPathPrefix anywhere on the seed page
    $("a[href]").each((_, el) => {
        const href = $(el).attr("href");
        if (href) addIfAllowed(href, origin, config, urls);
    });

    const result = [...urls];
    if (result.length > 0) {
        console.log(`[bfs/nav] Found ${result.length} links in nav`);
    }
    return result;
}

// ─── full BFS crawl ───────────────────────────────────────────────────────────

/**
 * Standard BFS starting from seedUrls, staying within origin + docPathPrefix.
 * Seeds the queue with any URLs already discovered by prior strategies.
 *
 * @param {string[]}   seedUrls    initial queue
 * @param {string}     origin
 * @param {SiteConfig} config
 * @returns {Promise<string[]>}  all URLs visited (including seeds)
 */
export async function discoverViaBfs(seedUrls, origin, config) {
    const visited = new Set();
    const queue = [...new Set(seedUrls)];
    const found = [];

    console.log(`[bfs] Starting BFS from ${queue.length} seed(s)`);

    while (queue.length && found.length < MAX_PAGES) {
        const batch = queue.splice(0, CONCURRENCY);
        const limit = pLimit(CONCURRENCY);

        await Promise.all(
            batch.map(url =>
                limit(async () => {
                    if (visited.has(url)) return;
                    visited.add(url);

                    const html = await fetchSafe(url, config.headers ?? {});
                    if (!html) return;

                    found.push(url);
                    const $ = cheerio.load(html);

                    $("a[href]").each((_, el) => {
                        const href = $(el).attr("href");
                        if (!href) return;
                        const abs = resolveHref(href, origin);
                        if (abs && isAllowed(abs, origin, config) && !visited.has(abs)) {
                            queue.push(abs);
                        }
                    });

                    await sleep(DELAY_MS);
                })
            )
        );
    }

    console.log(`[bfs] BFS complete — found ${found.length} URLs`);
    return found;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function resolveHref(href, origin) {
    if (!href || href.startsWith("mailto:") || href.startsWith("javascript:")) return null;
    if (href.startsWith("//")) href = "https:" + href;
    if (href.startsWith("/")) href = origin + href;
    try {
        const u = new URL(href);
        u.hash = "";
        return u.toString();
    } catch {
        return null;
    }
}

function isAllowed(url, origin, config) {
    try {
        const parsed = new URL(url);
        if (parsed.origin !== origin) return false;
        if (!parsed.pathname.startsWith(config.docPathPrefix)) return false;

        const skipExt = config.skipExtensions ?? [".png", ".jpg", ".jpeg", ".gif", ".svg", ".pdf", ".zip"];
        if (skipExt.some(ext => parsed.pathname.endsWith(ext))) return false;

        return true;
    } catch {
        return false;
    }
}

function addIfAllowed(href, origin, config, set) {
    if (!href) return;
    // Relative URLs
    if (href.startsWith("/")) href = origin + href;
    const abs = resolveHref(href, origin);
    if (abs && isAllowed(abs, origin, config)) set.add(abs);
}