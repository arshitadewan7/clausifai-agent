import { App, ExpressReceiver } from "@slack/bolt";
import express from "express";

import type { Env } from "../config/env";
import { logger } from "../lib/logger";
import type { TranscriptWebhookPayload } from "../types/domain";
import type { CalendarService } from "../services/calendarService";
import type { EmailService } from "../services/emailService";
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
  }

  private registerSlackHandlers(): void {
    this.app.command("/ops-digest", async ({ ack, command, client }) => {
      await ack();
      await this.postDigest(command.channel_id);

      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: "Digest completed and posted to channel."
      });
    });

    this.app.command("/ops-next", async ({ ack, command, client }) => {
      await ack();

      const events = await this.deps.calendarService.getUpcomingWithContext();
      await client.chat.postMessage({
        channel: command.channel_id,
        text: "Upcoming meetings",
        blocks: calendarBlocks(events) as any
      });
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

      await this.deps.emailService.rejectDraft(draftId);

      const channelId = body.channel?.id ?? this.deps.env.SLACK_DEFAULT_CHANNEL;
      await client.chat.postEphemeral({
        channel: channelId,
        user: body.user.id,
        text: `Draft ${draftId} rejected.`
      });
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
    });
  }
}
