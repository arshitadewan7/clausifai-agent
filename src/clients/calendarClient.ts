import { google, calendar_v3 } from "googleapis";

import type { Env } from "../config/env";
import type { CalendarEvent } from "../types/domain";
import { createGoogleOauthClient } from "./googleAuth";

export class CalendarClient {
  private readonly calendar: calendar_v3.Calendar | null;

  constructor(env: Env) {
    const auth = createGoogleOauthClient(env);
    this.calendar = auth ? google.calendar({ version: "v3", auth }) : null;
  }

  async listUpcomingEvents(limit = 5): Promise<CalendarEvent[]> {
    if (!this.calendar) {
      const now = new Date();
      const firstStart = new Date(now.getTime() + 45 * 60 * 1000);
      const firstEnd = new Date(firstStart.getTime() + 30 * 60 * 1000);
      return [
        {
          id: "mock-event-1",
          title: "Investor sync - Joel",
          startsAt: firstStart.toISOString(),
          endsAt: firstEnd.toISOString(),
          attendees: ["joel@fund.com"],
          notes: "Follow up on allocation and updated metrics deck"
        }
      ];
    }

    const response = await this.calendar.events.list({
      calendarId: "primary",
      timeMin: new Date().toISOString(),
      maxResults: limit,
      singleEvents: true,
      orderBy: "startTime"
    });

    return (response.data.items ?? []).map((event) => ({
      id: event.id ?? "",
      title: event.summary ?? "(untitled)",
      startsAt: event.start?.dateTime ?? event.start?.date ?? new Date().toISOString(),
      endsAt: event.end?.dateTime ?? event.end?.date ?? new Date().toISOString(),
      attendees: (event.attendees ?? []).map((a) => a.email ?? "unknown"),
      notes: event.description ?? undefined
    }));
  }
}
