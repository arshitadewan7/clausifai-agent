import cron, { ScheduledTask } from "node-cron";

import { logger } from "../lib/logger";

export function scheduleDigestJob(cronExpression: string, handler: () => Promise<void>): ScheduledTask {
  return cron.schedule(cronExpression, async () => {
    try {
      await handler();
      logger.info("Scheduled digest completed", { cronExpression });
    } catch (error) {
      logger.error("Scheduled digest failed", {
        cronExpression,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });
}
