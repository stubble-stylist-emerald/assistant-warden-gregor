import crypto from "node:crypto";
import type Database from "better-sqlite3";
import { DEFAULT_REMINDER_OFFSET } from "./offset";
import type { Alert, AlertEventTarget, AlertOffsetUnit, DefaultReminder, EventChannel, EventTracking, EventTrackingState, FailedRecipient, SentAlert, SentChannelAlert } from "./types";

interface AlertRow {
  id: string;
  guild_id: string;
  amount: number;
  unit: AlertOffsetUnit;
  event_target: AlertEventTarget;
  enabled: 0 | 1;
  created_at: string;
  updated_at: string;
}

interface SentAlertRow {
  id: string;
  guild_id: string;
  event_id: string;
  alert_id: string;
  event_name: string;
  scheduled_start_at: string;
  offset_amount: number;
  offset_unit: AlertOffsetUnit;
  attempted_recipient_ids: string;
  successful_recipient_ids: string;
  failed_recipients: string;
  sent_at: string;
  error_summary: string | null;
}

// A guild's effective default reminder offset: the stored pair, or the built-in
// 24 hours when either half is missing. Both columns are written together, so
// requiring both keeps the admin panel and the scheduler reading the same value.
function effectiveDefaultReminder(
  amount: number | null | undefined,
  unit: AlertOffsetUnit | null | undefined
): DefaultReminder {
  return amount && unit ? { amount, unit } : DEFAULT_REMINDER_OFFSET;
}

function isBuiltInDefaultReminder(reminder: DefaultReminder): boolean {
  return reminder.amount === DEFAULT_REMINDER_OFFSET.amount && reminder.unit === DEFAULT_REMINDER_OFFSET.unit;
}

export class AlertRepository {
  constructor(private readonly db: Database.Database) {}

  ensureGuild(guildId: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO guild_settings (guild_id, created_at, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(guild_id) DO UPDATE SET updated_at = excluded.updated_at`
      )
      .run(guildId, now, now);
  }

  listConfiguredGuildIds(): string[] {
    const rows = this.db.prepare("SELECT guild_id FROM guild_settings ORDER BY guild_id").all() as Array<{
      guild_id: string;
    }>;
    return rows.map((row) => row.guild_id);
  }

  listAlerts(guildId: string): Alert[] {
    this.normalizeAlerts(guildId);
    const rows = this.db
      .prepare("SELECT * FROM alerts WHERE guild_id = ? ORDER BY amount, unit, event_target, created_at")
      .all(guildId) as AlertRow[];
    return rows.map((row) => this.mapAlertRow(row));
  }

  listSubscribedAlerts(guildId: string, userId: string): Alert[] {
    this.normalizeAlerts(guildId);
    const rows = this.db
      .prepare(
        `SELECT alerts.*
         FROM alerts
         INNER JOIN alert_recipients ON alert_recipients.alert_id = alerts.id
         WHERE alerts.guild_id = ? AND alert_recipients.user_id = ?
         ORDER BY alerts.amount, alerts.unit, alerts.event_target, alerts.created_at`
      )
      .all(guildId, userId) as AlertRow[];
    return rows.map((row) => this.mapAlertRow(row));
  }

  findAlertsByOffset(guildId: string, amount: number, unit: AlertOffsetUnit, eventTarget: AlertEventTarget): Alert[] {
    this.normalizeAlerts(guildId);
    const rows = this.db
      .prepare("SELECT * FROM alerts WHERE guild_id = ? AND amount = ? AND unit = ? AND event_target = ? ORDER BY created_at")
      .all(guildId, amount, unit, eventTarget) as AlertRow[];
    return rows.map((row) => this.mapAlertRow(row));
  }

  getAlert(alertId: string): Alert | null {
    const row = this.db.prepare("SELECT * FROM alerts WHERE id = ?").get(alertId) as AlertRow | undefined;
    return row ? this.mapAlertRow(row) : null;
  }

  addAlert(guildId: string, amount: number, unit: AlertOffsetUnit, eventTarget: AlertEventTarget = "interested"): Alert {
    this.ensureGuild(guildId);
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO alerts (id, guild_id, amount, unit, event_target, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
      )
      .run(id, guildId, amount, unit, eventTarget, now, now);

    const alert = this.getAlert(id);
    if (!alert) {
      throw new Error("Failed to load inserted alert.");
    }
    return alert;
  }

  updateAlert(alertId: string, amount: number, unit: AlertOffsetUnit, eventTarget: AlertEventTarget): Alert | null {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE alerts SET amount = ?, unit = ?, event_target = ?, updated_at = ? WHERE id = ?")
      .run(amount, unit, eventTarget, now, alertId);
    return this.getAlert(alertId);
  }

  deleteAlert(alertId: string): void {
    this.db.prepare("DELETE FROM alerts WHERE id = ?").run(alertId);
  }

  getAlertRecipients(alertId: string): string[] {
    const rows = this.db
      .prepare("SELECT user_id FROM alert_recipients WHERE alert_id = ? ORDER BY created_at, user_id")
      .all(alertId) as Array<{ user_id: string }>;
    return rows.map((row) => row.user_id);
  }

  setAlertRecipients(alertId: string, userIds: string[]): Alert | null {
    const uniqueUserIds = Array.from(new Set(userIds));
    const now = new Date().toISOString();

    // Replace one alert's recipient set atomically so the Discord picker is authoritative.
    const updateRecipients = this.db.transaction(() => {
      this.db.prepare("DELETE FROM alert_recipients WHERE alert_id = ?").run(alertId);
      const insert = this.db.prepare(
        "INSERT INTO alert_recipients (alert_id, user_id, created_at) VALUES (?, ?, ?)"
      );
      for (const userId of uniqueUserIds) {
        insert.run(alertId, userId, now);
      }
    });

    updateRecipients();
    if (uniqueUserIds.length === 0) {
      this.deleteAlert(alertId);
      return null;
    }

    return this.getAlert(alertId);
  }

  addAlertRecipient(alertId: string, userId: string): Alert | null {
    const now = new Date().toISOString();
    this.db
      .prepare("INSERT OR IGNORE INTO alert_recipients (alert_id, user_id, created_at) VALUES (?, ?, ?)")
      .run(alertId, userId, now);
    return this.getAlert(alertId);
  }

  removeAlertRecipient(alertId: string, userId: string): Alert | null {
    this.db.prepare("DELETE FROM alert_recipients WHERE alert_id = ? AND user_id = ?").run(alertId, userId);
    if (this.getAlertRecipients(alertId).length === 0) {
      this.deleteAlert(alertId);
      return null;
    }

    return this.getAlert(alertId);
  }

  hasSentAlert(guildId: string, eventId: string, alertId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM sent_alerts WHERE guild_id = ? AND event_id = ? AND alert_id = ?")
      .get(guildId, eventId, alertId);
    return Boolean(row);
  }

  recordSentAlert(input: Omit<SentAlert, "id" | "sentAt"> & { sentAt?: string }): void {
    this.ensureGuild(input.guildId);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO sent_alerts (
          id,
          guild_id,
          event_id,
          alert_id,
          event_name,
          scheduled_start_at,
          offset_amount,
          offset_unit,
          attempted_recipient_ids,
          successful_recipient_ids,
          failed_recipients,
          sent_at,
          error_summary
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        crypto.randomUUID(),
        input.guildId,
        input.eventId,
        input.alertId,
        input.eventName,
        input.scheduledStartAt,
        input.offsetAmount,
        input.offsetUnit,
        JSON.stringify(input.attemptedRecipientIds),
        JSON.stringify(input.successfulRecipientIds),
        JSON.stringify(input.failedRecipients),
        input.sentAt ?? new Date().toISOString(),
        input.errorSummary
      );
  }

  listSentHistory(guildId: string, page: number, pageSize: number): SentAlert[] {
    const offset = Math.max(0, page) * pageSize;
    const rows = this.db
      .prepare("SELECT * FROM sent_alerts WHERE guild_id = ? ORDER BY sent_at DESC LIMIT ? OFFSET ?")
      .all(guildId, pageSize, offset) as SentAlertRow[];
    return rows.map(mapSentAlertRow);
  }

  clearSentHistory(guildId: string): void {
    this.db.prepare("DELETE FROM sent_alerts WHERE guild_id = ?").run(guildId);
    this.db.prepare("DELETE FROM sent_channel_alerts WHERE guild_id = ?").run(guildId);
  }

  // True if the guild has any sent-alert record (DM or channel). Used by the
  // clear-history panel so its empty state matches what clearSentHistory deletes.
  hasSentHistory(guildId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM sent_alerts WHERE guild_id = ?
         UNION ALL
         SELECT 1 FROM sent_channel_alerts WHERE guild_id = ?
         LIMIT 1`
      )
      .get(guildId, guildId);
    return Boolean(row);
  }

  private mapAlertRow(row: AlertRow): Alert {
    return {
      id: row.id,
      guildId: row.guild_id,
      amount: row.amount,
      unit: row.unit,
      eventTarget: row.event_target,
      recipientIds: this.getAlertRecipients(row.id),
      enabled: row.enabled === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private normalizeAlerts(guildId: string): void {
    this.deleteRecipientlessAlerts(guildId);
    this.mergeDuplicateAlerts(guildId);
  }

  private mergeDuplicateAlerts(guildId: string): void {
    const rows = this.db
      .prepare("SELECT * FROM alerts WHERE guild_id = ? ORDER BY amount, unit, event_target, created_at")
      .all(guildId) as AlertRow[];
    const rowsByKey = new Map<string, AlertRow[]>();
    for (const row of rows) {
      const key = `${row.amount}:${row.unit}:${row.event_target}`;
      rowsByKey.set(key, [...(rowsByKey.get(key) ?? []), row]);
    }

    // Fold legacy duplicate rules into the oldest matching alert so each timing/filter pair has one row.
    const mergeDuplicates = this.db.transaction((groups: AlertRow[][]) => {
      for (const group of groups) {
        const [canonical, ...duplicates] = group;
        if (!canonical || duplicates.length === 0) {
          continue;
        }

        const recipientIds = Array.from(
          new Set([canonical.id, ...duplicates.map((row) => row.id)].flatMap((alertId) => this.getAlertRecipients(alertId)))
        );
        const now = new Date().toISOString();
        const insertRecipient = this.db.prepare(
          "INSERT OR IGNORE INTO alert_recipients (alert_id, user_id, created_at) VALUES (?, ?, ?)"
        );
        for (const userId of recipientIds) {
          insertRecipient.run(canonical.id, userId, now);
        }

        for (const duplicate of duplicates) {
          this.moveSentHistoryToCanonicalAlert(guildId, duplicate.id, canonical.id);
          this.deleteAlert(duplicate.id);
        }
      }
    });

    mergeDuplicates(Array.from(rowsByKey.values()));
  }

  private moveSentHistoryToCanonicalAlert(guildId: string, duplicateAlertId: string, canonicalAlertId: string): void {
    this.db
      .prepare(
        `UPDATE sent_alerts
         SET alert_id = ?
         WHERE guild_id = ?
         AND alert_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM sent_alerts existing
           WHERE existing.guild_id = sent_alerts.guild_id
           AND existing.event_id = sent_alerts.event_id
           AND existing.alert_id = ?
         )`
      )
      .run(canonicalAlertId, guildId, duplicateAlertId, canonicalAlertId);
    this.db.prepare("DELETE FROM sent_alerts WHERE guild_id = ? AND alert_id = ?").run(guildId, duplicateAlertId);
  }

  private deleteRecipientlessAlerts(guildId: string): void {
    this.db
      .prepare(
        `DELETE FROM alerts
         WHERE guild_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM alert_recipients WHERE alert_recipients.alert_id = alerts.id
         )`
      )
      .run(guildId);
  }

  isAutoStartEnabled(guildId: string): boolean {
    const row = this.db
      .prepare("SELECT auto_start_enabled FROM guild_settings WHERE guild_id = ?")
      .get(guildId) as { auto_start_enabled: number } | undefined;
    return row?.auto_start_enabled === 1;
  }

  setAutoStartEnabled(guildId: string, enabled: boolean): void {
    this.ensureGuild(guildId);
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE guild_settings SET auto_start_enabled = ?, updated_at = ? WHERE guild_id = ?")
      .run(enabled ? 1 : 0, now, guildId);
  }

  listAutoStartGuildIds(): string[] {
    const rows = this.db
      .prepare("SELECT guild_id FROM guild_settings WHERE auto_start_enabled = 1 ORDER BY guild_id")
      .all() as Array<{ guild_id: string }>;
    return rows.map((row) => row.guild_id);
  }

  // Effective guild default reminder offset plus whether it differs from the
  // built-in default. A single row read and a single normalization shared by the
  // admin panel, the /subscribe prefill, and the scheduler, so they cannot
  // disagree about the same guild.
  getDefaultReminderSettings(guildId: string): { offset: DefaultReminder; isCustom: boolean } {
    const row = this.db
      .prepare("SELECT default_reminder_amount, default_reminder_unit FROM guild_settings WHERE guild_id = ?")
      .get(guildId) as { default_reminder_amount: number | null; default_reminder_unit: AlertOffsetUnit | null } | undefined;
    const offset = effectiveDefaultReminder(row?.default_reminder_amount, row?.default_reminder_unit);
    return { offset, isCustom: !isBuiltInDefaultReminder(offset) };
  }

  // Passing null resets the guild to the built-in default (24 hours).
  setDefaultReminderOffset(guildId: string, reminder: DefaultReminder | null): void {
    this.ensureGuild(guildId);
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE guild_settings SET default_reminder_amount = ?, default_reminder_unit = ?, updated_at = ? WHERE guild_id = ?"
      )
      .run(reminder?.amount ?? null, reminder?.unit ?? null, now, guildId);
  }

  // Effective default for every configured guild. Drives channel reminders, which
  // therefore fire for guilds that never configured a default.
  listGuildDefaultReminders(): Array<{ guildId: string } & DefaultReminder> {
    const rows = this.db
      .prepare("SELECT guild_id, default_reminder_amount, default_reminder_unit FROM guild_settings")
      .all() as Array<{ guild_id: string; default_reminder_amount: number | null; default_reminder_unit: AlertOffsetUnit | null }>;
    return rows.map((row) => ({
      guildId: row.guild_id,
      ...effectiveDefaultReminder(row.default_reminder_amount, row.default_reminder_unit)
    }));
  }

  // Associate a channel with an event as a reminder target and record the
  // event's initial tracked state. The tracking snapshot is first-write-wins
  // (ON CONFLICT DO NOTHING) so re-posting a link never resets change detection.
  registerEventChannel(
    guildId: string,
    eventId: string,
    channelId: string,
    state: EventTrackingState
  ): void {
    // ensureGuild first: event_channels has an FK to guild_settings, and the
    // scheduler only polls guilds present in guild_settings.
    this.ensureGuild(guildId);
    const now = new Date().toISOString();
    const register = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO event_channels (guild_id, event_id, channel_id, created_at)
           VALUES (?, ?, ?, ?)`
        )
        .run(guildId, eventId, channelId, now);
      this.db
        .prepare(
          `INSERT INTO event_tracking
             (guild_id, event_id, last_known_start_at, last_known_channel_id, last_known_location, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(guild_id, event_id) DO NOTHING`
        )
        .run(
          guildId,
          eventId,
          state.lastKnownStartAt,
          state.lastKnownChannelId,
          state.lastKnownLocation,
          now,
          now
        );
    });
    register();
  }

  removeEventChannel(guildId: string, eventId: string, channelId: string): void {
    this.db
      .prepare("DELETE FROM event_channels WHERE guild_id = ? AND event_id = ? AND channel_id = ?")
      .run(guildId, eventId, channelId);
  }

  listEventChannelsForEvent(guildId: string, eventId: string): EventChannel[] {
    const rows = this.db
      .prepare("SELECT * FROM event_channels WHERE guild_id = ? AND event_id = ? ORDER BY created_at")
      .all(guildId, eventId) as Array<{ guild_id: string; event_id: string; channel_id: string; created_at: string }>;
    return rows.map((row) => ({
      guildId: row.guild_id,
      eventId: row.event_id,
      channelId: row.channel_id,
      createdAt: row.created_at
    }));
  }

  listTrackedEventIds(guildId: string): string[] {
    const rows = this.db
      .prepare("SELECT event_id FROM event_tracking WHERE guild_id = ?")
      .all(guildId) as Array<{ event_id: string }>;
    return rows.map((row) => row.event_id);
  }

  getEventTracking(guildId: string, eventId: string): EventTracking | null {
    const row = this.db
      .prepare("SELECT * FROM event_tracking WHERE guild_id = ? AND event_id = ?")
      .get(guildId, eventId) as
      | {
          guild_id: string;
          event_id: string;
          last_known_start_at: string | null;
          last_known_channel_id: string | null;
          last_known_location: string | null;
          created_at: string;
          updated_at: string;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      guildId: row.guild_id,
      eventId: row.event_id,
      lastKnownStartAt: row.last_known_start_at,
      lastKnownChannelId: row.last_known_channel_id,
      lastKnownLocation: row.last_known_location,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  updateEventTracking(guildId: string, eventId: string, state: EventTrackingState): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE event_tracking
         SET last_known_start_at = ?, last_known_channel_id = ?, last_known_location = ?, updated_at = ?
         WHERE guild_id = ? AND event_id = ?`
      )
      .run(state.lastKnownStartAt, state.lastKnownChannelId, state.lastKnownLocation, now, guildId, eventId);
  }

  // Remove an event entirely: its tracking snapshot and every channel association.
  // Used when an event completes, is cancelled, or vanishes from Discord.
  removeEventTracking(guildId: string, eventId: string): void {
    this.db.prepare("DELETE FROM event_tracking WHERE guild_id = ? AND event_id = ?").run(guildId, eventId);
    this.db.prepare("DELETE FROM event_channels WHERE guild_id = ? AND event_id = ?").run(guildId, eventId);
  }

  // Channel-reminder dedup is per (event, alert, channel), unlike sent_alerts'
  // per (guild, event, alert) — each channel gets each delivery exactly once.
  // `dedupeKey` is an alert id (reminders) or a `change:<fingerprint>` (notices).
  hasSentChannelAlert(guildId: string, eventId: string, dedupeKey: string, channelId: string): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 FROM sent_channel_alerts WHERE guild_id = ? AND event_id = ? AND dedupe_key = ? AND channel_id = ?"
      )
      .get(guildId, eventId, dedupeKey, channelId);
    return Boolean(row);
  }

  recordSentChannelAlert(input: {
    guildId: string;
    eventId: string;
    dedupeKey: string;
    channelId: string;
    eventName: string;
    offsetAmount?: number | null;
    offsetUnit?: AlertOffsetUnit | null;
  }): void {
    this.ensureGuild(input.guildId);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO sent_channel_alerts
           (guild_id, event_id, dedupe_key, channel_id, event_name, offset_amount, offset_unit, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.guildId,
        input.eventId,
        input.dedupeKey,
        input.channelId,
        input.eventName,
        input.offsetAmount ?? null,
        input.offsetUnit ?? null,
        new Date().toISOString()
      );
  }

  listSentChannelHistory(guildId: string, page: number, pageSize: number): SentChannelAlert[] {
    const offset = Math.max(0, page) * pageSize;
    const rows = this.db
      .prepare("SELECT * FROM sent_channel_alerts WHERE guild_id = ? ORDER BY sent_at DESC LIMIT ? OFFSET ?")
      .all(guildId, pageSize, offset) as Array<{
      guild_id: string;
      event_id: string;
      dedupe_key: string;
      channel_id: string;
      event_name: string;
      offset_amount: number | null;
      offset_unit: AlertOffsetUnit | null;
      sent_at: string;
    }>;
    return rows.map((row) => ({
      guildId: row.guild_id,
      eventId: row.event_id,
      dedupeKey: row.dedupe_key,
      channelId: row.channel_id,
      eventName: row.event_name,
      offsetAmount: row.offset_amount,
      offsetUnit: row.offset_unit,
      sentAt: row.sent_at
    }));
  }
}

function mapSentAlertRow(row: SentAlertRow): SentAlert {
  return {
    id: row.id,
    guildId: row.guild_id,
    eventId: row.event_id,
    alertId: row.alert_id,
    eventName: row.event_name,
    scheduledStartAt: row.scheduled_start_at,
    offsetAmount: row.offset_amount,
    offsetUnit: row.offset_unit,
    attemptedRecipientIds: JSON.parse(row.attempted_recipient_ids) as string[],
    successfulRecipientIds: JSON.parse(row.successful_recipient_ids) as string[],
    failedRecipients: JSON.parse(row.failed_recipients) as FailedRecipient[],
    sentAt: row.sent_at,
    errorSummary: row.error_summary
  };
}
