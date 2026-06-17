import { v4 as uuidv4 } from "uuid";

import type { ClaudeClient } from "../clients/claudeClient";
import type { DriveClient } from "../clients/driveClient";
import type { MeetingSummary, TranscriptWebhookPayload } from "../types/domain";
import type { MemoryStore } from "./memoryStore";

export class TranscriptService {
  constructor(
    private readonly claudeClient: ClaudeClient,
    private readonly driveClient: DriveClient,
    private readonly memory: MemoryStore
  ) {}

  async processTranscript(payload: TranscriptWebhookPayload): Promise<MeetingSummary> {
    const llmSummary = await this.claudeClient.summarizeTranscript(payload);

    const docBody = [
      `Meeting: ${payload.title}`,
      `Occurred: ${payload.occurredAt}`,
      `Participants: ${payload.participants.join(", ")}`,
      "",
      "Summary:",
      llmSummary.summary,
      "",
      "Decisions:",
      ...llmSummary.decisions.map((d) => `- ${d}`),
      "",
      "Open Questions:",
      ...llmSummary.openQuestions.map((q) => `- ${q}`)
    ].join("\n");

    const driveUrl = await this.driveClient.saveMeetingSummary(payload.title, docBody);

    const summary: MeetingSummary = {
      id: uuidv4(),
      meetingId: payload.meetingId,
      title: payload.title,
      summary: llmSummary.summary,
      decisions: llmSummary.decisions,
      openQuestions: llmSummary.openQuestions,
      driveUrl,
      participants: payload.participants,
      occurredAt: payload.occurredAt,
      createdAt: new Date().toISOString()
    };

    await this.memory.saveMeetingSummary(summary);
    await this.memory.addActionItems(summary.id, llmSummary.actionItems);

    return summary;
  }
}
