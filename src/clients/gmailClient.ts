import { google, gmail_v1 } from "googleapis";

import type { Env } from "../config/env";
import { logger } from "../lib/logger";
import type { EmailThread } from "../types/domain";
import { createGoogleOauthClient } from "./googleAuth";

export class GmailClient {
  private readonly gmail: gmail_v1.Gmail | null;

  constructor(private readonly env: Env) {
    const auth = createGoogleOauthClient(env);
    this.gmail = auth ? google.gmail({ version: "v1", auth }) : null;
  }

  async fetchUnreadOrFlaggedThreads(limit = 10): Promise<EmailThread[]> {
    if (!this.gmail) {
      return [
        {
          id: "mock-thread-1",
          from: "joel@fund.com",
          subject: "Quick follow-up on round timing",
          snippet: "Can we sync this week on allocation details and timeline?",
          receivedAt: new Date().toISOString()
        },
        {
          id: "mock-thread-2",
          from: "saron@partner.com",
          subject: "Need revised MSA language",
          snippet: "Can legal share the updated indemnity paragraph today?",
          receivedAt: new Date().toISOString()
        }
      ];
    }

    const list = await this.gmail.users.messages.list({
      userId: "me",
      maxResults: limit,
      q: "(is:unread OR is:starred) newer_than:14d"
    });

    const messages = list.data.messages ?? [];
    const threads: EmailThread[] = [];

    for (const message of messages) {
      if (!message.id) {
        continue;
      }

      const details = await this.gmail.users.messages.get({
        userId: "me",
        id: message.id,
        format: "metadata",
        metadataHeaders: ["From", "Subject", "Date"]
      });

      const headers = details.data.payload?.headers ?? [];
      const from = headers.find((h) => h.name?.toLowerCase() === "from")?.value ?? "unknown";
      const subject = headers.find((h) => h.name?.toLowerCase() === "subject")?.value ?? "(no subject)";
      const receivedAt = headers.find((h) => h.name?.toLowerCase() === "date")?.value ?? new Date().toISOString();

      threads.push({
        id: details.data.threadId ?? message.id,
        from,
        subject,
        snippet: details.data.snippet ?? "",
        receivedAt: new Date(receivedAt).toISOString()
      });
    }

    return threads;
  }

  async sendDraftReply(thread: EmailThread, body: string): Promise<{ messageId: string }> {
    if (!this.gmail) {
      logger.info("Mock send: outbound email blocked to dry-run mode", {
        threadId: thread.id,
        subject: thread.subject
      });
      return { messageId: `mock-sent-${thread.id}` };
    }

    const raw = this.buildRawEmail(thread, body);
    const response = await this.gmail.users.messages.send({
      userId: "me",
      requestBody: {
        raw,
        threadId: thread.id
      }
    });

    return { messageId: response.data.id ?? `sent-${thread.id}` };
  }

  private buildRawEmail(thread: EmailThread, body: string): string {
    const toHeader = thread.from;
    const subject = thread.subject.toLowerCase().startsWith("re:")
      ? thread.subject
      : `Re: ${thread.subject}`;

    const message = [
      `To: ${toHeader}`,
      `Subject: ${subject}`,
      "Content-Type: text/plain; charset=utf-8",
      "MIME-Version: 1.0",
      "",
      body
    ].join("\n");

    return Buffer.from(message)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }
}
