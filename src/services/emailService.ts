import type { ClaudeClient } from "../clients/claudeClient";
import type { GmailClient } from "../clients/gmailClient";
import { isLikelyBulkOrAutomated } from "../lib/emailUtils";
import { logger } from "../lib/logger";
import type { DigestResult, DraftReply } from "../types/domain";
import type { MemoryStore } from "./memoryStore";

export class EmailService {
  constructor(
    private readonly gmailClient: GmailClient,
    private readonly claudeClient: ClaudeClient,
    private readonly memory: MemoryStore
  ) {}

  async buildDigest(limit = 10): Promise<DigestResult> {
    const threads = await this.gmailClient.fetchUnreadOrFlaggedThreads(limit);
    const items: DigestResult["items"] = [];

    for (const thread of threads) {
      let triage = await this.claudeClient.triageEmail(thread);
      const isBulk = isLikelyBulkOrAutomated(thread);

      if (isBulk && triage.needsReply) {
        triage = {
          ...triage,
          needsReply: false,
          requestedAction: "No response required (bulk or automated sender)",
          proposedNextStep: "Archive, label, or review later for context"
        };
      }

      await this.memory.saveEmailTriage(thread, triage);

      const item: DigestResult["items"][number] = { thread, triage };
      const shouldDraft = triage.needsReply && !isBulk;

      if (shouldDraft) {
        const draftBody = await this.claudeClient.draftReply(thread, triage);
        const draft = this.memory.createDraft(thread.id, draftBody);
        item.draft = draft;
      }

      items.push(item);
    }

    return {
      generatedAt: new Date().toISOString(),
      items
    };
  }

  async approveAndSendDraft(draftId: string, approverId: string): Promise<DraftReply> {
    const draft = this.memory.getDraft(draftId);
    if (!draft) {
      throw new Error("Draft not found");
    }

    if (draft.status !== "pending_approval") {
      throw new Error(`Draft is not pending approval (status=${draft.status})`);
    }

    const thread = this.memory.getThread(draft.threadId);
    if (!thread) {
      throw new Error("Original email thread not found");
    }

    await this.memory.updateDraft(draft.id, { status: "approved", approvedBy: approverId });
    const sent = await this.gmailClient.sendDraftReply(thread, draft.body);

    const updated = await this.memory.updateDraft(draft.id, {
      status: "sent",
      sentAt: new Date().toISOString()
    });

    if (!updated) {
      throw new Error("Failed to update draft status after send");
    }

    logger.info("Draft sent", {
      draftId,
      approverId,
      gmailMessageId: sent.messageId
    });

    return updated;
  }

  async rejectDraft(draftId: string): Promise<DraftReply> {
    const updated = await this.memory.updateDraft(draftId, { status: "rejected" });
    if (!updated) {
      throw new Error("Draft not found");
    }
    return updated;
  }

  async editDraft(draftId: string, body: string): Promise<DraftReply> {
    const updated = await this.memory.updateDraft(draftId, { body, status: "pending_approval" });
    if (!updated) {
      throw new Error("Draft not found");
    }
    return updated;
  }

  getDraftById(draftId: string): DraftReply | undefined {
    return this.memory.getDraft(draftId);
  }
}
