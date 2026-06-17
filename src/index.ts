import { CalendarClient } from "./clients/calendarClient";
import { ClaudeClient } from "./clients/claudeClient";
import { DriveClient } from "./clients/driveClient";
import { GmailClient } from "./clients/gmailClient";
import { SupabaseMemoryClient } from "./clients/supabaseClient";
import { loadEnv } from "./config/env";
import { logger } from "./lib/logger";
import { scheduleDigestJob } from "./scheduler/digestJob";
import { CalendarService } from "./services/calendarService";
import { EmailService } from "./services/emailService";
import { MemoryStore } from "./services/memoryStore";
import { TranscriptService } from "./services/transcriptService";
import { SlackAgent } from "./slack/slackAgent";

async function bootstrap(): Promise<void> {
  const env = loadEnv();

  const supabaseClient = new SupabaseMemoryClient(env);
  const memory = new MemoryStore(supabaseClient);

  const gmailClient = new GmailClient(env);
  const claudeClient = new ClaudeClient(env);
  const calendarClient = new CalendarClient(env);
  const driveClient = new DriveClient(env);

  const emailService = new EmailService(gmailClient, claudeClient, memory);
  const calendarService = new CalendarService(calendarClient, memory);
  const transcriptService = new TranscriptService(claudeClient, driveClient, memory);

  const slackAgent = new SlackAgent({
    env,
    emailService,
    calendarService,
    transcriptService
  });

  scheduleDigestJob(env.EMAIL_DIGEST_CRON, async () => {
    await slackAgent.postDigest(env.SLACK_DEFAULT_CHANNEL);
  });

  await slackAgent.start(env.PORT);
}

bootstrap().catch((error) => {
  logger.error("Failed to start clausifai-agent", {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
