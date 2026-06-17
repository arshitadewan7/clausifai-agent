import { v4 as uuidv4 } from "uuid";

import type { SupabaseMemoryClient } from "../clients/supabaseClient";
import type {
  ActionItem,
  DraftReply,
  DraftStatus,
  EmailThread,
  EmailTriage,
  MeetingSummary
} from "../types/domain";

export class MemoryStore {
  private readonly threads = new Map<string, EmailThread>();
  private readonly triage = new Map<string, EmailTriage>();
  private readonly drafts = new Map<string, DraftReply>();
  private readonly meetings = new Map<string, MeetingSummary>();
  private readonly actions = new Map<string, ActionItem>();

  constructor(private readonly supabase: SupabaseMemoryClient) {}

  async saveEmailTriage(thread: EmailThread, triage: EmailTriage): Promise<void> {
    this.threads.set(thread.id, thread);
    this.triage.set(thread.id, triage);
    await this.supabase.upsertEmailTriage(thread, triage);
  }

  createDraft(threadId: string, body: string): DraftReply {
    const now = new Date().toISOString();
    const draft: DraftReply = {
      id: uuidv4(),
      threadId,
      body,
      status: "pending_approval",
      createdAt: now,
      updatedAt: now
    };
    this.drafts.set(draft.id, draft);
    void this.supabase.upsertDraft(draft);
    return draft;
  }

  getThread(threadId: string): EmailThread | undefined {
    return this.threads.get(threadId);
  }

  getTriage(threadId: string): EmailTriage | undefined {
    return this.triage.get(threadId);
  }

  getDraft(draftId: string): DraftReply | undefined {
    return this.drafts.get(draftId);
  }

  listPendingDrafts(): DraftReply[] {
    return [...this.drafts.values()].filter((draft) => draft.status === "pending_approval");
  }

  async updateDraft(
    draftId: string,
    updates: Partial<Pick<DraftReply, "body" | "approvedBy" | "sentAt">> & { status?: DraftStatus }
  ): Promise<DraftReply | undefined> {
    const current = this.drafts.get(draftId);
    if (!current) {
      return undefined;
    }

    const next: DraftReply = {
      ...current,
      ...updates,
      updatedAt: new Date().toISOString(),
      status: updates.status ?? current.status
    };

    this.drafts.set(draftId, next);
    await this.supabase.upsertDraft(next);
    return next;
  }

  async saveMeetingSummary(summary: MeetingSummary): Promise<void> {
    this.meetings.set(summary.id, summary);
    await this.supabase.upsertMeetingSummary(summary);
  }

  async addActionItems(summaryId: string, items: Array<{ owner: string; task: string }>): Promise<ActionItem[]> {
    const created = items.map((item) => {
      const action: ActionItem = {
        id: uuidv4(),
        summaryId,
        owner: item.owner,
        task: item.task,
        status: "open"
      };
      this.actions.set(action.id, action);
      return action;
    });

    await this.supabase.insertActionItems(summaryId, items);
    return created;
  }

  latestMeetingByParticipant(participant: string): MeetingSummary | undefined {
    const lower = participant.toLowerCase();
    const meetings = [...this.meetings.values()]
      .filter((meeting) => meeting.participants.some((name) => name.toLowerCase().includes(lower)))
      .sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime());

    return meetings[0];
  }
}
