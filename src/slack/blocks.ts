import type { DigestResult, DraftReply, EmailThread, EmailTriage, MeetingSummary } from "../types/domain";

export function digestOverviewBlocks(digest: DigestResult): Array<Record<string, unknown>> {
  const highUrgencyCount = digest.items.filter((item) => item.triage.urgency === "high").length;
  const replyCount = digest.items.filter((item) => item.triage.needsReply).length;

  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "clausifai-agent: Email Digest"
      }
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `*Generated:* ${new Date(digest.generatedAt).toLocaleString()}`,
          `*Threads reviewed:* ${digest.items.length}`,
          `*Needs reply:* ${replyCount}`,
          `*High urgency:* ${highUrgencyCount}`
        ].join("\n")
      }
    }
  ];
}

export function digestItemBlocks(
  thread: EmailThread,
  triage: EmailTriage,
  draft?: DraftReply
): Array<Record<string, unknown>> {
  const lines = [
    `*From:* ${thread.from}`,
    `*Subject:* ${thread.subject}`,
    `*Urgency:* ${triage.urgency}`,
    `*Summary:* ${triage.summary}`,
    `*Requested Action:* ${triage.requestedAction}`,
    `*Proposed Next Step:* ${triage.proposedNextStep}`
  ];

  if (!draft) {
    lines.push("*Reply:* Not required");
  } else {
    lines.push(`*Draft ID:* ${draft.id}`);
  }

  const blocks: Array<Record<string, unknown>> = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: lines.join("\n")
      }
    }
  ];

  if (draft) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Proposed Reply*\n\n${draft.body}`
      }
    });

    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          style: "primary",
          text: {
            type: "plain_text",
            text: "Approve"
          },
          action_id: "approve_draft",
          value: draft.id
        },
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "Edit"
          },
          action_id: "edit_draft",
          value: draft.id
        },
        {
          type: "button",
          style: "danger",
          text: {
            type: "plain_text",
            text: "Reject"
          },
          action_id: "reject_draft",
          value: draft.id
        }
      ]
    });
  }

  blocks.push({ type: "divider" });
  return blocks;
}

export function calendarBlocks(
  events: Array<{
    title: string;
    startsAt: string;
    endsAt: string;
    attendees: string[];
    priorContext?: string;
  }>
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [
    {
      type: "header",
      text: { type: "plain_text", text: "Upcoming Meetings" }
    }
  ];

  for (const event of events) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `*${event.title}*`,
          `${new Date(event.startsAt).toLocaleString()} - ${new Date(event.endsAt).toLocaleTimeString()}`,
          `Attendees: ${event.attendees.join(", ") || "N/A"}`,
          `Context: ${event.priorContext ?? "N/A"}`
        ].join("\n")
      }
    });
  }

  return blocks;
}

export function transcriptSummaryBlocks(summary: MeetingSummary): Array<Record<string, unknown>> {
  return [
    {
      type: "header",
      text: { type: "plain_text", text: `Meeting Summary: ${summary.title}` }
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `*Summary:* ${summary.summary}`,
          `*Decisions:* ${summary.decisions.length ? summary.decisions.join("; ") : "None"}`,
          `*Open Questions:* ${summary.openQuestions.length ? summary.openQuestions.join("; ") : "None"}`,
          `*Doc:* ${summary.driveUrl}`
        ].join("\n")
      }
    }
  ];
}
