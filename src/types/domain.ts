export type Priority = "low" | "medium" | "high";

export interface EmailThread {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  receivedAt: string;
}

export interface EmailTriage {
  summary: string;
  requestedAction: string;
  urgency: Priority;
  needsReply: boolean;
  proposedNextStep: string;
}

export type DraftStatus = "pending_approval" | "approved" | "rejected" | "sent";

export interface DraftReply {
  id: string;
  threadId: string;
  body: string;
  status: DraftStatus;
  createdAt: string;
  updatedAt: string;
  approvedBy?: string;
  sentAt?: string;
}

export interface DigestItem {
  thread: EmailThread;
  triage: EmailTriage;
  draft?: DraftReply;
}

export interface DigestResult {
  generatedAt: string;
  items: DigestItem[];
}

export interface CalendarEvent {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  attendees: string[];
  notes?: string;
}

export interface TranscriptWebhookPayload {
  source: "otter" | "fireflies" | "fathom" | "unknown";
  meetingId: string;
  title: string;
  participants: string[];
  occurredAt: string;
  transcript: string;
}

export interface MeetingSummary {
  id: string;
  meetingId: string;
  title: string;
  summary: string;
  decisions: string[];
  openQuestions: string[];
  driveUrl: string;
  participants: string[];
  occurredAt: string;
  createdAt: string;
}

export interface ActionItem {
  id: string;
  summaryId: string;
  owner: string;
  task: string;
  status: "open" | "closed";
}
