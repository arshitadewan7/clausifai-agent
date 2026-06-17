import type { SupabaseMemoryClient } from "../clients/supabaseClient";

export class IntegrationStateStore {
  private readonly memory = new Map<string, Record<string, unknown>>();

  constructor(private readonly supabase: SupabaseMemoryClient) {}

  async get<T extends Record<string, unknown>>(key: string): Promise<T | null> {
    const fromMemory = this.memory.get(key);
    if (fromMemory) {
      return fromMemory as T;
    }

    const fromDb = await this.supabase.getIntegrationState(key);
    if (!fromDb) {
      return null;
    }

    this.memory.set(key, fromDb);
    return fromDb as T;
  }

  async set(key: string, value: Record<string, unknown>): Promise<void> {
    this.memory.set(key, value);
    await this.supabase.upsertIntegrationState(key, value);
  }
}
