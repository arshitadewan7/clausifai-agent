import { createClient, SupabaseClient } from "@supabase/supabase-js";

import type { Env } from "../config/env";
import { logger } from "../lib/logger";
import type { DraftReply, EmailThread, EmailTriage, MeetingSummary } from "../types/domain";

export class SupabaseMemoryClient {
  private readonly client: SupabaseClient | null;

  constructor(env: Env) {
    this.client = env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY
      ? createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
      : null;
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  async upsertEmailTriage(thread: EmailThread, triage: EmailTriage): Promise<void> {
    if (!this.client) {
      return;
    }

    const { error } = await this.client.from("email_threads").upsert({
      id: thread.id,
      sender: thread.from,
      subject: thread.subject,
      snippet: thread.snippet,
      received_at: thread.receivedAt,
      triage_summary: triage.summary,
      requested_action: triage.requestedAction,
      urgency: triage.urgency,
      needs_reply: triage.needsReply,
      proposed_next_step: triage.proposedNextStep
    });

    if (error) {
      logger.warn("Supabase upsertEmailTriage failed", { error: error.message });
    }
  }

  async upsertDraft(draft: DraftReply): Promise<void> {
    if (!this.client) {
      return;
    }

    const { error } = await this.client.from("draft_replies").upsert({
      id: draft.id,
      thread_id: draft.threadId,
      body: draft.body,
      status: draft.status,
      approved_by: draft.approvedBy ?? null,
      sent_at: draft.sentAt ?? null,
      created_at: draft.createdAt,
      updated_at: draft.updatedAt
    });

    if (error) {
      logger.warn("Supabase upsertDraft failed", { error: error.message });
    }
  }

  async upsertMeetingSummary(summary: MeetingSummary): Promise<void> {
    if (!this.client) {
      return;
    }

    const { error } = await this.client.from("meeting_summaries").upsert({
      id: summary.id,
      meeting_id: summary.meetingId,
      title: summary.title,
      summary: summary.summary,
      decisions: summary.decisions,
      open_questions: summary.openQuestions,
      drive_url: summary.driveUrl,
      participants: summary.participants,
      occurred_at: summary.occurredAt,
      created_at: summary.createdAt
    });

    if (error) {
      logger.warn("Supabase upsertMeetingSummary failed", { error: error.message });
    }
  }

  async insertActionItems(summaryId: string, items: Array<{ owner: string; task: string }>): Promise<void> {
    if (!this.client || items.length === 0) {
      return;
    }

    const { error } = await this.client.from("action_items").insert(
      items.map((item) => ({
        summary_id: summaryId,
        owner: item.owner,
        task: item.task,
        status: "open"
      }))
    );

    if (error) {
      logger.warn("Supabase insertActionItems failed", { error: error.message });
    }
  }

  async getIntegrationState(key: string): Promise<Record<string, unknown> | null> {
    if (!this.client) {
      return null;
    }

    const { data, error } = await this.client
      .from("integration_state")
      .select("data")
      .eq("id", key)
      .maybeSingle();

    if (error) {
      logger.warn("Supabase getIntegrationState failed", { key, error: error.message });
      return null;
    }

    return (data?.data as Record<string, unknown> | undefined) ?? null;
  }

  async upsertIntegrationState(key: string, data: Record<string, unknown>): Promise<void> {
    if (!this.client) {
      return;
    }

    const { error } = await this.client.from("integration_state").upsert({
      id: key,
      data
    });

    if (error) {
      logger.warn("Supabase upsertIntegrationState failed", { key, error: error.message });
    }
  }
}
