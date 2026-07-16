import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { initializeSchema } from "../src/db";
import { AlertRepository } from "../src/repository";

function createRepository(): AlertRepository {
  const db = new Database(":memory:");
  initializeSchema(db);
  return new AlertRepository(db);
}

describe("AlertRepository", () => {
  it("persists alerts with per-alert recipients", () => {
    const repository = createRepository();
    const alert = repository.addAlert("guild-1", 2, "hours");
    repository.setAlertRecipients(alert.id, ["user-1", "user-2", "user-1"]);

    expect(repository.getAlertRecipients(alert.id)).toEqual(["user-1", "user-2"]);
    expect(repository.listAlerts("guild-1")).toMatchObject([
      {
        id: alert.id,
        amount: 2,
        unit: "hours",
        eventTarget: "interested",
        recipientIds: ["user-1", "user-2"]
      }
    ]);
  });

  it("persists alert-level event targets", () => {
    const repository = createRepository();
    const alert = repository.addAlert("guild-1", 30, "minutes", "all");
    repository.setAlertRecipients(alert.id, ["user-1", "user-2"]);

    expect(repository.getAlert(alert.id)).toMatchObject({ eventTarget: "all" });
  });

  it("updates alert timing and event target together", () => {
    const repository = createRepository();
    const alert = repository.addAlert("guild-1", 30, "minutes");
    repository.setAlertRecipients(alert.id, ["user-1", "user-2"]);

    const updatedAlert = repository.updateAlert(alert.id, 2, "hours", "all");

    expect(updatedAlert).toMatchObject({ amount: 2, unit: "hours", eventTarget: "all", recipientIds: ["user-1", "user-2"] });
  });

  it("lists only alerts a user is subscribed to", () => {
    const repository = createRepository();
    const subscribedAlert = repository.addAlert("guild-1", 30, "minutes");
    const otherAlert = repository.addAlert("guild-1", 2, "hours");
    const otherGuildAlert = repository.addAlert("guild-2", 1, "days");
    repository.setAlertRecipients(subscribedAlert.id, ["user-1"]);
    repository.setAlertRecipients(otherAlert.id, ["user-2"]);
    repository.setAlertRecipients(otherGuildAlert.id, ["user-1"]);

    expect(repository.listSubscribedAlerts("guild-1", "user-1").map((alert) => alert.id)).toEqual([subscribedAlert.id]);
  });

  it("finds alerts by exact offset", () => {
    const repository = createRepository();
    const matchingAlert = repository.addAlert("guild-1", 30, "minutes", "all");
    const wrongUnitAlert = repository.addAlert("guild-1", 30, "hours");
    const wrongGuildAlert = repository.addAlert("guild-2", 30, "minutes");
    const wrongTargetAlert = repository.addAlert("guild-1", 30, "minutes", "interested");
    repository.setAlertRecipients(matchingAlert.id, ["user-1"]);
    repository.setAlertRecipients(wrongUnitAlert.id, ["user-1"]);
    repository.setAlertRecipients(wrongGuildAlert.id, ["user-1"]);
    repository.setAlertRecipients(wrongTargetAlert.id, ["user-1"]);

    expect(repository.findAlertsByOffset("guild-1", 30, "minutes", "all").map((alert) => alert.id)).toEqual([matchingAlert.id]);
  });

  it("adds and removes one recipient without replacing others", () => {
    const repository = createRepository();
    const alert = repository.addAlert("guild-1", 1, "days");
    repository.setAlertRecipients(alert.id, ["user-1"]);

    repository.addAlertRecipient(alert.id, "user-2");
    repository.addAlertRecipient(alert.id, "user-2");
    expect(repository.getAlertRecipients(alert.id)).toEqual(["user-1", "user-2"]);

    repository.removeAlertRecipient(alert.id, "user-2");
    expect(repository.getAlertRecipients(alert.id)).toEqual(["user-1"]);
  });

  it("deletes alerts when their recipient set becomes empty", () => {
    const repository = createRepository();
    const alert = repository.addAlert("guild-1", 30, "minutes");
    repository.setAlertRecipients(alert.id, ["user-1"]);

    repository.removeAlertRecipient(alert.id, "user-1");

    expect(repository.getAlert(alert.id)).toBeNull();
    expect(repository.listAlerts("guild-1")).toEqual([]);
  });

  it("deletes abandoned recipientless alerts from alert listings", () => {
    const repository = createRepository();
    const abandonedAlert = repository.addAlert("guild-1", 30, "minutes");
    const activeAlert = repository.addAlert("guild-1", 1, "days");
    repository.setAlertRecipients(activeAlert.id, ["user-1"]);

    expect(repository.listAlerts("guild-1").map((alert) => alert.id)).toEqual([activeAlert.id]);
    expect(repository.getAlert(abandonedAlert.id)).toBeNull();
  });

  it("merges duplicate alerts with the same timing and filter during listings", () => {
    const repository = createRepository();
    const canonicalAlert = repository.addAlert("guild-1", 1, "days", "interested");
    const duplicateAlert = repository.addAlert("guild-1", 1, "days", "interested");
    const distinctFilterAlert = repository.addAlert("guild-1", 1, "days", "all");
    repository.setAlertRecipients(canonicalAlert.id, ["user-1"]);
    repository.setAlertRecipients(duplicateAlert.id, ["user-2"]);
    repository.setAlertRecipients(distinctFilterAlert.id, ["user-3"]);

    const alerts = repository.listAlerts("guild-1");

    expect(alerts.map((alert) => alert.id)).toEqual([distinctFilterAlert.id, canonicalAlert.id]);
    expect(repository.getAlert(duplicateAlert.id)).toBeNull();
    expect(repository.getAlertRecipients(canonicalAlert.id)).toEqual(["user-1", "user-2"]);
  });

  it("moves duplicate sent history to the canonical alert when merging duplicate alerts", () => {
    const repository = createRepository();
    const canonicalAlert = repository.addAlert("guild-1", 1, "days", "interested");
    const duplicateAlert = repository.addAlert("guild-1", 1, "days", "interested");
    repository.setAlertRecipients(canonicalAlert.id, ["user-1"]);
    repository.setAlertRecipients(duplicateAlert.id, ["user-2"]);
    repository.recordSentAlert({
      guildId: "guild-1",
      eventId: "event-1",
      alertId: duplicateAlert.id,
      eventName: "Session",
      scheduledStartAt: "2026-01-01T12:00:00.000Z",
      offsetAmount: 1,
      offsetUnit: "days",
      attemptedRecipientIds: ["user-2"],
      successfulRecipientIds: ["user-2"],
      failedRecipients: [],
      errorSummary: null,
      sentAt: "2026-01-01T11:30:00.000Z"
    });

    repository.listAlerts("guild-1");

    expect(repository.hasSentAlert("guild-1", "event-1", canonicalAlert.id)).toBe(true);
    expect(repository.hasSentAlert("guild-1", "event-1", duplicateAlert.id)).toBe(false);
  });

  it("deletes alert recipients with the alert", () => {
    const repository = createRepository();
    const alert = repository.addAlert("guild-1", 1, "days");
    repository.setAlertRecipients(alert.id, ["user-1"]);

    repository.deleteAlert(alert.id);

    expect(repository.getAlert(alert.id)).toBeNull();
    expect(repository.getAlertRecipients(alert.id)).toEqual([]);
  });

  it("keeps sent alert history unique per guild event and alert", () => {
    const repository = createRepository();
    const alert = repository.addAlert("guild-1", 30, "minutes");

    const sentAlert = {
      guildId: "guild-1",
      eventId: "event-1",
      alertId: alert.id,
      eventName: "Session",
      scheduledStartAt: "2026-01-01T12:00:00.000Z",
      offsetAmount: alert.amount,
      offsetUnit: alert.unit,
      attemptedRecipientIds: ["user-1"],
      successfulRecipientIds: ["user-1"],
      failedRecipients: [],
      errorSummary: null,
      sentAt: "2026-01-01T11:30:00.000Z"
    };

    repository.recordSentAlert(sentAlert);
    repository.recordSentAlert(sentAlert);

    expect(repository.hasSentAlert("guild-1", "event-1", alert.id)).toBe(true);
    expect(repository.listSentHistory("guild-1", 0, 10)).toHaveLength(1);
  });

  it("lists sent history by send time descending", () => {
    const repository = createRepository();
    const alert = repository.addAlert("guild-1", 30, "minutes");

    for (const [eventId, eventName, scheduledStartAt, sentAt] of [
      ["event-early", "Early", "2026-01-03T12:00:00.000Z", "2026-01-01T10:00:00.000Z"],
      ["event-late", "Late", "2026-01-01T12:00:00.000Z", "2026-01-03T10:00:00.000Z"],
      ["event-middle", "Middle", "2026-01-02T12:00:00.000Z", "2026-01-02T10:00:00.000Z"]
    ]) {
      repository.recordSentAlert({
        guildId: "guild-1",
        eventId,
        alertId: alert.id,
        eventName,
        scheduledStartAt,
        offsetAmount: alert.amount,
        offsetUnit: alert.unit,
        attemptedRecipientIds: ["user-1"],
        successfulRecipientIds: ["user-1"],
        failedRecipients: [],
        errorSummary: null,
        sentAt
      });
    }

    expect(repository.listSentHistory("guild-1", 0, 10).map((entry) => entry.eventName)).toEqual([
      "Late",
      "Middle",
      "Early"
    ]);
  });

  it("clears sent history for one guild", () => {
    const repository = createRepository();
    const guildOneAlert = repository.addAlert("guild-1", 30, "minutes");
    const guildTwoAlert = repository.addAlert("guild-2", 30, "minutes");

    for (const [guildId, alertId] of [
      ["guild-1", guildOneAlert.id],
      ["guild-2", guildTwoAlert.id]
    ]) {
      repository.recordSentAlert({
        guildId,
        eventId: `event-${guildId}`,
        alertId,
        eventName: `Event ${guildId}`,
        scheduledStartAt: "2026-01-01T12:00:00.000Z",
        offsetAmount: 30,
        offsetUnit: "minutes",
        attemptedRecipientIds: ["user-1"],
        successfulRecipientIds: ["user-1"],
        failedRecipients: [],
        errorSummary: null,
        sentAt: "2026-01-01T11:30:00.000Z"
      });
    }

    repository.clearSentHistory("guild-1");

    expect(repository.listSentHistory("guild-1", 0, 10)).toEqual([]);
    expect(repository.listSentHistory("guild-2", 0, 10)).toHaveLength(1);
  });
});

describe("auto-start settings", () => {
  it("defaults to disabled for every guild", () => {
    const repository = createRepository();
    repository.ensureGuild("guild-1");

    expect(repository.isAutoStartEnabled("guild-1")).toBe(false);
    expect(repository.listAutoStartGuildIds()).toEqual([]);
  });

  it("returns false for a guild that has never been configured", () => {
    const repository = createRepository();

    expect(repository.isAutoStartEnabled("non-existent")).toBe(false);
  });

  it("toggles auto-start on and off", () => {
    const repository = createRepository();
    repository.ensureGuild("guild-1");

    repository.setAutoStartEnabled("guild-1", true);
    expect(repository.isAutoStartEnabled("guild-1")).toBe(true);
    expect(repository.listAutoStartGuildIds()).toEqual(["guild-1"]);

    repository.setAutoStartEnabled("guild-1", false);
    expect(repository.isAutoStartEnabled("guild-1")).toBe(false);
    expect(repository.listAutoStartGuildIds()).toEqual([]);
  });

  it("lists only guilds with auto-start enabled", () => {
    const repository = createRepository();
    repository.ensureGuild("guild-1");
    repository.ensureGuild("guild-2");
    repository.ensureGuild("guild-3");

    repository.setAutoStartEnabled("guild-1", true);
    repository.setAutoStartEnabled("guild-3", true);

    expect(repository.listAutoStartGuildIds()).toEqual(["guild-1", "guild-3"]);
  });

  it("creates a guild row on setAutoStartEnabled when the guild is new", () => {
    const repository = createRepository();

    repository.setAutoStartEnabled("guild-1", true);

    expect(repository.isAutoStartEnabled("guild-1")).toBe(true);
    expect(repository.listConfiguredGuildIds()).toEqual(["guild-1"]);
  });
});

describe("mention notifications", () => {
  it("defaults to enabled for any user", () => {
    const repository = createRepository();
    repository.ensureGuild("guild-1");

    expect(repository.isMentionNotificationsEnabled("guild-1", "user-1")).toBe(true);
  });

  it("toggles mention notifications off and on", () => {
    const repository = createRepository();
    repository.ensureGuild("guild-1");

    repository.setMentionNotificationsEnabled("guild-1", "user-1", false);
    expect(repository.isMentionNotificationsEnabled("guild-1", "user-1")).toBe(false);

    repository.setMentionNotificationsEnabled("guild-1", "user-1", true);
    expect(repository.isMentionNotificationsEnabled("guild-1", "user-1")).toBe(true);
  });

  it("is scoped per guild", () => {
    const repository = createRepository();
    repository.ensureGuild("guild-1");
    repository.ensureGuild("guild-2");

    repository.setMentionNotificationsEnabled("guild-1", "user-1", false);

    expect(repository.isMentionNotificationsEnabled("guild-1", "user-1")).toBe(false);
    expect(repository.isMentionNotificationsEnabled("guild-2", "user-1")).toBe(true);
  });
});

describe("mention channel", () => {
  it("returns null when no channel is configured", () => {
    const repository = createRepository();
    repository.ensureGuild("guild-1");

    expect(repository.getMentionChannelId("guild-1")).toBeNull();
  });

  it("sets and retrieves the mention channel", () => {
    const repository = createRepository();
    repository.ensureGuild("guild-1");

    repository.setMentionChannelId("guild-1", "channel-123");
    expect(repository.getMentionChannelId("guild-1")).toBe("channel-123");
  });

  it("clears the mention channel when set to null", () => {
    const repository = createRepository();
    repository.ensureGuild("guild-1");

    repository.setMentionChannelId("guild-1", "channel-123");
    repository.setMentionChannelId("guild-1", null);

    expect(repository.getMentionChannelId("guild-1")).toBeNull();
  });

  it("returns null for unconfigured guild", () => {
    const repository = createRepository();

    expect(repository.getMentionChannelId("non-existent")).toBeNull();
  });
});
