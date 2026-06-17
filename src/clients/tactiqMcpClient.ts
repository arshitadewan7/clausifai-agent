import { createHash, randomBytes } from "node:crypto";

import type { Env } from "../config/env";
import { logger } from "../lib/logger";
import type { TranscriptWebhookPayload } from "../types/domain";
import type { IntegrationStateStore } from "../services/integrationStateStore";

interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported?: string[];
}

interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  token_endpoint_auth_methods_supported?: string[];
}

interface OAuthClientRegistration {
  clientId: string;
  clientSecret?: string;
  tokenEndpointAuthMethod: "none" | "client_secret_post";
  redirectUri: string;
  resource: string;
}

interface OAuthTokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
}

interface PendingAuthState {
  state: string;
  codeVerifier: string;
  redirectUri: string;
  createdAt: string;
}

interface JsonRpcResponse<T = unknown> {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface ToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface ResourceDescriptor {
  uri: string;
  name?: string;
  description?: string;
}

interface MeetingCandidate {
  meetingId: string;
  title: string;
  participants: string[];
  occurredAt: string;
  transcript?: string;
}

export class TactiqMcpClient {
  private readonly pendingAuthStates = new Map<string, PendingAuthState>();
  private sessionId?: string;
  private rpcId = 1;

  constructor(
    private readonly env: Env,
    private readonly stateStore: IntegrationStateStore
  ) {}

  async buildAuthorizationUrl(baseUrl: string): Promise<string> {
    const protectedMetadata = await this.fetchProtectedResourceMetadata();
    const authMetadata = await this.fetchAuthorizationServerMetadata(protectedMetadata);
    const redirectUri = this.resolveRedirectUri(baseUrl);
    const clientRegistration = await this.resolveClientRegistration(
      authMetadata,
      redirectUri,
      protectedMetadata.resource
    );

    const state = randomBytes(16).toString("hex");
    const codeVerifier = base64Url(randomBytes(32));
    const codeChallenge = base64Url(createHash("sha256").update(codeVerifier).digest());

    this.pendingAuthStates.set(state, {
      state,
      codeVerifier,
      redirectUri,
      createdAt: new Date().toISOString()
    });

    const url = new URL(authMetadata.authorization_endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientRegistration.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", this.env.TACTIQ_OAUTH_SCOPES);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("resource", clientRegistration.resource);

    return url.toString();
  }

  async handleAuthorizationCallback(baseUrl: string, code: string, state: string): Promise<void> {
    const pending = this.pendingAuthStates.get(state);
    if (!pending) {
      throw new Error("Invalid or expired Tactiq OAuth state");
    }

    this.pendingAuthStates.delete(state);

    const protectedMetadata = await this.fetchProtectedResourceMetadata();
    const authMetadata = await this.fetchAuthorizationServerMetadata(protectedMetadata);
    const clientRegistration = await this.resolveClientRegistration(
      authMetadata,
      this.resolveRedirectUri(baseUrl),
      protectedMetadata.resource
    );

    const tokenResponse = await this.exchangeCodeForToken(authMetadata, clientRegistration, {
      code,
      redirectUri: pending.redirectUri,
      codeVerifier: pending.codeVerifier,
      resource: clientRegistration.resource
    });

    await this.saveTokenSet(tokenResponse);
    logger.info("Tactiq OAuth connected", { hasRefreshToken: Boolean(tokenResponse.refreshToken) });
  }

  async syncRecentTranscripts(limit = 10): Promise<{
    discovered: number;
    processed: number;
    skipped: number;
    transcripts: TranscriptWebhookPayload[];
    toolNames: string[];
  }> {
    await this.ensureSession();

    const tools = await this.listTools();
    const toolNames = tools.map((tool) => tool.name);

    let meetings = await this.fetchMeetingsFromTools(tools, limit);
    if (meetings.length === 0) {
      meetings = await this.fetchMeetingsFromResources(limit);
    }

    const dedupedById = new Map<string, MeetingCandidate>();
    for (const meeting of meetings) {
      if (!dedupedById.has(meeting.meetingId)) {
        dedupedById.set(meeting.meetingId, meeting);
      }
    }

    const distinct = [...dedupedById.values()].slice(0, limit);
    const payloads = distinct
      .filter((meeting) => typeof meeting.transcript === "string" && meeting.transcript.trim().length > 40)
      .map((meeting) => ({
        source: "tactiq" as const,
        meetingId: meeting.meetingId,
        title: meeting.title,
        participants: meeting.participants,
        occurredAt: meeting.occurredAt,
        transcript: meeting.transcript!.trim()
      }));

    return {
      discovered: distinct.length,
      processed: payloads.length,
      skipped: Math.max(distinct.length - payloads.length, 0),
      transcripts: payloads,
      toolNames
    };
  }

  private async fetchMeetingsFromTools(tools: ToolDescriptor[], limit: number): Promise<MeetingCandidate[]> {
    const listToolCandidates = tools.filter((tool) => {
      const label = `${tool.name} ${tool.description ?? ""}`.toLowerCase();
      const meetingLike = /meeting|transcript|call/.test(label);
      const listLike = /list|search|find|recent|get/.test(label);
      return meetingLike && listLike;
    });

    const meetings: MeetingCandidate[] = [];
    for (const tool of listToolCandidates) {
      const candidateArgs = [{ limit }, { maxResults: limit }, { pageSize: limit }, {}] as Array<Record<string, unknown>>;

      for (const args of candidateArgs) {
        try {
          const result = await this.callTool(tool.name, args);
          const records = this.extractRecords(result);
          for (const record of records) {
            const normalized = this.normalizeMeetingRecord(record);
            if (normalized) {
              meetings.push(normalized);
            }
          }

          if (meetings.length >= limit) {
            return meetings.slice(0, limit);
          }
        } catch {
          // Ignore candidate failures and continue probing.
        }
      }
    }

    return meetings;
  }

  private async fetchMeetingsFromResources(limit: number): Promise<MeetingCandidate[]> {
    const resources = await this.listResources();
    const relevant = resources
      .filter((resource) => {
        const label = `${resource.uri} ${resource.name ?? ""} ${resource.description ?? ""}`.toLowerCase();
        return /meeting|transcript|call/.test(label);
      })
      .slice(0, limit);

    const meetings: MeetingCandidate[] = [];
    for (const resource of relevant) {
      try {
        const resourceData = await this.readResource(resource.uri);
        const records = this.extractRecords(resourceData);

        const fromRecords = records
          .map((record) => this.normalizeMeetingRecord(record, resource.uri, resource.name))
          .filter((record): record is MeetingCandidate => Boolean(record));

        if (fromRecords.length > 0) {
          meetings.push(...fromRecords);
          continue;
        }

        const fallbackText = this.extractLongestText(resourceData);
        if (fallbackText && fallbackText.length > 40) {
          meetings.push({
            meetingId: resource.uri,
            title: resource.name ?? "Meeting transcript",
            participants: [],
            occurredAt: new Date().toISOString(),
            transcript: fallbackText
          });
        }
      } catch {
        // Skip unreadable resources.
      }
    }

    return meetings;
  }

  private normalizeMeetingRecord(
    value: unknown,
    fallbackId?: string,
    fallbackTitle?: string
  ): MeetingCandidate | null {
    if (!value || typeof value !== "object") {
      return null;
    }

    const record = value as Record<string, unknown>;
    const meetingId = firstString(record, ["meetingId", "meeting_id", "id", "uuid", "uri"]) ?? fallbackId;
    if (!meetingId) {
      return null;
    }

    const title = firstString(record, ["title", "meetingTitle", "name", "topic", "subject"]) ?? fallbackTitle ?? "Meeting";
    const occurredAt = firstString(record, ["occurredAt", "occurred_at", "startedAt", "startTime", "date", "createdAt"])
      ?? new Date().toISOString();

    const participants = collectStringArray(record, ["participants", "attendees", "speakers", "members"]);

    const transcriptRaw = firstUnknown(record, [
      "transcript",
      "transcriptText",
      "fullTranscript",
      "content",
      "text",
      "body",
      "notes"
    ]);

    const transcript = this.normalizeTranscriptText(transcriptRaw);

    return {
      meetingId,
      title,
      participants,
      occurredAt,
      transcript: transcript ?? undefined
    };
  }

  private normalizeTranscriptText(value: unknown): string | null {
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    }

    if (Array.isArray(value)) {
      const joined = value
        .map((item) => {
          if (typeof item === "string") {
            return item;
          }
          if (item && typeof item === "object") {
            return firstString(item as Record<string, unknown>, ["text", "content", "line"]) ?? "";
          }
          return "";
        })
        .join("\n")
        .trim();

      return joined.length > 0 ? joined : null;
    }

    if (value && typeof value === "object") {
      return firstString(value as Record<string, unknown>, ["text", "content", "body", "transcript"]);
    }

    return null;
  }

  private extractLongestText(value: unknown): string | null {
    const records = this.extractRecords(value);
    let longest = "";

    for (const record of records) {
      if (typeof record === "string") {
        if (record.length > longest.length) {
          longest = record;
        }
        continue;
      }

      if (record && typeof record === "object") {
        const text = firstString(record as Record<string, unknown>, ["text", "content", "body", "transcript"]);
        if (text && text.length > longest.length) {
          longest = text;
        }
      }
    }

    return longest.length > 0 ? longest : null;
  }

  private extractRecords(value: unknown): unknown[] {
    const out: unknown[] = [];
    const visit = (node: unknown): void => {
      if (node == null) {
        return;
      }

      if (typeof node === "string") {
        out.push(node);
        const json = tryParseJson(node);
        if (json !== null) {
          visit(json);
        }
        return;
      }

      if (Array.isArray(node)) {
        for (const item of node) {
          visit(item);
        }
        return;
      }

      if (typeof node !== "object") {
        return;
      }

      const obj = node as Record<string, unknown>;
      out.push(obj);

      for (const key of ["structuredContent", "content", "data", "items", "results", "meetings", "resources"]) {
        if (key in obj) {
          visit(obj[key]);
        }
      }

      if (typeof obj.text === "string") {
        out.push(obj.text);
      }
    };

    visit(value);
    return out;
  }

  private async listTools(): Promise<ToolDescriptor[]> {
    const tools: ToolDescriptor[] = [];
    let cursor: string | undefined;

    do {
      const result = await this.mcpRequest<{ tools?: ToolDescriptor[]; nextCursor?: string }>("tools/list", {
        cursor
      });

      tools.push(...(result.tools ?? []));
      cursor = result.nextCursor;
    } while (cursor);

    return tools;
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.mcpRequest("tools/call", {
      name,
      arguments: args
    });
  }

  private async listResources(): Promise<ResourceDescriptor[]> {
    const resources: ResourceDescriptor[] = [];
    let cursor: string | undefined;

    do {
      const result = await this.mcpRequest<{ resources?: ResourceDescriptor[]; nextCursor?: string }>("resources/list", {
        cursor
      });

      resources.push(...(result.resources ?? []));
      cursor = result.nextCursor;
    } while (cursor);

    return resources;
  }

  private async readResource(uri: string): Promise<unknown> {
    return this.mcpRequest("resources/read", { uri });
  }

  private async ensureSession(): Promise<void> {
    if (this.sessionId) {
      return;
    }

    const payload = {
      jsonrpc: "2.0",
      id: this.rpcId++,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: {
          name: "clausifai-agent",
          version: "0.1.0"
        }
      }
    };

    let accessToken = await this.getAccessToken();
    let response = await fetch(this.env.TACTIQ_MCP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        "Mcp-Protocol-Version": "2025-03-26"
      },
      body: JSON.stringify(payload)
    });

    if (response.status === 401) {
      accessToken = await this.refreshAccessToken();
      response = await fetch(this.env.TACTIQ_MCP_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
          "Mcp-Protocol-Version": "2025-03-26"
        },
        body: JSON.stringify(payload)
      });
    }

    const mcpSessionId = response.headers.get("mcp-session-id") ?? response.headers.get("Mcp-Session-Id");
    if (mcpSessionId) {
      this.sessionId = mcpSessionId;
    }

    const parsed = await parseJsonResponse<JsonRpcResponse>(response);
    if (!response.ok || parsed.error) {
      throw new Error(parsed.error?.message ?? `Tactiq initialize failed with ${response.status}`);
    }
  }

  private async mcpRequest<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    await this.ensureSession();

    let accessToken = await this.getAccessToken();
    let response = await this.performRpcCall<T>(method, params, accessToken);

    if (response.unauthorized) {
      accessToken = await this.refreshAccessToken();
      response = await this.performRpcCall<T>(method, params, accessToken);
    }

    if (response.error) {
      throw new Error(response.error);
    }

    return response.result as T;
  }

  private async performRpcCall<T>(
    method: string,
    params: Record<string, unknown>,
    accessToken: string
  ): Promise<{ result?: T; error?: string; unauthorized?: boolean }> {
    const payload = {
      jsonrpc: "2.0",
      id: this.rpcId++,
      method,
      params
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      "Mcp-Protocol-Version": "2025-03-26"
    };

    if (this.sessionId) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }

    const response = await fetch(this.env.TACTIQ_MCP_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });

    const session = response.headers.get("mcp-session-id") ?? response.headers.get("Mcp-Session-Id");
    if (session) {
      this.sessionId = session;
    }

    if (response.status === 401) {
      return { unauthorized: true };
    }

    const parsed = await parseJsonResponse<JsonRpcResponse<T>>(response);
    if (!response.ok) {
      return { error: parsed.error?.message ?? `MCP request ${method} failed (${response.status})` };
    }

    if (parsed.error) {
      return { error: parsed.error.message };
    }

    return { result: parsed.result };
  }

  private async getAccessToken(): Promise<string> {
    if (this.env.TACTIQ_ACCESS_TOKEN) {
      return this.env.TACTIQ_ACCESS_TOKEN;
    }

    const tokens = await this.readStoredTokens();
    const expiresAt = tokens?.expiresAt ? new Date(tokens.expiresAt).getTime() : undefined;
    const shouldRefresh = !tokens?.accessToken
      || (typeof expiresAt === "number" && expiresAt <= Date.now() + 60_000);

    if (!shouldRefresh && tokens?.accessToken) {
      return tokens.accessToken;
    }

    return this.refreshAccessToken();
  }

  private async refreshAccessToken(): Promise<string> {
    const protectedMetadata = await this.fetchProtectedResourceMetadata();
    const authMetadata = await this.fetchAuthorizationServerMetadata(protectedMetadata);
    const clientRegistration = await this.resolveClientRegistration(
      authMetadata,
      await this.resolveAnyRedirectUri(),
      protectedMetadata.resource
    );

    const current = await this.readStoredTokens();
    const refreshToken = this.env.TACTIQ_REFRESH_TOKEN ?? current?.refreshToken;
    if (!refreshToken) {
      throw new Error("Tactiq refresh token missing. Connect via /integrations/tactiq/connect first.");
    }

    const params = new URLSearchParams();
    params.set("grant_type", "refresh_token");
    params.set("refresh_token", refreshToken);
    params.set("client_id", clientRegistration.clientId);
    params.set("resource", clientRegistration.resource);

    if (clientRegistration.tokenEndpointAuthMethod === "client_secret_post" && clientRegistration.clientSecret) {
      params.set("client_secret", clientRegistration.clientSecret);
    }

    const response = await fetch(authMetadata.token_endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params.toString()
    });

    const data = await parseJsonResponse<Record<string, unknown>>(response);
    if (!response.ok || !data.access_token || typeof data.access_token !== "string") {
      throw new Error("Failed to refresh Tactiq access token");
    }

    const tokenSet: OAuthTokenSet = {
      accessToken: data.access_token,
      refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : refreshToken,
      expiresAt: computeExpiry(data.expires_in)
    };

    await this.saveTokenSet(tokenSet);
    this.sessionId = undefined;
    return tokenSet.accessToken;
  }

  private async exchangeCodeForToken(
    authMetadata: AuthorizationServerMetadata,
    clientRegistration: OAuthClientRegistration,
    paramsInput: {
      code: string;
      redirectUri: string;
      codeVerifier: string;
      resource: string;
    }
  ): Promise<OAuthTokenSet> {
    const params = new URLSearchParams();
    params.set("grant_type", "authorization_code");
    params.set("code", paramsInput.code);
    params.set("redirect_uri", paramsInput.redirectUri);
    params.set("client_id", clientRegistration.clientId);
    params.set("code_verifier", paramsInput.codeVerifier);
    params.set("resource", paramsInput.resource);

    if (clientRegistration.tokenEndpointAuthMethod === "client_secret_post" && clientRegistration.clientSecret) {
      params.set("client_secret", clientRegistration.clientSecret);
    }

    const response = await fetch(authMetadata.token_endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params.toString()
    });

    const data = await parseJsonResponse<Record<string, unknown>>(response);
    if (!response.ok || !data.access_token || typeof data.access_token !== "string") {
      throw new Error("Failed to exchange Tactiq authorization code");
    }

    return {
      accessToken: data.access_token,
      refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : undefined,
      expiresAt: computeExpiry(data.expires_in)
    };
  }

  private async resolveClientRegistration(
    authMetadata: AuthorizationServerMetadata,
    redirectUri: string,
    resource: string
  ): Promise<OAuthClientRegistration> {
    if (this.env.TACTIQ_CLIENT_ID) {
      return {
        clientId: this.env.TACTIQ_CLIENT_ID,
        clientSecret: this.env.TACTIQ_CLIENT_SECRET,
        tokenEndpointAuthMethod: this.env.TACTIQ_CLIENT_SECRET ? "client_secret_post" : "none",
        redirectUri,
        resource
      };
    }

    const saved = await this.stateStore.get<Record<string, unknown>>("tactiq_oauth_client");
    if (saved?.clientId && typeof saved.clientId === "string") {
      return {
        clientId: saved.clientId,
        clientSecret: typeof saved.clientSecret === "string" ? saved.clientSecret : undefined,
        tokenEndpointAuthMethod: saved.tokenEndpointAuthMethod === "client_secret_post" ? "client_secret_post" : "none",
        redirectUri,
        resource
      };
    }

    if (!authMetadata.registration_endpoint) {
      throw new Error("Tactiq OAuth registration endpoint unavailable; set TACTIQ_CLIENT_ID manually");
    }

    const preferredAuthMethod = (authMetadata.token_endpoint_auth_methods_supported ?? []).includes("none")
      ? "none"
      : "client_secret_post";

    const body: Record<string, unknown> = {
      client_name: "clausifai-agent",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: preferredAuthMethod
    };

    const response = await fetch(authMetadata.registration_endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    const registration = await parseJsonResponse<Record<string, unknown>>(response);
    if (!response.ok || !registration.client_id || typeof registration.client_id !== "string") {
      throw new Error("Failed to dynamically register Tactiq OAuth client");
    }

    const resolved: OAuthClientRegistration = {
      clientId: registration.client_id,
      clientSecret: typeof registration.client_secret === "string" ? registration.client_secret : undefined,
      tokenEndpointAuthMethod: registration.token_endpoint_auth_method === "client_secret_post"
        ? "client_secret_post"
        : "none",
      redirectUri,
      resource
    };

    await this.stateStore.set("tactiq_oauth_client", {
      clientId: resolved.clientId,
      clientSecret: resolved.clientSecret ?? null,
      tokenEndpointAuthMethod: resolved.tokenEndpointAuthMethod,
      redirectUri,
      resource,
      updatedAt: new Date().toISOString()
    });

    return resolved;
  }

  private async fetchProtectedResourceMetadata(): Promise<ProtectedResourceMetadata> {
    const response = await fetch(`${this.getMetadataBaseUrl()}/.well-known/oauth-protected-resource`);
    const data = await parseJsonResponse<ProtectedResourceMetadata>(response);
    if (!response.ok || !data.authorization_servers?.length) {
      throw new Error("Unable to read Tactiq OAuth protected resource metadata");
    }
    return data;
  }

  private async fetchAuthorizationServerMetadata(
    protectedMetadata: ProtectedResourceMetadata
  ): Promise<AuthorizationServerMetadata> {
    const server = protectedMetadata.authorization_servers[0];
    const response = await fetch(`${server}/.well-known/oauth-authorization-server`);
    const data = await parseJsonResponse<AuthorizationServerMetadata>(response);
    if (!response.ok || !data.authorization_endpoint || !data.token_endpoint) {
      throw new Error("Unable to read Tactiq OAuth authorization server metadata");
    }
    return data;
  }

  private resolveRedirectUri(baseUrl: string): string {
    if (this.env.TACTIQ_REDIRECT_URI) {
      return this.env.TACTIQ_REDIRECT_URI;
    }

    if (!baseUrl) {
      throw new Error("APP_BASE_URL (or TACTIQ_REDIRECT_URI) is required for Tactiq OAuth setup");
    }

    return `${baseUrl.replace(/\/$/, "")}/integrations/tactiq/callback`;
  }

  private async resolveAnyRedirectUri(): Promise<string> {
    if (this.env.TACTIQ_REDIRECT_URI) {
      return this.env.TACTIQ_REDIRECT_URI;
    }

    const saved = await this.stateStore.get<Record<string, unknown>>("tactiq_oauth_client");
    if (saved?.redirectUri && typeof saved.redirectUri === "string") {
      return saved.redirectUri;
    }

    if (this.env.APP_BASE_URL) {
      return `${this.env.APP_BASE_URL.replace(/\/$/, "")}/integrations/tactiq/callback`;
    }

    return "http://localhost/integrations/tactiq/callback";
  }

  private async readStoredTokens(): Promise<OAuthTokenSet | null> {
    const fromStore = await this.stateStore.get<Record<string, unknown>>("tactiq_oauth_tokens");

    if (!fromStore) {
      return null;
    }

    if (!fromStore.accessToken || typeof fromStore.accessToken !== "string") {
      return null;
    }

    return {
      accessToken: fromStore.accessToken,
      refreshToken: typeof fromStore.refreshToken === "string" ? fromStore.refreshToken : undefined,
      expiresAt: typeof fromStore.expiresAt === "string" ? fromStore.expiresAt : undefined
    };
  }

  private async saveTokenSet(tokens: OAuthTokenSet): Promise<void> {
    await this.stateStore.set("tactiq_oauth_tokens", {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? null,
      expiresAt: tokens.expiresAt ?? null,
      updatedAt: new Date().toISOString()
    });
  }

  private getMetadataBaseUrl(): string {
    return new URL(this.env.TACTIQ_MCP_URL).origin;
  }
}

function computeExpiry(expiresIn: unknown): string | undefined {
  const seconds = typeof expiresIn === "number"
    ? expiresIn
    : (typeof expiresIn === "string" ? Number(expiresIn) : NaN);

  if (!Number.isFinite(seconds)) {
    return undefined;
  }

  const at = new Date(Date.now() + Math.max(seconds - 60, 0) * 1000);
  return at.toISOString();
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Expected JSON response, got: ${text.slice(0, 300)}`);
  }
}

function base64Url(value: Buffer): string {
  return value.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function tryParseJson(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function firstUnknown(record: Record<string, unknown>, keys: string[]): unknown | null {
  for (const key of keys) {
    if (key in record) {
      return record[key];
    }
  }
  return null;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  const value = firstUnknown(record, keys);
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

function collectStringArray(record: Record<string, unknown>, keys: string[]): string[] {
  for (const key of keys) {
    const raw = record[key];
    if (!Array.isArray(raw)) {
      continue;
    }

    const values = raw
      .map((entry) => {
        if (typeof entry === "string") {
          return entry.trim();
        }

        if (entry && typeof entry === "object") {
          return firstString(entry as Record<string, unknown>, ["name", "email", "displayName", "value"]) ?? "";
        }

        return "";
      })
      .filter((entry): entry is string => entry.length > 0);

    if (values.length > 0) {
      return values;
    }
  }

  return [];
}
