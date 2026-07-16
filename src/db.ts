import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

// Open the SQLite database and create parent directories for local deployments.
export function openDatabase(databasePath: string): Database.Database {
  const directory = path.dirname(databasePath);
  if (directory && directory !== ".") {
    fs.mkdirSync(directory, { recursive: true });
  }

  const db = new Database(databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  initializeSchema(db);
  return db;
}

const SCHEMA_VERSION = 6;

// Migrate sequentially from currentVersion to targetVersion inside one transaction.
// Unknown versions (non-zero, non-chain) are rejected with an error instead of
// silently dropping all data.
export function initializeSchema(db: Database.Database): void {
  const currentVersion = db.pragma("user_version", { simple: true }) as number;

  migrateSchema(db, currentVersion, SCHEMA_VERSION);
}

function migrateSchema(db: Database.Database, fromVersion: number, toVersion: number): void {
  if (fromVersion === toVersion) {
    return;
  }

  if (fromVersion > toVersion) {
    throw new Error(
      `Database schema version ${fromVersion} is ahead of the expected version ${toVersion}. ` +
        "Downgrading is not supported."
    );
  }

  if (fromVersion !== 0 && fromVersion < 4) {
    throw new Error(
      `Unknown database schema version ${fromVersion}. Only versions 0 (fresh) and 4+ are supported.`
    );
  }

  const migration = db.transaction(() => {
    if (fromVersion === 0) {
      applyV4BaseSchema(db);
    }

    if (fromVersion <= 4 && toVersion >= 5) {
      applyV5Migration(db);
    }

    if (fromVersion <= 5 && toVersion >= 6) {
      applyV6Migration(db);
    }

    db.pragma(`user_version = ${toVersion}`);
  });

  migration();
}

function applyV4BaseSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS guild_settings (
      guild_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      unit TEXT NOT NULL CHECK (unit IN ('minutes', 'hours', 'days')),
      event_target TEXT NOT NULL DEFAULT 'interested' CHECK (event_target IN ('all', 'interested')),
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (guild_id) REFERENCES guild_settings(guild_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS alert_recipients (
      alert_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (alert_id, user_id),
      FOREIGN KEY (alert_id) REFERENCES alerts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sent_alerts (
      id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      alert_id TEXT NOT NULL,
      event_name TEXT NOT NULL,
      scheduled_start_at TEXT NOT NULL,
      offset_amount INTEGER NOT NULL,
      offset_unit TEXT NOT NULL,
      attempted_recipient_ids TEXT NOT NULL,
      successful_recipient_ids TEXT NOT NULL,
      failed_recipients TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      error_summary TEXT,
      UNIQUE (guild_id, event_id, alert_id),
      FOREIGN KEY (guild_id) REFERENCES guild_settings(guild_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_alerts_guild ON alerts(guild_id);
    CREATE INDEX IF NOT EXISTS idx_alert_recipients_alert ON alert_recipients(alert_id);
    CREATE INDEX IF NOT EXISTS idx_sent_alerts_guild ON sent_alerts(guild_id, sent_at DESC);
  `);
}

function applyV5Migration(db: Database.Database): void {
  // Idempotent column addition — ignore if the column already exists from a
  // partially-applied prior migration.
  try {
    db.exec("ALTER TABLE guild_settings ADD COLUMN auto_start_enabled INTEGER NOT NULL DEFAULT 0");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("duplicate column name") && !message.includes("already exists")) {
      throw error;
    }
  }
}

function applyV6Migration(db: Database.Database): void {
  // Idempotent column addition — ignore if the column already exists.
  try {
    db.exec("ALTER TABLE guild_settings ADD COLUMN mention_channel_id TEXT");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("duplicate column name") && !message.includes("already exists")) {
      throw error;
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      mention_notifications_enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, guild_id),
      FOREIGN KEY (guild_id) REFERENCES guild_settings(guild_id) ON DELETE CASCADE
    );
  `);
}
