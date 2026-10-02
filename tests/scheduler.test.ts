import { GuildScheduledEventStatus } from "discord.js";
import { describe, expect, it } from "vitest";
import {
  buildAlertMessage,
  buildChannelReminder,
  buildEventUpdateMessage,
  detectEventChanges,
  findDueAlerts,
  findDueChannelReminders,
  findEventsToAutoStart,
  isAlertDue
} from "../src/scheduler";
import type { Alert, EventTracking, ScheduledEventSnapshot } from "../src/types";

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
  isRecurring: false,
  channelId: "channel-1",
  location: null,
  interestedUserIds: ["user-1"]
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
      wasSent: () => false
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
      wasSent: () => false
    });

    expect(due).toMatchObject([{ recipientIds: ["user-2"] }]);
  });

  it("alerts all-target recipients even when they are not interested in the event", () => {
    const due = findDueAlerts({
      now: new Date("2026-01-01T11:45:00.000Z"),
      events: [{ ...baseEvent, interestedUserIds: [] }],
      alertsByGuild: new Map([["guild-1", [{ ...baseAlert, eventTarget: "all" }]]]),
      wasSent: () => false
    });

    expect(due).toMatchObject([{ recipientIds: ["user-1"] }]);
  });

  it("skips due alerts when no configured recipients are interested yet", () => {
    const due = findDueAlerts({
      now: new Date("2026-01-01T11:45:00.000Z"),
      events: [{ ...baseEvent, interestedUserIds: ["user-2"] }],
      alertsByGuild: new Map([["guild-1", [baseAlert]]]),
      wasSent: () => false
    });

    expect(due).toHaveLength(0);
  });

  it("skips sent, completed, and recipientless alerts", () => {
    expect(
      findDueAlerts({
        now: new Date("2026-01-01T11:45:00.000Z"),
        events: [baseEvent],
        alertsByGuild: new Map([["guild-1", [baseAlert]]]),
        wasSent: () => true
      })
    ).toHaveLength(0);

    expect(
      findDueAlerts({
        now: new Date("2026-01-01T11:45:00.000Z"),
        events: [{ ...baseEvent, status: GuildScheduledEventStatus.Completed }],
        alertsByGuild: new Map([["guild-1", [baseAlert]]]),
        wasSent: () => false
      })
    ).toHaveLength(0);

    expect(
      findDueAlerts({
        now: new Date("2026-01-01T11:45:00.000Z"),
        events: [baseEvent],
        alertsByGuild: new Map([["guild-1", [{ ...baseAlert, recipientIds: [] }]]]),
        wasSent: () => false
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

describe("findDueChannelReminders", () => {
  it("returns a due alert regardless of DM recipient interest", () => {
    const reminders = findDueChannelReminders(
      [{ ...baseEvent, interestedUserIds: [] }],
      new Map([["guild-1", [{ ...baseAlert, recipientIds: ["user-9"] }]]]),
      new Date("2026-01-01T11:45:00.000Z")
    );

    expect(reminders).toHaveLength(1);
    expect(reminders[0].event.id).toBe("event-1");
    expect(reminders[0].alert.id).toBe("alert-1");
  });

  it("returns nothing before the alert offset", () => {
    const reminders = findDueChannelReminders(
      [baseEvent],
      new Map([["guild-1", [baseAlert]]]),
      new Date("2026-01-01T11:00:00.000Z")
    );

    expect(reminders).toHaveLength(0);
  });

  it("returns nothing for disabled alerts or non-scheduled events", () => {
    const disabled = findDueChannelReminders(
      [baseEvent],
      new Map([["guild-1", [{ ...baseAlert, enabled: false }]]]),
      new Date("2026-01-01T11:45:00.000Z")
    );
    const completed = findDueChannelReminders(
      [{ ...baseEvent, status: GuildScheduledEventStatus.Completed }],
      new Map([["guild-1", [baseAlert]]]),
      new Date("2026-01-01T11:45:00.000Z")
    );

    expect(disabled).toHaveLength(0);
    expect(completed).toHaveLength(0);
  });
});

describe("detectEventChanges", () => {
  const tracking = (event: ScheduledEventSnapshot, overrides: Partial<EventTracking> = {}): Map<string, EventTracking> =>
    new Map([
      [
        `${event.guildId}:${event.id}`,
        {
          guildId: event.guildId,
          eventId: event.id,
          lastKnownStartAt: event.scheduledStartAt?.toISOString() ?? null,
          lastKnownStatus: event.status,
          lastKnownChannelId: event.channelId,
          lastKnownLocation: event.location,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          ...overrides
        }
      ]
    ]);

  it("detects a reschedule", () => {
    const moved = { ...baseEvent, scheduledStartAt: new Date("2026-01-01T13:00:00.000Z") };
    const changes = detectEventChanges([moved], tracking(baseEvent));

    expect(changes).toMatchObject([{ type: "rescheduled", event: { id: "event-1" } }]);
  });

  it("reports no change when the start time is unchanged", () => {
    expect(detectEventChanges([baseEvent], tracking(baseEvent))).toHaveLength(0);
  });

  it("detects a cancellation", () => {
    const cancelled = { ...baseEvent, status: GuildScheduledEventStatus.Canceled };
    const changes = detectEventChanges([cancelled], tracking(baseEvent));

    expect(changes).toMatchObject([{ type: "cancelled" }]);
  });

  it("detects completion", () => {
    const completed = { ...baseEvent, status: GuildScheduledEventStatus.Completed };
    const changes = detectEventChanges([completed], tracking(baseEvent));

    expect(changes).toMatchObject([{ type: "completed" }]);
  });

  it("skips reschedule detection for recurring events", () => {
    const recurring = { ...baseEvent, isRecurring: true, scheduledStartAt: new Date("2026-01-01T13:00:00.000Z") };
    const changes = detectEventChanges([recurring], tracking(baseEvent, { lastKnownStartAt: baseEvent.scheduledStartAt!.toISOString() }));

    expect(changes).toHaveLength(0);
  });

  it("ignores events with no tracking record", () => {
    expect(detectEventChanges([baseEvent], new Map())).toHaveLength(0);
  });

  it("detects a channel location change", () => {
    const moved = { ...baseEvent, channelId: "channel-2" };
    const changes = detectEventChanges([moved], tracking(baseEvent));

    expect(changes).toMatchObject([{ type: "location_changed" }]);
  });

  it("detects an external location change", () => {
    const external = { ...baseEvent, channelId: null, location: "Online" };
    const moved = { ...external, location: "Discord Stage" };
    const changes = detectEventChanges([moved], tracking(external));

    expect(changes).toMatchObject([{ type: "location_changed" }]);
  });
});

describe("channel notification messages", () => {
  it("builds a minimal reminder that links the event", () => {
    const message = buildChannelReminder(baseEvent);

    expect(message.content).toBe("📅 Event reminder: https://discord.com/events/guild-1/event-1");
    expect(message.embeds).toBeUndefined();
  });

  it("builds a cancellation notice linking the event", () => {
    const message = buildEventUpdateMessage(baseEvent, "cancelled");

    expect(message.content).toBe("❌ Event cancelled: https://discord.com/events/guild-1/event-1");
    expect(message.embeds).toBeUndefined();
  });

  it("builds a reschedule notice linking the event", () => {
    const message = buildEventUpdateMessage(baseEvent, "rescheduled");

    expect(message.content).toBe("🔄 Event rescheduled: https://discord.com/events/guild-1/event-1");
    expect(message.embeds).toBeUndefined();
  });

  it("builds a location-change notice linking the event", () => {
    const message = buildEventUpdateMessage(baseEvent, "location_changed");

    expect(message.content).toBe("📍 Event location changed: https://discord.com/events/guild-1/event-1");
    expect(message.embeds).toBeUndefined();
  });
});