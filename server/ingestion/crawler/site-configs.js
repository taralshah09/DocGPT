// ingestion/crawler/site-configs.js
// Per-site configuration for known documentation portals.
// The crawler resolves the best config by matching the crawl URL's hostname.
//
// Each entry may specify:
//   sitemapPaths   – ordered list of sitemap URL paths to try (relative to origin)
//   docPathPrefix  – only keep URLs whose pathname starts with this
//   contentSelectors – CSS selectors (tried in order) to extract main content
//   navSelectors   – CSS selectors for sidebar nav links (extra URL discovery)
//   skipExtensions – file extensions to ignore during BFS
//   headers        – extra request headers for this host

/** @type {Record<string, SiteConfig>} */
export const SITE_CONFIGS = {
    // ── Next.js ──────────────────────────────────────────────────────────────
    "nextjs.org": {
        docPathPrefix: "/docs",
        sitemapPaths: [
            "/sitemap.xml",
            "/docs/sitemap.xml",
        ],
        contentSelectors: [
            "article",
            "[class*='prose']",
            "main",
        ],
        navSelectors: [
            "nav a[href^='/docs']",
            "[class*='sidebar'] a",
            "[class*='nav'] a[href^='/docs']",
        ],
    },

    // ── OpenAI ───────────────────────────────────────────────────────────────
    "platform.openai.com": {
        docPathPrefix: "/docs",
        sitemapPaths: [
            "/sitemap.xml",
            "/docs/sitemap.xml",
        ],
        contentSelectors: [
            "article",
            "[class*='content']",
            "main",
        ],
        navSelectors: [
            "nav a[href^='/docs']",
            "[class*='sidebar'] a",
        ],
    },

    // ── Anthropic ─────────────────────────────────────────────────────────────
    "docs.anthropic.com": {
        docPathPrefix: "/",
        sitemapPaths: ["/sitemap.xml"],
        contentSelectors: ["article", "main", "[class*='content']"],
        navSelectors: ["nav a", "[class*='sidebar'] a"],
    },

    // ── Vercel ────────────────────────────────────────────────────────────────
    "vercel.com": {
        docPathPrefix: "/docs",
        sitemapPaths: ["/sitemap.xml"],
        contentSelectors: ["article", "main"],
        navSelectors: ["nav a[href^='/docs']"],
    },

    // ── React ─────────────────────────────────────────────────────────────────
    "react.dev": {
        docPathPrefix: "/",
        sitemapPaths: ["/sitemap.xml"],
        contentSelectors: ["article", "main", "[class*='prose']"],
        navSelectors: ["nav a", "[class*='sidebar'] a"],
    },

    // ── Tailwind CSS ──────────────────────────────────────────────────────────
    "tailwindcss.com": {
        docPathPrefix: "/docs",
        sitemapPaths: ["/sitemap.xml"],
        contentSelectors: ["#prose", "article", "main"],
        navSelectors: ["nav a[href^='/docs']"],
    },

    // ── MDN Web Docs ──────────────────────────────────────────────────────────
    "developer.mozilla.org": {
        docPathPrefix: "/en-US/docs",
        sitemapPaths: ["/sitemap.xml"],
        contentSelectors: ["article#wikiArticle", "article", "main"],
        navSelectors: [],
    },

    // ── Stripe ────────────────────────────────────────────────────────────────
    "stripe.com": {
        docPathPrefix: "/docs",
        sitemapPaths: ["/sitemap.xml"],
        contentSelectors: ["article", "[class*='Content']", "main"],
        navSelectors: ["[class*='sidebar'] a[href^='/docs']"],
    },
};

/**
 * Resolve the site config for a given URL string.
 * Falls back to sensible defaults if no specific config exists.
 *
 * @param {string} url
 * @returns {SiteConfig}
 */
export function resolveConfig(url) {
    try {
        const { hostname, pathname } = new URL(url);
        const cfg = SITE_CONFIGS[hostname] ?? {};

        // If no explicit docPathPrefix, use the path of the seed URL
        const docPathPrefix =
            cfg.docPathPrefix ??
            (pathname.length > 1 ? pathname.replace(/\/$/, "") : "/");

        return {
            sitemapPaths: [
                "/sitemap.xml",
                "/sitemap_index.xml",
                `${docPathPrefix}/sitemap.xml`,
                "/sitemap-index.xml",
                "/sitemap-0.xml",
            ],
            contentSelectors: ["article", "main", "[class*='content']", "body"],
            navSelectors: [],
            skipExtensions: [".png", ".jpg", ".jpeg", ".gif", ".svg", ".pdf", ".zip"],
            headers: {},
            ...cfg,
            docPathPrefix,
        };
    } catch {
        return {
            docPathPrefix: "/",
            sitemapPaths: ["/sitemap.xml"],
            contentSelectors: ["article", "main", "body"],
            navSelectors: [],
            skipExtensions: [".png", ".jpg", ".jpeg", ".gif", ".svg", ".pdf", ".zip"],
            headers: {},
        };
    }
}

/**
 * @typedef {object} SiteConfig
 * @property {string}   docPathPrefix
 * @property {string[]} sitemapPaths
 * @property {string[]} contentSelectors
 * @property {string[]} navSelectors
 * @property {string[]} [skipExtensions]
 * @property {object}  [headers]
 */