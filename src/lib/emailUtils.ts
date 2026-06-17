import type { EmailThread } from "../types/domain";

const BULK_LOCAL_PART_MARKERS = [
  "no-reply",
  "noreply",
  "do-not-reply",
  "donotreply",
  "mailer-daemon",
  "bounce",
  "notification",
  "notifications",
  "newsletter",
  "news",
  "updates",
  "digest",
  "announce",
  "announcement",
  "marketing",
  "promo"
];

const BULK_DOMAIN_MARKERS = [
  "send.calendly.com",
  "substack.com",
  "mailchimp",
  "sendgrid",
  "updates.linear.app",
  "notifications."
];

const BULK_SUBJECT_MARKERS = [
  "unsubscribe",
  "newsletter",
  "digest",
  "we've just shipped",
  "updates to",
  "new messages from",
  "keep everything in one place",
  "which plan is right for you"
];

const BULK_BODY_MARKERS = ["unsubscribe", "manage preferences", "view in browser"];

export function extractEmailAddress(fromHeader: string): string {
  const angleMatch = fromHeader.match(/<([^>]+)>/);
  if (angleMatch?.[1]) {
    return angleMatch[1].trim().toLowerCase();
  }

  const plainMatch = fromHeader.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  if (plainMatch?.[0]) {
    return plainMatch[0].toLowerCase();
  }

  return fromHeader.trim().toLowerCase();
}

export function extractSenderDisplayName(fromHeader: string): string {
  const trimmed = fromHeader.trim();
  const namedSenderMatch = trimmed.match(/^"?([^"<]+?)"?\s*<[^>]+>$/);

  if (namedSenderMatch?.[1]) {
    const cleanedName = namedSenderMatch[1].replace(/\s+/g, " ").trim();
    if (cleanedName.length > 0) {
      return cleanedName;
    }
  }

  const email = extractEmailAddress(trimmed);
  const localPart = email.split("@")[0] ?? "";
  const normalized = localPart
    .replace(/[._-]+/g, " ")
    .replace(/\d+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return "there";
  }

  return normalized
    .split(" ")
    .map((word) => (word.length > 0 ? word[0].toUpperCase() + word.slice(1) : word))
    .join(" ");
}

export function isLikelyBulkOrAutomated(thread: Pick<EmailThread, "from" | "subject" | "snippet">): boolean {
  const fromEmail = extractEmailAddress(thread.from);
  const localPart = fromEmail.split("@")[0] ?? "";
  const domain = fromEmail.split("@")[1] ?? "";

  const subject = thread.subject.toLowerCase();
  const snippet = thread.snippet.toLowerCase();

  const localPartBulk = BULK_LOCAL_PART_MARKERS.some((marker) => localPart.includes(marker));
  const domainBulk = BULK_DOMAIN_MARKERS.some((marker) => domain.includes(marker));
  const subjectBulk = BULK_SUBJECT_MARKERS.some((marker) => subject.includes(marker));
  const bodyBulk = BULK_BODY_MARKERS.some((marker) => snippet.includes(marker));

  return localPartBulk || domainBulk || subjectBulk || bodyBulk;
}
