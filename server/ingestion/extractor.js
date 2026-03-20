// ingestion/extractor.js
// Converts raw HTML → clean Markdown-like text
// Removes: nav, footer, sidebar, ads, scripts, styles
// Extracts: h1–h3, paragraphs, code blocks, lists

import * as cheerio from "cheerio";

// ─── noise selectors to strip ────────────────────────────────────────────────

const REMOVE_SELECTORS = [
  "nav", "header", "footer", "aside",
  ".sidebar", ".nav", ".navbar", ".menu",
  ".toc", ".table-of-contents",
  ".advertisement", ".ads", ".ad",
  "[role='navigation']", "[role='banner']", "[role='contentinfo']",
  "script", "style", "noscript", "iframe",
  // react.dev specific
  ".toc-root", "article > nav", ".edit-link",
  "[data-sidebar]", ".sidebar-nav",
];

// ─── main extractor ──────────────────────────────────────────────────────────

/**
 * Convert HTML string to clean markdown text.
 * @param {string} html   Raw page HTML
 * @param {string} url    Source URL (used for relative link resolution)
 * @returns {{ title: string, markdown: string }}
 */
export function extractMarkdown(html, url) {
  const $ = cheerio.load(html);

  // 1. Grab <title> before we mangle the DOM
  // Strip trailing " | Brand" or " – Brand" from tab titles
  const pageTitle = $("title").first().text().replace(/\s*[\|–—]\s*[^|–—]+$/, "").trim()
                 || $("h1").first().text().trim()
                 || new URL(url).pathname.split("/").filter(Boolean).pop()
                 || "index";

  // 2. Strip noise
  REMOVE_SELECTORS.forEach(sel => $(sel).remove());

  // 3. Find main content element
  const mainEl =
    $("main").first()
    || $("article").first()
    || $('[role="main"]').first()
    || $(".content").first()
    || $("body");

  // 4. Walk the DOM and emit Markdown
  const lines = [];

  function walk(el) {
    $(el).children().each((_, child) => {
      const tag  = child.tagName?.toLowerCase();
      const $el  = $(child);
      const text = $el.text().trim();

      if (!tag || !text) return;

      switch (tag) {
        case "h1": lines.push(`# ${text}\n`);   break;
        case "h2": lines.push(`\n## ${text}\n`); break;
        case "h3": lines.push(`\n### ${text}\n`); break;
        case "h4": lines.push(`\n#### ${text}\n`); break;

        case "p":
          if (text) lines.push(`${text}\n`);
          break;

        case "ul":
        case "ol": {
          $el.find("li").each((_, li) => {
            const liText = $(li).text().trim();
            if (liText) lines.push(`- ${liText}`);
          });
          lines.push("");
          break;
        }

        case "pre":
        case "code": {
          // extract code content; detect language from class
          const codeEl = tag === "pre" ? $el.find("code") : $el;
          const lang   = (codeEl.attr("class") ?? "")
            .split(" ")
            .find(c => c.startsWith("language-"))
            ?.replace("language-", "") ?? "";
          const code   = codeEl.text().trim();
          if (code) lines.push(`\`\`\`${lang}\n${code}\n\`\`\`\n`);
          break;
        }

        case "table": {
          // simple table → markdown table
          const rows = [];
          $el.find("tr").each((_, tr) => {
            const cells = [];
            $(tr).find("th, td").each((_, td) => cells.push($(td).text().trim()));
            rows.push(`| ${cells.join(" | ")} |`);
          });
          if (rows.length) {
            // insert separator after header
            const sep = rows[0].replace(/[^|]/g, "-").replace(/--+/g, "--");
            rows.splice(1, 0, sep);
            lines.push(...rows, "");
          }
          break;
        }

        case "blockquote":
          lines.push(`> ${text}\n`);
          break;

        case "hr":
          lines.push("---\n");
          break;

        default:
          // recurse into divs, sections, articles, etc.
          if (["div", "section", "article", "main", "aside"].includes(tag)) {
            walk(child);
          }
          break;
      }
    });
  }

  walk(mainEl.length ? mainEl[0] : $("body")[0]);

  // 5. Tidy up: collapse 3+ blank lines → 2
  const markdown = lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { title: pageTitle, markdown };
}