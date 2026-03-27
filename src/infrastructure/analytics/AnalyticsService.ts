import type { Pool } from "pg";

export type AnalyticsEventName =
  | "app_boot_start"
  | "app_boot_ready"
  | "app_boot_error"
  | "strain_sync_success"
  | "strain_sync_failed"
  | "telegram_launch_failed"
  | "bot_start"
  | "bot_text_query"
  | "bot_paste_link"
  | "bot_empty_query"
  | "bot_paste_match_none"
  | "bot_paste_matched"
  | "bot_strain_found"
  | "bot_strain_not_found"
  | "openai_extract_start"
  | "openai_extract_success"
  | "openai_extract_failed"
  | "gemini_extract_start"
  | "gemini_extract_success"
  | "gemini_extract_failed"
  | "paste_fetch_start"
  | "paste_fetch_success"
  | "paste_fetch_failed"
  | "bot_error";

export interface AnalyticsEvent {
  name: AnalyticsEventName;
  at: Date;
  telegram?: {
    chatId?: number;
    fromId?: number;
    username?: string;
    messageId?: number;
  };
  props?: Record<string, unknown>;
}

export class AnalyticsService {
  constructor(
    private readonly db: Pool,
    private readonly tableName = "analytics_events"
  ) {}

  async track(event: AnalyticsEvent): Promise<void> {
    const props = event.props ?? null;
    const telegram = event.telegram ?? null;

    const queryValue = this.asString(props?.query);
    const strainName = this.asString(props?.strainName);
    const url = this.asString(props?.url);
    const level = this.asString(props?.level);
    const errorArea = this.asString(props?.area);
    const errorMessage = this.asString(props?.message);
    const durationMs = this.asNumber(props?.durationMs);
    const statusCode = this.asNumber(props?.status);

    const query = `
      INSERT INTO ${this.tableName} (
        name,
        event_name,
        at,
        level,
        chat_id,
        from_id,
        username,
        message_id,
        query,
        strain_name,
        url,
        duration_ms,
        status_code,
        error_area,
        error_message,
        telegram,
        props
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17::jsonb
      );
    `;

    await this.db.query(query, [
      event.name,
      event.name,
      event.at.toISOString(),
      level,
      telegram?.chatId ?? null,
      telegram?.fromId ?? null,
      telegram?.username ?? null,
      telegram?.messageId ?? null,
      queryValue,
      strainName,
      url,
      durationMs,
      statusCode,
      errorArea,
      errorMessage,
      JSON.stringify(telegram),
      JSON.stringify(props),
    ]);
  }

  private asString(value: unknown): string | null {
    return typeof value === "string" ? value : null;
  }

  private asNumber(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }
}

