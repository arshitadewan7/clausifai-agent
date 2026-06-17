import { App, ExpressReceiver } from "@slack/bolt";
import express from "express";

import type { Env } from "../config/env";
import { logger } from "../lib/logger";
import type { TranscriptWebhookPayload } from "../types/domain";
import type { CalendarService } from "../services/calendarService";
import type { EmailService } from "../services/emailService";
import type { TactiqSyncService } from "../services/tactiqSyncService";
import type { TranscriptService } from "../services/transcriptService";
import {
  calendarBlocks,
  digestItemBlocks,
  digestOverviewBlocks,
  transcriptSummaryBlocks
} from "./blocks";

interface SlackAgentDeps {
  env: Env;
  emailService: EmailService;
  calendarService: CalendarService;
  transcriptService: TranscriptService;
  tactiqSyncService: TactiqSyncService;
}

export class SlackAgent {
  private readonly receiver: ExpressReceiver;
  private readonly app: App;

  constructor(private readonly deps: SlackAgentDeps) {
    this.receiver = new ExpressReceiver({
      signingSecret: deps.env.SLACK_SIGNING_SECRET
    });

    this.receiver.router.use(express.json({ limit: "2mb" }));
    this.registerApiRoutes();

    this.app = new App({
      token: deps.env.SLACK_BOT_TOKEN,
      receiver: this.receiver
    });

    this.registerSlackHandlers();
  }

  async start(port: number): Promise<void> {
    await this.app.start(port);
    logger.info("Slack agent started", { port });
  }

  async postDigest(channel: string): Promise<void> {
    const digest = await this.deps.emailService.buildDigest();

    await this.app.client.chat.postMessage({
      channel,
      text: "clausifai-agent digest",
      blocks: digestOverviewBlocks(digest) as any
    });

    for (const item of digest.items) {
      await this.app.client.chat.postMessage({
        channel,
        text: `Email from ${item.thread.from}: ${item.thread.subject}`,
        blocks: digestItemBlocks(item.thread, item.triage, item.draft) as any
      });
    }
  }

  private registerApiRoutes(): void {
    this.receiver.router.get("/health", (_req, res) => {
      res.status(200).json({ ok: true, service: "clausifai-agent" });
    });

    this.receiver.router.post("/webhooks/transcript", async (req, res) => {
      try {
        const configuredSecret = this.deps.env.TRANSCRIPT_WEBHOOK_SECRET;
        const providedSecret = req.header("x-transcript-secret");
        if (configuredSecret && providedSecret !== configuredSecret) {
          res.status(401).json({ ok: false, error: "unauthorized" });
          return;
        }

        const payload = req.body as TranscriptWebhookPayload;
        if (!payload?.meetingId || !payload?.transcript) {
          res.status(400).json({ ok: false, error: "invalid payload" });
          return;
        }

        const summary = await this.deps.transcriptService.processTranscript(payload);

        await this.app.client.chat.postMessage({
          channel: this.deps.env.SLACK_DEFAULT_CHANNEL,
          text: `Transcript processed: ${summary.title}`,
          blocks: transcriptSummaryBlocks(summary) as any
        });

        res.status(200).json({ ok: true, summaryId: summary.id });
      } catch (error) {
        logger.error("Transcript webhook failed", {
          error: error instanceof Error ? error.message : String(error)
        });
        res.status(500).json({ ok: false, error: "internal error" });
      }
    });

    this.receiver.router.get("/integrations/tactiq/connect", async (req, res) => {
      try {
        const baseUrl = this.resolveBaseUrl(req);
        const redirectUrl = await this.deps.tactiqSyncService.buildConnectUrl(baseUrl);
        res.redirect(302, redirectUrl);
      } catch (error) {
        logger.error("Failed to start Tactiq OAuth", {
          error: error instanceof Error ? error.message : String(error)
        });
        res.status(500).json({ ok: false, error: "failed to start tactiq oauth" });
      }
    });

    this.receiver.router.get("/integrations/tactiq/callback", async (req, res) => {
      try {
        const code = typeof req.query.code === "string" ? req.query.code : "";
        const state = typeof req.query.state === "string" ? req.query.state : "";
        if (!code || !state) {
          res.status(400).send("Missing OAuth callback parameters.");
          return;
        }

        const baseUrl = this.resolveBaseUrl(req);
        await this.deps.tactiqSyncService.completeOAuth(baseUrl, code, state);

        await this.app.client.chat.postMessage({
          channel: this.deps.env.SLACK_DEFAULT_CHANNEL,
          text: "Tactiq MCP connected successfully. Use /ops-sync-tactiq to import transcripts."
        });

        res.status(200).send("Tactiq connected successfully. You can close this tab.");
      } catch (error) {
        logger.error("Tactiq OAuth callback failed", {
          error: error instanceof Error ? error.message : String(error)
        });
        res.status(500).send("Tactiq OAuth failed. Check server logs.");
      }
    });
  }

  private registerSlackHandlers(): void {
    this.app.command("/ops-digest", async ({ ack, command, client }) => {
      await ack();
      try {
        await this.postDigest(command.channel_id);

        await client.chat.postEphemeral({
          channel: command.channel_id,
          user: command.user_id,
          text: "Digest completed and posted to channel."
        });
      } catch (error) {
        logger.error("/ops-digest failed", {
          error: error instanceof Error ? error.message : String(error)
        });

        await client.chat.postEphemeral({
          channel: command.channel_id,
          user: command.user_id,
          text: "Digest failed. Check service logs for details."
        });
      }
    });

    this.app.command("/ops-next", async ({ ack, command, client }) => {
      await ack();
      try {
        const events = await this.deps.calendarService.getUpcomingWithContext();
        await client.chat.postMessage({
          channel: command.channel_id,
          text: "Upcoming meetings",
          blocks: calendarBlocks(events) as any
        });
      } catch (error) {
        logger.error("/ops-next failed", {
          error: error instanceof Error ? error.message : String(error)
        });

        await client.chat.postEphemeral({
          channel: command.channel_id,
          user: command.user_id,
          text: "Could not fetch upcoming meetings."
        });
      }
    });

    this.app.command("/ops-sync-tactiq", async ({ ack, command, client }) => {
      await ack();
      try {
        const result = await this.deps.tactiqSyncService.syncRecent(10);
        await client.chat.postMessage({
          channel: command.channel_id,
          text: [
            "Tactiq sync completed.",
            `Discovered: ${result.discovered}`,
            `Processed: ${result.processed}`,
            `Skipped: ${result.skipped}`,
            `Tools: ${result.toolNames.join(", ") || "none"}`
          ].join("\n")
        });
      } catch (error) {
        const connectUrl = this.deps.env.APP_BASE_URL
          ? `${this.deps.env.APP_BASE_URL.replace(/\/$/, "")}/integrations/tactiq/connect`
          : "/integrations/tactiq/connect";
        logger.error("/ops-sync-tactiq failed", {
          error: error instanceof Error ? error.message : String(error)
        });

        await client.chat.postEphemeral({
          channel: command.channel_id,
          user: command.user_id,
          text: `Tactiq sync failed. Connect OAuth first: ${connectUrl}`
        });
      }
    });

    this.app.action("approve_draft", async ({ ack, body, action, client }) => {
      await ack();

      const draftId = action.type === "button" ? action.value : "";
      if (!draftId) {
        return;
      }

      try {
        await this.deps.emailService.approveAndSendDraft(draftId, body.user.id);

        const channelId = body.channel?.id ?? this.deps.env.SLACK_DEFAULT_CHANNEL;
        await client.chat.postEphemeral({
          channel: channelId,
          user: body.user.id,
          text: `Draft ${draftId} approved and sent.`
        });
      } catch (error) {
        logger.error("approve_draft failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    });

    this.app.action("reject_draft", async ({ ack, body, action, client }) => {
      await ack();

      const draftId = action.type === "button" ? action.value : "";
      if (!draftId) {
        return;
      }

      try {
        await this.deps.emailService.rejectDraft(draftId);

        const channelId = body.channel?.id ?? this.deps.env.SLACK_DEFAULT_CHANNEL;
        await client.chat.postEphemeral({
          channel: channelId,
          user: body.user.id,
          text: `Draft ${draftId} rejected.`
        });
      } catch (error) {
        logger.error("reject_draft failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    });

    this.app.action("edit_draft", async ({ ack, body, action, client }) => {
      await ack();

      const draftId = action.type === "button" ? action.value : "";
      if (!draftId) {
        return;
      }

      const draft = this.deps.emailService.getDraftById(draftId);
      const initialValue = draft?.body ?? "";
      const triggerId = (body as { trigger_id?: string }).trigger_id;
      if (!triggerId) {
        return;
      }

      await client.views.open({
        trigger_id: triggerId,
        view: {
          type: "modal",
          callback_id: "edit_draft_modal",
          private_metadata: draftId,
          title: {
            type: "plain_text",
            text: "Edit Draft"
          },
          submit: {
            type: "plain_text",
            text: "Save"
          },
          close: {
            type: "plain_text",
            text: "Cancel"
          },
          blocks: [
            {
              type: "input",
              block_id: "draft_body_block",
              label: {
                type: "plain_text",
                text: "Draft body"
              },
              element: {
                type: "plain_text_input",
                multiline: true,
                action_id: "draft_body_action",
                initial_value: initialValue
              }
            }
          ]
        }
      });
    });

    this.app.view("edit_draft_modal", async ({ ack, body, client, view }) => {
      await ack();

      const draftId = view.private_metadata;
      const stateValue = view.state.values?.draft_body_block?.draft_body_action?.value;
      if (!draftId || !stateValue) {
        return;
      }

      try {
        await this.deps.emailService.editDraft(draftId, stateValue);
        await client.chat.postMessage({
          channel: this.deps.env.SLACK_DEFAULT_CHANNEL,
          text: `Draft ${draftId} updated and returned to pending approval.`
        });

        await client.chat.postEphemeral({
          channel: this.deps.env.SLACK_DEFAULT_CHANNEL,
          user: body.user.id,
          text: `Draft ${draftId} saved.`
        });
      } catch (error) {
        logger.error("edit_draft_modal failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    });
  }

  private resolveBaseUrl(req: { protocol?: string; get?: (name: string) => string | undefined; headers?: Record<string, unknown> }): string {
    if (this.deps.env.APP_BASE_URL) {
      return this.deps.env.APP_BASE_URL.replace(/\/$/, "");
    }

    const protocol = req.protocol ?? "https";
    const hostFromGet = req.get ? req.get("host") : undefined;
    const host = hostFromGet ?? (typeof req.headers?.host === "string" ? req.headers.host : "");
    if (!host) {
      throw new Error("Unable to resolve base URL. Set APP_BASE_URL.");
    }

    return `${protocol}://${host}`.replace(/\/$/, "");
  }
}
