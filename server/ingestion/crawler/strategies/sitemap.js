// ingestion/crawler/strategies/sitemap.js
// Strategy 1: Discover URLs via XML sitemap (including sitemap-index recursion).

import * as cheerio from "cheerio";
import { fetchSafe } from "../fetcher.js";

/**
 * Attempt sitemap discovery for a given base URL using the site's config.
 *
 * @param {string}     origin   e.g. "https://nextjs.org"
 * @param {SiteConfig} config   resolved site config
 * @returns {Promise<string[]>} discovered URLs (may be empty)
 */
export async function discoverViaSitemap(origin, config, onStatus) {
    const report = (msg) => {
        console.log(msg);
        if (onStatus) onStatus(msg);
    };

    for (const path of config.sitemapPaths) {
        const sitemapUrl = `${origin}${path}`;
        report(`[sitemap] Trying ${sitemapUrl}`);

        const xml = await fetchSafe(sitemapUrl, { Accept: "application/xml, text/xml, */*" });
        if (!xml || xml.trim().length < 50) continue;

        // Quick sanity check — should look like XML
        if (!xml.trim().startsWith("<")) {
            report(`[sitemap] ${sitemapUrl} returned non-XML content, skipping`);
            continue;
        }

        try {
            const urls = await parseXml(xml, origin, config);
            if (urls.length > 0) {
                report(`[sitemap] Found ${urls.length} URLs via ${sitemapUrl}`);
                return urls;
            }
        } catch (err) {
            report(`[sitemap] Parse error for ${sitemapUrl}: ${err.message}`);
        }
    }

    report(`[sitemap] No usable sitemap found for ${origin}`);
    return [];
}

// ─── XML parsing ──────────────────────────────────────────────────────────────

async function parseXml(xml, origin, config) {
    const $ = cheerio.load(xml, { xmlMode: true });
    const urls = new Set();

    // Standard <url><loc> pattern
    $("url > loc").each((_, el) => addIfAllowed($(el).text().trim(), origin, config, urls));

    // Plain <loc> outside <url> (simple sitemaps)
    $("loc").each((_, el) => addIfAllowed($(el).text().trim(), origin, config, urls));

    // Sitemap index — recursively fetch nested sitemaps
    const nested = [];
    $("sitemap > loc").each((_, el) => nested.push($(el).text().trim()));

    await Promise.all(
        nested.map(async nestedUrl => {
            const nestedXml = await fetchSafe(nestedUrl, { Accept: "application/xml, text/xml, */*" });
            if (!nestedXml) return;
            try {
                const sub = await parseXml(nestedXml, origin, config);
                sub.forEach(u => urls.add(u));
            } catch { /* ignore individual nested failures */ }
        })
    );

    return [...urls];
}

function addIfAllowed(href, origin, config, set) {
    if (!href) return;
    try {
        const parsed = new URL(href);
        if (parsed.origin !== origin) return;
        if (!parsed.pathname.startsWith(config.docPathPrefix)) return;
        // Strip fragments
        parsed.hash = "";
        set.add(parsed.toString());
    } catch { /* malformed URL */ }
}