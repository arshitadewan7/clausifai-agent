import type { TactiqMcpClient } from "../clients/tactiqMcpClient";
import { logger } from "../lib/logger";
import type { MeetingSummary } from "../types/domain";
import type { IntegrationStateStore } from "./integrationStateStore";
import type { TranscriptService } from "./transcriptService";

interface ProcessedState extends Record<string, unknown> {
  ids: string[];
  updatedAt: string;
}

export class TactiqSyncService {
  constructor(
    private readonly tactiqClient: TactiqMcpClient,
    private readonly transcriptService: TranscriptService,
    private readonly stateStore: IntegrationStateStore
  ) {}

  async buildConnectUrl(baseUrl: string): Promise<string> {
    return this.tactiqClient.buildAuthorizationUrl(baseUrl);
  }

  async completeOAuth(baseUrl: string, code: string, state: string): Promise<void> {
    await this.tactiqClient.handleAuthorizationCallback(baseUrl, code, state);
  }

  async syncRecent(limit = 10): Promise<{
    discovered: number;
    processed: number;
    skipped: number;
    summaries: MeetingSummary[];
    toolNames: string[];
  }> {
    const syncResult = await this.tactiqClient.syncRecentTranscripts(limit);
    const processedIds = await this.getProcessedMeetingIds();
    const summaries: MeetingSummary[] = [];

    for (const transcript of syncResult.transcripts) {
      if (processedIds.has(transcript.meetingId)) {
        continue;
      }

      try {
        const summary = await this.transcriptService.processTranscript(transcript);
        summaries.push(summary);
        processedIds.add(transcript.meetingId);
      } catch (error) {
        logger.warn("Failed to process Tactiq transcript", {
          meetingId: transcript.meetingId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    await this.saveProcessedMeetingIds(processedIds);

    const skipped = Math.max(syncResult.discovered - summaries.length, 0);

    logger.info("Tactiq sync completed", {
      discovered: syncResult.discovered,
      processed: summaries.length,
      skipped,
      toolCount: syncResult.toolNames.length
    });

    return {
      discovered: syncResult.discovered,
      processed: summaries.length,
      skipped,
      summaries,
      toolNames: syncResult.toolNames
    };
  }

  private async getProcessedMeetingIds(): Promise<Set<string>> {
    const state = await this.stateStore.get<ProcessedState>("tactiq_processed_meetings");
    const ids = Array.isArray(state?.ids) ? state.ids : [];
    return new Set(ids.filter((id) => typeof id === "string"));
  }

  private async saveProcessedMeetingIds(ids: Set<string>): Promise<void> {
    const limited = [...ids].slice(-1000);
    await this.stateStore.set("tactiq_processed_meetings", {
      ids: limited,
      updatedAt: new Date().toISOString()
    });
  }
}
