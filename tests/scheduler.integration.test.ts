import Database from "better-sqlite3";
import { GuildScheduledEventStatus } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeSchema } from "../src/db";
import { AlertRepository } from "../src/repository";
import { runAlertPoll } from "../src/scheduler";
import type { EventTrackingState } from "../src/types";

// Integration tests for runAlertPoll that need a (mocked) Discord client.
// These reproduce the PR-review findings on the scheduler's async I/O paths.

function createRepository(): AlertRepository {
  const db = new Database(":memory:");
  initializeSchema(db);
  return new AlertRepository(db);
}

const state = (startAt: string): EventTrackingState => ({
  lastKnownStartAt: startAt,
  lastKnownChannelId: null,
  lastKnownLocation: null
});

interface FakeEventSpec {
  id: string;
  startAt: Date;
  status?: number;
  channelId?: string | null;
  location?: string | null;
}

function makeClient(options: { events: FakeEventSpec[]; onFetch?: () => void; onSend?: (channelId: string) => void }) {
  const guildId = "guild-1";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const guild: any = { id: guildId, roles: { cache: new Map() }, members: { cache: new Map(), list: async () => new Map() } };
  const events = options.events.map((spec) => ({
    id: spec.id,
    name: spec.id,
    scheduledStartAt: spec.startAt,
    status: spec.status ?? GuildScheduledEventStatus.Scheduled,
    recurrenceRule: null,
    channelId: spec.channelId ?? null,
    entityMetadata: spec.location ? { location: spec.location } : null,
    guild
  }));
  guild.scheduledEvents = {
    fetch: async () => {
      options.onFetch?.();
      return new Map(events.map((event) => [event.id, event]));
    },
    fetchSubscribers: async () => new Map(),
    cache: new Map()
  };

  const client = {
    guilds: { cache: new Map([[guildId, guild]]) },
    channels: {
      fetch: async (id: string) => ({
        id,
        isSendable: () => true,
        send: async () => {
          options.onSend?.(id);
          return {};
        }
      })
    },
    users: { fetch: async () => ({ send: async () => {} }) }
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any };
}

describe("runAlertPoll integration", () => {
  // The failure-path tests intentionally trigger console.warn; keep output clean.
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps a channel registered during the poll (registration-loss race)", async () => {
    const repository = createRepository();
    repository.registerEventChannel("guild-1", "event-A", "channel-1", state("2026-01-01T12:00:00.000Z"));

    const { client } = makeClient({
      events: [{ id: "event-A", startAt: new Date("2026-01-01T12:00:00.000Z") }],
      // Simulate a message handler registering a brand-new event mid-poll: the
      // event is absent from this poll's snapshot and must NOT be pruned.
      onFetch: () => {
        repository.registerEventChannel("guild-1", "event-B", "channel-2", state("2026-01-02T12:00:00.000Z"));
      }
    });

    await runAlertPoll(client, repository, new Date("2026-01-01T11:00:00.000Z"));

    expect(repository.getEventTracking("guild-1", "event-B")).not.toBeNull();
    expect(repository.listEventChannelsForEvent("guild-1", "event-B")).toHaveLength(1);
  });

  it("retains tracking so a failed change notice is retried, without re-notifying delivered channels", async () => {
    const repository = createRepository();
    repository.registerEventChannel("guild-1", "event-A", "channel-1", state("2026-01-01T12:00:00.000Z"));

    let failNext = true;
    const deliveries: string[] = [];
    const { client } = makeClient({
      // Event was rescheduled from 12:00 to 13:00.
      events: [{ id: "event-A", startAt: new Date("2026-01-01T13:00:00.000Z") }],
      onSend: (channelId) => {
        if (failNext) {
          failNext = false;
          throw new Error("transient send failure");
        }
        deliveries.push(channelId);
      }
    });

    const now = new Date("2026-01-01T11:00:00.000Z");

    // Poll 1: delivery fails → tracking must NOT advance (so the change retries).
    await runAlertPoll(client, repository, now);
    expect(repository.getEventTracking("guild-1", "event-A")?.lastKnownStartAt).toBe("2026-01-01T12:00:00.000Z");

    // Poll 2: delivery succeeds → the notice is delivered and tracking advances.
    await runAlertPoll(client, repository, now);
    expect(deliveries).toEqual(["channel-1"]);
    expect(repository.getEventTracking("guild-1", "event-A")?.lastKnownStartAt).toBe("2026-01-01T13:00:00.000Z");

    // Poll 3: no further change → no duplicate delivery.
    await runAlertPoll(client, repository, now);
    expect(deliveries).toEqual(["channel-1"]);
  });
});
