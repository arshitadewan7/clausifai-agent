import { CalendarClient } from "./clients/calendarClient";
import { ClaudeClient } from "./clients/claudeClient";
import { DriveClient } from "./clients/driveClient";
import { GmailClient } from "./clients/gmailClient";
import { SupabaseMemoryClient } from "./clients/supabaseClient";
import { TactiqMcpClient } from "./clients/tactiqMcpClient";
import { loadEnv } from "./config/env";
import { logger } from "./lib/logger";
import { scheduleDigestJob } from "./scheduler/digestJob";
import { CalendarService } from "./services/calendarService";
import { EmailService } from "./services/emailService";
import { IntegrationStateStore } from "./services/integrationStateStore";
import { MemoryStore } from "./services/memoryStore";
import { TactiqSyncService } from "./services/tactiqSyncService";
import { TranscriptService } from "./services/transcriptService";
import { SlackAgent } from "./slack/slackAgent";

async function bootstrap(): Promise<void> {
  const env = loadEnv();

  const supabaseClient = new SupabaseMemoryClient(env);
  const integrationStateStore = new IntegrationStateStore(supabaseClient);
  const memory = new MemoryStore(supabaseClient);

  const gmailClient = new GmailClient(env);
  const claudeClient = new ClaudeClient(env);
  const calendarClient = new CalendarClient(env);
  const driveClient = new DriveClient(env);

  const emailService = new EmailService(gmailClient, claudeClient, memory);
  const calendarService = new CalendarService(calendarClient, memory);
  const transcriptService = new TranscriptService(claudeClient, driveClient, memory);
  const tactiqClient = new TactiqMcpClient(env, integrationStateStore);
  const tactiqSyncService = new TactiqSyncService(tactiqClient, transcriptService, integrationStateStore);

  const slackAgent = new SlackAgent({
    env,
    emailService,
    calendarService,
    transcriptService,
    tactiqSyncService
  });

  scheduleDigestJob(env.EMAIL_DIGEST_CRON, async () => {
    await slackAgent.postDigest(env.SLACK_DEFAULT_CHANNEL);
  });

  if (env.TACTIQ_SYNC_CRON) {
    scheduleDigestJob(env.TACTIQ_SYNC_CRON, async () => {
      const result = await tactiqSyncService.syncRecent(10);
      logger.info("Scheduled Tactiq sync completed", {
        discovered: result.discovered,
        processed: result.processed,
        skipped: result.skipped
      });
    });
  }

  await slackAgent.start(env.PORT);
}

bootstrap().catch((error) => {
  logger.error("Failed to start clausifai-agent", {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
