// ingestion/crawler/strategies/llms-txt.js
// Strategy 2: Discover URLs via /llms.txt (a growing standard for AI-friendly docs).
//
// The llms.txt spec: https://llmstxt.org
// Sites like Anthropic, many dev-tool companies publish these.
// Format is Markdown with a list of links to canonical documentation pages.

import * as cheerio from "cheerio";
import { fetchSafe } from "../fetcher.js";

const LLMS_PATHS = ["/llms.txt", "/llms-full.txt"];

/**
 * Attempt URL discovery via llms.txt for a given origin.
 *
 * @param {string}     origin  e.g. "https://nextjs.org"
 * @param {SiteConfig} config
 * @returns {Promise<string[]>}
 */
export async function discoverViaLlmsTxt(origin, config) {
    for (const path of LLMS_PATHS) {
        const url = `${origin}${path}`;
        console.log(`[llms.txt] Trying ${url}`);

        const text = await fetchSafe(url);
        if (!text || text.trim().length < 10) continue;

        const urls = extractUrls(text, origin, config);
        if (urls.length > 0) {
            console.log(`[llms.txt] Found ${urls.length} URLs via ${url}`);
            return urls;
        }
    }

    return [];
}

// ─── parsing ─────────────────────────────────────────────────────────────────

function extractUrls(text, origin, config) {
    const urls = new Set();

    // Match all Markdown links: [label](url)
    const mdLinkRe = /\[([^\]]*)\]\(([^)]+)\)/g;
    let m;
    while ((m = mdLinkRe.exec(text)) !== null) {
        addIfAllowed(m[2].trim(), origin, config, urls);
    }

    // Match bare URLs
    const bareUrlRe = /https?:\/\/[^\s\)>"]+/g;
    while ((m = bareUrlRe.exec(text)) !== null) {
        addIfAllowed(m[0].trim(), origin, config, urls);
    }

    return [...urls];
}

function addIfAllowed(href, origin, config, set) {
    if (!href) return;
    try {
        const parsed = new URL(href);
        if (parsed.origin !== origin) return;
        if (!parsed.pathname.startsWith(config.docPathPrefix)) return;
        parsed.hash = "";
        set.add(parsed.toString());
    } catch { /* skip */ }
}