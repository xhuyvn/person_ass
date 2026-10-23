import type { Logger } from "../logger.js";
import type { Ctx } from "./core.js";
import { runSchedulerTick } from "./notifications.js";

export const TICK_INTERVAL_MS = 15_000;

/**
 * Run a tick immediately (startup recovery: missed occurrences become one
 * digest, docs/05 §5) and then every TICK_INTERVAL_MS. A failing tick is
 * logged and retried on the next interval; it never crashes the process.
 */
export function startScheduler(ctx: Ctx, logger: Logger, intervalMs = TICK_INTERVAL_MS): () => void {
  const run = (): void => {
    try {
      const r = runSchedulerTick(ctx);
      if (r.reminders > 0 || r.missed > 0) logger.info("scheduler_tick", { ...r });
    } catch (err) {
      logger.error("scheduler_tick_failed", { error: err instanceof Error ? err.message : String(err) });
    }
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
