import type { Pool } from "pg";

export async function bootstrapAnalytics(db: Pool): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS analytics_events (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      event_name TEXT NOT NULL,
      at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      level TEXT,
      chat_id BIGINT,
      from_id BIGINT,
      username TEXT,
      message_id BIGINT,
      query TEXT,
      strain_name TEXT,
      url TEXT,
      duration_ms INTEGER,
      status_code INTEGER,
      error_area TEXT,
      error_message TEXT,
      telegram JSONB,
      props JSONB
    );
  `);

  await db.query(`
    ALTER TABLE analytics_events
      ADD COLUMN IF NOT EXISTS event_name TEXT,
      ADD COLUMN IF NOT EXISTS level TEXT,
      ADD COLUMN IF NOT EXISTS chat_id BIGINT,
      ADD COLUMN IF NOT EXISTS from_id BIGINT,
      ADD COLUMN IF NOT EXISTS username TEXT,
      ADD COLUMN IF NOT EXISTS message_id BIGINT,
      ADD COLUMN IF NOT EXISTS query TEXT,
      ADD COLUMN IF NOT EXISTS strain_name TEXT,
      ADD COLUMN IF NOT EXISTS url TEXT,
      ADD COLUMN IF NOT EXISTS duration_ms INTEGER,
      ADD COLUMN IF NOT EXISTS status_code INTEGER,
      ADD COLUMN IF NOT EXISTS error_area TEXT,
      ADD COLUMN IF NOT EXISTS error_message TEXT;
  `);

  await db.query(`
    UPDATE analytics_events
    SET
      event_name = COALESCE(event_name, name),
      level = COALESCE(level, props->>'level'),
      chat_id = COALESCE(chat_id, NULLIF(telegram->>'chatId', '')::bigint),
      from_id = COALESCE(from_id, NULLIF(telegram->>'fromId', '')::bigint),
      username = COALESCE(username, telegram->>'username'),
      message_id = COALESCE(message_id, NULLIF(telegram->>'messageId', '')::bigint),
      query = COALESCE(query, props->>'query'),
      strain_name = COALESCE(strain_name, props->>'strainName'),
      url = COALESCE(url, props->>'url'),
      duration_ms = COALESCE(duration_ms, NULLIF(props->>'durationMs', '')::integer),
      status_code = COALESCE(status_code, NULLIF(props->>'status', '')::integer),
      error_area = COALESCE(error_area, props->>'area'),
      error_message = COALESCE(error_message, props->>'message')
    WHERE
      event_name IS NULL OR level IS NULL OR chat_id IS NULL OR from_id IS NULL OR
      username IS NULL OR message_id IS NULL OR query IS NULL OR strain_name IS NULL OR
      url IS NULL OR duration_ms IS NULL OR status_code IS NULL OR error_area IS NULL OR
      error_message IS NULL;
  `);

  await db.query(`
    UPDATE analytics_events
    SET event_name = name
    WHERE event_name IS NULL;
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_analytics_events_at
      ON analytics_events (at DESC);
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_analytics_events_name_at
      ON analytics_events (name, at DESC);
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_analytics_events_event_name_at
      ON analytics_events (event_name, at DESC);
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_analytics_events_from_id_at
      ON analytics_events (from_id, at DESC);
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_analytics_events_query
      ON analytics_events (query);
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS analytics_schema_meta (
      key TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      schema JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(
    `
      INSERT INTO analytics_schema_meta (key, version, schema, updated_at)
      VALUES ('analytics_events', 2, $1::jsonb, NOW())
      ON CONFLICT (key) DO UPDATE
      SET
        version = EXCLUDED.version,
        schema = EXCLUDED.schema,
        updated_at = NOW();
    `,
    [
      JSON.stringify({
        table: "analytics_events",
        fields: {
          id: "bigserial",
          name: "text",
          event_name: "text",
          at: "timestamptz",
          level: "text|null",
          chat_id: "bigint|null",
          from_id: "bigint|null",
          username: "text|null",
          message_id: "bigint|null",
          query: "text|null",
          strain_name: "text|null",
          url: "text|null",
          duration_ms: "integer|null",
          status_code: "integer|null",
          error_area: "text|null",
          error_message: "text|null",
          telegram: "jsonb|null",
          props: "jsonb|null",
        },
      }),
    ]
  );
}

