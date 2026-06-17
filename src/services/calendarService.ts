import type { CalendarClient } from "../clients/calendarClient";
import type { CalendarEvent } from "../types/domain";
import type { MemoryStore } from "./memoryStore";

export class CalendarService {
  constructor(
    private readonly calendarClient: CalendarClient,
    private readonly memory: MemoryStore
  ) {}

  async getUpcomingWithContext(limit = 5): Promise<Array<CalendarEvent & { priorContext?: string }>> {
    const events = await this.calendarClient.listUpcomingEvents(limit);

    return events.map((event) => {
      const participant = event.attendees[0] ?? "";
      const previous = participant ? this.memory.latestMeetingByParticipant(participant) : undefined;

      return {
        ...event,
        priorContext: previous
          ? `Last discussed: ${previous.summary}`
          : "No prior meeting notes in memory"
      };
    });
  }
}
