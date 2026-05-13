import cron from "node-cron";
import { runIngestion } from "../ingestion/pipeline.js";
import { getAllSources } from "../db/client.js";

const SCHEDULE = process.env.CRON_SCHEDULE ?? "0 2 * * *"; // 2am daily

/**
 * Start the scheduled ingestion job.
 */
export function startScheduler() {
  if (!cron.validate(SCHEDULE)) {
    console.error(`[scheduler] Invalid cron expression: "${SCHEDULE}"`);
    return;
  }

  console.log(`[scheduler] Ingestion scheduled: "${SCHEDULE}" (UTC)`);

  cron.schedule(SCHEDULE, async () => {
    console.log("[scheduler] Starting scheduled ingestion for all sources…");
    try {
      const sources = await getAllSources();
      if (!sources.length) {
        console.log("[scheduler] No sources found in database. Skipping.");
        return;
      }

      console.log(`[scheduler] Found ${sources.length} sources to process.`);

      for (const source of sources) {
        console.log(`[scheduler] Processing source: ${source.name} (${source.base_url})`);
        try {
          const stats = await runIngestion({ seedUrls: [source.base_url] });
          console.log(`[scheduler] Ingestion complete for ${source.name}:`, stats);
        } catch (innerErr) {
          console.error(`[scheduler] Ingestion failed for ${source.name}:`, innerErr.message);
        }
      }
      console.log("[scheduler] All scheduled ingests complete.");
    } catch (err) {
      console.error("[scheduler] Scheduler encountered an error:", err.message);
    }
  }, {
    timezone: "UTC",
  });
}

if (process.argv[1].endsWith("cron.js")) {
  import("dotenv/config").then(() => {
    startScheduler();
    console.log("[scheduler] Running. Press Ctrl+C to stop.");
  });
}