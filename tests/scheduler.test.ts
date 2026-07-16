import { GuildScheduledEventStatus } from "discord.js";
import { describe, expect, it } from "vitest";
import { buildAlertMessage, findDueAlerts, findEventsToAutoStart, isAlertDue } from "../src/scheduler";
import type { Alert, ScheduledEventSnapshot } from "../src/types";

const baseAlert: Alert = {
  id: "alert-1",
  guildId: "guild-1",
  amount: 30,
  unit: "minutes",
  eventTarget: "interested",
  recipientIds: ["user-1"],
  enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};

const baseEvent: ScheduledEventSnapshot = {
  id: "event-1",
  guildId: "guild-1",
  name: "Session",
  scheduledStartAt: new Date("2026-01-01T12:00:00.000Z"),
  status: GuildScheduledEventStatus.Scheduled,
  interestedUserIds: ["user-1"],
  mentionedUserIds: []
};

describe("scheduler due alerts", () => {
  it("is due between alert time and event start", () => {
    expect(isAlertDue(baseEvent.scheduledStartAt!, baseAlert, new Date("2026-01-01T11:30:00.000Z"))).toBe(true);
    expect(isAlertDue(baseEvent.scheduledStartAt!, baseAlert, new Date("2026-01-01T11:45:00.000Z"))).toBe(true);
  });

  it("is not due before alert time or after event start", () => {
    expect(isAlertDue(baseEvent.scheduledStartAt!, baseAlert, new Date("2026-01-01T11:29:59.000Z"))).toBe(false);
    expect(isAlertDue(baseEvent.scheduledStartAt!, baseAlert, new Date("2026-01-01T12:00:00.000Z"))).toBe(false);
  });

  it("finds unsent due alerts with per-alert recipients", () => {
    const due = findDueAlerts({
      now: new Date("2026-01-01T11:45:00.000Z"),
      events: [baseEvent],
      alertsByGuild: new Map([["guild-1", [baseAlert]]]),
      wasSent: () => false,
      isMentionEnabled: () => true
    });

    expect(due).toMatchObject([{ alert: baseAlert, recipientIds: ["user-1"] }]);
  });

  it("only alerts recipients interested in the scheduled event", () => {
    const due = findDueAlerts({
      now: new Date("2026-01-01T11:45:00.000Z"),
      events: [{ ...baseEvent, interestedUserIds: ["user-2"] }],
      alertsByGuild: new Map([
        [
          "guild-1",
          [
            {
              ...baseAlert,
              recipientIds: ["user-1", "user-2", "user-3"]
            }
          ]
        ]
      ]),
      wasSent: () => false,
      isMentionEnabled: () => true
    });

    expect(due).toMatchObject([{ recipientIds: ["user-2"] }]);
  });

  it("alerts all-target recipients even when they are not interested in the event", () => {
    const due = findDueAlerts({
      now: new Date("2026-01-01T11:45:00.000Z"),
      events: [{ ...baseEvent, interestedUserIds: [] }],
      alertsByGuild: new Map([["guild-1", [{ ...baseAlert, eventTarget: "all" }]]]),
      wasSent: () => false,
      isMentionEnabled: () => true
    });

    expect(due).toMatchObject([{ recipientIds: ["user-1"] }]);
  });

  it("skips due alerts when no configured recipients are interested yet", () => {
    const due = findDueAlerts({
      now: new Date("2026-01-01T11:45:00.000Z"),
      events: [{ ...baseEvent, interestedUserIds: ["user-2"] }],
      alertsByGuild: new Map([["guild-1", [baseAlert]]]),
      wasSent: () => false,
      isMentionEnabled: () => true
    });

    expect(due).toHaveLength(0);
  });

  it("skips sent, completed, and recipientless alerts", () => {
    expect(
      findDueAlerts({
        now: new Date("2026-01-01T11:45:00.000Z"),
        events: [baseEvent],
        alertsByGuild: new Map([["guild-1", [baseAlert]]]),
        wasSent: () => true,
        isMentionEnabled: () => true
      })
    ).toHaveLength(0);

    expect(
      findDueAlerts({
        now: new Date("2026-01-01T11:45:00.000Z"),
        events: [{ ...baseEvent, status: GuildScheduledEventStatus.Completed }],
        alertsByGuild: new Map([["guild-1", [baseAlert]]]),
        wasSent: () => false,
        isMentionEnabled: () => true
      })
    ).toHaveLength(0);

    expect(
      findDueAlerts({
        now: new Date("2026-01-01T11:45:00.000Z"),
        events: [baseEvent],
        alertsByGuild: new Map([["guild-1", [{ ...baseAlert, recipientIds: [] }]]]),
        wasSent: () => false,
        isMentionEnabled: () => true
      })
    ).toHaveLength(0);
  });

  it("builds a rich DM reminder", () => {
    const message = buildAlertMessage({
      guildId: "guild-1",
      event: baseEvent,
      alert: baseAlert,
      recipientIds: ["user-1"]
    });
    const embed = message.embeds?.[0].toJSON();

    expect(message.content).toBe("Event reminder");
    expect(embed?.title).toBe("Session");
    expect(embed?.description).toBe("Starts <t:1767268800:R>");
    expect(embed?.fields).toMatchObject([
      { name: "Start time", value: "<t:1767268800:F>" },
      { name: "Reminder", value: "30 minutes before start" }
    ]);
  });
});

describe("mention recipients in due alerts", () => {
  it("includes mentioned users with enabled notifications", () => {
    const due = findDueAlerts({
      now: new Date("2026-01-01T11:45:00.000Z"),
      events: [{ ...baseEvent, mentionedUserIds: ["user-2"] }],
      alertsByGuild: new Map([["guild-1", [{ ...baseAlert, recipientIds: ["user-1"] }]]]),
      wasSent: () => false,
      isMentionEnabled: () => true
    });

    expect(due).toMatchObject([{ recipientIds: ["user-1", "user-2"] }]);
  });

  it("excludes mentioned users with disabled notifications", () => {
    const due = findDueAlerts({
      now: new Date("2026-01-01T11:45:00.000Z"),
      events: [{ ...baseEvent, mentionedUserIds: ["user-2"] }],
      alertsByGuild: new Map([["guild-1", [{ ...baseAlert, recipientIds: ["user-1"] }]]]),
      wasSent: () => false,
      isMentionEnabled: (guildId, userId) => userId !== "user-2"
    });

    expect(due).toMatchObject([{ recipientIds: ["user-1"] }]);
  });

  it("does not duplicate mentioned users who are already recipients", () => {
    const due = findDueAlerts({
      now: new Date("2026-01-01T11:45:00.000Z"),
      events: [{ ...baseEvent, mentionedUserIds: ["user-1"] }],
      alertsByGuild: new Map([["guild-1", [{ ...baseAlert, recipientIds: ["user-1"] }]]]),
      wasSent: () => false,
      isMentionEnabled: () => true
    });

    expect(due).toMatchObject([{ recipientIds: ["user-1"] }]);
  });

  it("does not add mention recipients for all-target alerts", () => {
    const due = findDueAlerts({
      now: new Date("2026-01-01T11:45:00.000Z"),
      events: [{ ...baseEvent, mentionedUserIds: ["user-3"] }],
      alertsByGuild: new Map([["guild-1", [{ ...baseAlert, eventTarget: "all" }]]]),
      wasSent: () => false,
      isMentionEnabled: () => true
    });

    // All-target alerts already include all recipients; mentions don't add extras.
    expect(due).toMatchObject([{ recipientIds: ["user-1"] }]);
  });

  it("creates an alert even when the only recipients are mentioned users", () => {
    const due = findDueAlerts({
      now: new Date("2026-01-01T11:45:00.000Z"),
      events: [{ ...baseEvent, interestedUserIds: [], mentionedUserIds: ["user-2"] }],
      alertsByGuild: new Map([["guild-1", [{ ...baseAlert, recipientIds: [] }]]]),
      wasSent: () => false,
      isMentionEnabled: () => true
    });

    expect(due).toMatchObject([{ recipientIds: ["user-2"] }]);
  });
});

describe("findEventsToAutoStart", () => {
  it("returns events at or past their start time with Scheduled status", () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    const events: ScheduledEventSnapshot[] = [
      { ...baseEvent, scheduledStartAt: new Date("2026-01-01T12:00:00.000Z") },
      { ...baseEvent, id: "event-2", scheduledStartAt: new Date("2026-01-01T11:59:59.000Z") }
    ];

    const result = findEventsToAutoStart(events, now);

    expect(result.map((e) => e.id)).toEqual(["event-1", "event-2"]);
  });

  it("skips events whose start time has not yet arrived", () => {
    const now = new Date("2026-01-01T11:59:59.000Z");
    const events: ScheduledEventSnapshot[] = [
      { ...baseEvent, scheduledStartAt: new Date("2026-01-01T12:00:00.000Z") }
    ];

    const result = findEventsToAutoStart(events, now);

    expect(result).toHaveLength(0);
  });

  it("skips events that are not Scheduled", () => {
    const now = new Date("2026-01-01T12:30:00.000Z");
    const events: ScheduledEventSnapshot[] = [
      { ...baseEvent, status: GuildScheduledEventStatus.Active },
      { ...baseEvent, id: "event-2", status: GuildScheduledEventStatus.Completed },
      { ...baseEvent, id: "event-3", status: GuildScheduledEventStatus.Canceled }
    ];

    const result = findEventsToAutoStart(events, now);

    expect(result).toHaveLength(0);
  });

  it("skips events with a null scheduledStartAt", () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    const events: ScheduledEventSnapshot[] = [
      { ...baseEvent, scheduledStartAt: null }
    ];

    const result = findEventsToAutoStart(events, now);

    expect(result).toHaveLength(0);
  });

  it("returns multiple events across guilds that are ready to start", () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    const events: ScheduledEventSnapshot[] = [
      { ...baseEvent, scheduledStartAt: new Date("2026-01-01T12:00:00.000Z") },
      {
        ...baseEvent,
        id: "event-2",
        guildId: "guild-2",
        scheduledStartAt: new Date("2026-01-01T11:30:00.000Z")
      }
    ];

    const result = findEventsToAutoStart(events, now);

    expect(result.map((e) => e.id)).toEqual(["event-1", "event-2"]);
  });
});