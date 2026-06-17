import { google, drive_v3 } from "googleapis";

import type { Env } from "../config/env";
import { createGoogleOauthClient } from "./googleAuth";

export class DriveClient {
  private readonly drive: drive_v3.Drive | null;

  constructor(env: Env) {
    const auth = createGoogleOauthClient(env);
    this.drive = auth ? google.drive({ version: "v3", auth }) : null;
  }

  async saveMeetingSummary(title: string, content: string): Promise<string> {
    if (!this.drive) {
      return `https://drive.google.com/mock/${encodeURIComponent(title)}`;
    }

    const file = await this.drive.files.create({
      requestBody: {
        name: `${title} - Summary.txt`,
        mimeType: "text/plain"
      },
      media: {
        mimeType: "text/plain",
        body: content
      }
    });

    const fileId = file.data.id;
    if (!fileId) {
      return "https://drive.google.com";
    }

    await this.drive.permissions.create({
      fileId,
      requestBody: {
        role: "reader",
        type: "anyone"
      }
    });

    return `https://drive.google.com/file/d/${fileId}/view`;
  }
}
