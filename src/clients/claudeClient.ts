import Anthropic from "@anthropic-ai/sdk";

import type { Env } from "../config/env";
import type { EmailThread, EmailTriage, MeetingSummary, TranscriptWebhookPayload } from "../types/domain";

interface MeetingSummaryLLM {
  summary: string;
  decisions: string[];
  openQuestions: string[];
  actionItems: Array<{ owner: string; task: string }>;
}

export class ClaudeClient {
  private readonly anthropic: Anthropic | null;

  constructor(private readonly env: Env) {
    this.anthropic = env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }) : null;
  }

  async triageEmail(thread: EmailThread): Promise<EmailTriage> {
    if (!this.anthropic) {
      return this.mockTriage(thread);
    }

    const prompt = `You are an executive operations assistant.\nReturn strict JSON with keys: summary, requestedAction, urgency(low|medium|high), needsReply(boolean), proposedNextStep.\n\nEmail:\nFrom: ${thread.from}\nSubject: ${thread.subject}\nSnippet: ${thread.snippet}`;

    const content = await this.runTextPrompt(prompt);
    try {
      const parsed = JSON.parse(content) as EmailTriage;
      return parsed;
    } catch {
      return this.mockTriage(thread);
    }
  }

  async draftReply(thread: EmailThread, triage: EmailTriage): Promise<string> {
    if (!this.anthropic) {
      return `Hi ${thread.from.split("@")[0]},\n\nThanks for the note. ${triage.proposedNextStep}.\n\nBest,\nArshita`;
    }

    const prompt = [
      "Draft a concise professional reply in a founder/operator voice.",
      "Output plain email body only.",
      `From: ${thread.from}`,
      `Subject: ${thread.subject}`,
      `Summary: ${triage.summary}`,
      `Requested action: ${triage.requestedAction}`,
      `Proposed next step: ${triage.proposedNextStep}`
    ].join("\n");

    return this.runTextPrompt(prompt);
  }

  async summarizeTranscript(payload: TranscriptWebhookPayload): Promise<MeetingSummaryLLM> {
    if (!this.anthropic) {
      return {
        summary: `Summary for ${payload.title}: discussed goals, timelines, and owners.`,
        decisions: ["Share revised deck by Friday"],
        openQuestions: ["Final budget owner confirmation"],
        actionItems: [{ owner: "Unassigned", task: "Confirm next meeting time" }]
      };
    }

    const prompt = [
      "Summarize this transcript in strict JSON.",
      "Keys: summary(string), decisions(string[]), openQuestions(string[]), actionItems([{owner,task}]).",
      `Title: ${payload.title}`,
      `Participants: ${payload.participants.join(", ")}`,
      `Occurred At: ${payload.occurredAt}`,
      "Transcript:",
      payload.transcript
    ].join("\n");

    const content = await this.runTextPrompt(prompt);
    try {
      return JSON.parse(content) as MeetingSummaryLLM;
    } catch {
      return {
        summary: `Transcript processed for ${payload.title}.`,
        decisions: [],
        openQuestions: [],
        actionItems: []
      };
    }
  }

  private async runTextPrompt(prompt: string): Promise<string> {
    if (!this.anthropic) {
      return "";
    }

    const response = await this.anthropic.messages.create({
      model: this.env.CLAUDE_MODEL,
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }]
    });

    const block = response.content.find((item) => item.type === "text");
    return block && "text" in block ? block.text.trim() : "";
  }

  private mockTriage(thread: EmailThread): EmailTriage {
    const lower = `${thread.subject} ${thread.snippet}`.toLowerCase();
    const urgent = lower.includes("today") || lower.includes("urgent") || lower.includes("asap");
    const needsReply = !lower.includes("fyi");

    return {
      summary: `Email from ${thread.from} about ${thread.subject}.`,
      requestedAction: needsReply ? "Respond with next steps" : "No response required",
      urgency: urgent ? "high" : "medium",
      needsReply,
      proposedNextStep: needsReply
        ? "Acknowledge and share timing for a detailed follow-up"
        : "Log context in memory"
    };
  }
}
