import {
  EmbedBuilder,
  GuildScheduledEventStatus,
  type Client,
  type GuildScheduledEvent,
  type MessageCreateOptions,
  type SendableChannels
} from "discord.js";
import { formatOffset, offsetToMilliseconds } from "./offset";
import type { AlertRepository } from "./repository";
import type {
  Alert,
  DueAlert,
  DueChannelReminder,
  EventChange,
  EventTracking,
  FailedRecipient,
  ScheduledEventSnapshot
} from "./types";

// Decide scheduler work without Discord side effects so the core rules are testable.
export function findDueAlerts(input: {
  now: Date;
  events: ScheduledEventSnapshot[];
  alertsByGuild: Map<string, Alert[]>;
  wasSent: (guildId: string, eventId: string, alertId: string) => boolean;
}): DueAlert[] {
  const dueAlerts: DueAlert[] = [];

  for (const event of input.events) {
    const alerts = input.alertsByGuild.get(event.guildId) ?? [];

    if (!event.scheduledStartAt || event.status !== GuildScheduledEventStatus.Scheduled) {
      continue;
    }

    for (const alert of alerts) {
      const targetRecipientIds =
        alert.eventTarget === "all"
          ? alert.recipientIds
          : alert.recipientIds.filter((userId) => event.interestedUserIds.includes(userId));
      if (targetRecipientIds.length === 0 || !alert.enabled || !isAlertDue(event.scheduledStartAt, alert, input.now)) {
        continue;
      }

      if (!input.wasSent(event.guildId, event.id, alert.id)) {
        dueAlerts.push({ guildId: event.guildId, event, alert, recipientIds: targetRecipientIds });
      }
    }
  }

  return dueAlerts;
}

// Find events that have reached or passed their start time and are still Scheduled.
// Pure function with no Discord side effects, so this is fully unit-testable.
export function findEventsToAutoStart(events: ScheduledEventSnapshot[], now: Date): ScheduledEventSnapshot[] {
  return events.filter(
    (event) =>
      event.scheduledStartAt !== null &&
      event.status === GuildScheduledEventStatus.Scheduled &&
      event.scheduledStartAt.getTime() <= now.getTime()
  );
}

export function isAlertDue(eventStart: Date, alert: Alert, now: Date): boolean {
  const alertAt = new Date(eventStart.getTime() - offsetToMilliseconds(alert.amount, alert.unit));
  return alertAt.getTime() <= now.getTime() && now.getTime() < eventStart.getTime();
}

// Which (event, alert) pairs are due for channel reminders. Unlike findDueAlerts
// this ignores DM recipient gating — the channel itself is the interested party
// — but still requires an enabled alert and a due offset.
export function findDueChannelReminders(
  events: ScheduledEventSnapshot[],
  alertsByGuild: Map<string, Alert[]>,
  now: Date
): DueChannelReminder[] {
  const reminders: DueChannelReminder[] = [];

  for (const event of events) {
    if (!event.scheduledStartAt || event.status !== GuildScheduledEventStatus.Scheduled) {
      continue;
    }

    for (const alert of alertsByGuild.get(event.guildId) ?? []) {
      if (!alert.enabled || !isAlertDue(event.scheduledStartAt, alert, now)) {
        continue;
      }

      reminders.push({ guildId: event.guildId, event, alert });
    }
  }

  return reminders;
}

// Compare live events against stored tracking snapshots to detect reschedules
// and cancellations. Recurring events are skipped because their start time and
// status cycle every occurrence. Pure and unit-testable.
export function detectEventChanges(
  events: ScheduledEventSnapshot[],
  tracking: Map<string, EventTracking>
): EventChange[] {
  const changes: EventChange[] = [];

  for (const event of events) {
    const previous = tracking.get(`${event.guildId}:${event.id}`);
    if (!previous) {
      continue;
    }

    if (event.status === GuildScheduledEventStatus.Canceled) {
      changes.push({ guildId: event.guildId, event, type: "cancelled" });
      continue;
    }

    if (event.status === GuildScheduledEventStatus.Completed) {
      changes.push({ guildId: event.guildId, event, type: "completed" });
      continue;
    }

    if (event.isRecurring) {
      continue;
    }

    const currentStart = event.scheduledStartAt?.toISOString() ?? null;
    if (currentStart !== previous.lastKnownStartAt) {
      changes.push({ guildId: event.guildId, event, type: "rescheduled" });
    }
  }

  return changes;
}

export async function runAlertPoll(client: Client, repository: AlertRepository, now = new Date()): Promise<void> {
  const events = await fetchScheduledEvents(client, repository);
  const guildIds = Array.from(new Set(events.map((event) => event.guildId)));
  const alertsByGuild = new Map(guildIds.map((guildId) => [guildId, repository.listAlerts(guildId)]));

  const dueAlerts = findDueAlerts({
    now,
    events,
    alertsByGuild,
    wasSent: (guildId, eventId, alertId) => repository.hasSentAlert(guildId, eventId, alertId)
  });

  for (const dueAlert of dueAlerts) {
    await sendDueAlert(client, repository, dueAlert);
  }

  // Channel reminders: post to every channel associated with a due event,
  // independent of DM recipient gating. Each post is deduped per channel.
  const dueChannelReminders = findDueChannelReminders(events, alertsByGuild, now);
  for (const reminder of dueChannelReminders) {
    await sendChannelReminder(client, repository, reminder);
  }

  // Event update notices (reschedule / cancellation) for tracked events.
  const tracking = new Map<string, EventTracking>();
  for (const event of events) {
    const state = repository.getEventTracking(event.guildId, event.id);
    if (state) {
      tracking.set(`${event.guildId}:${event.id}`, state);
    }
  }
  for (const change of detectEventChanges(events, tracking)) {
    await handleEventChange(client, repository, change);
  }

  // Auto-start events whose start time has arrived. Each call is wrapped so one
  // failure (e.g. missing permissions) never blocks the rest of the poll.
  const autoStartGuildIds = repository.listAutoStartGuildIds();
  const eventsToStart = findEventsToAutoStart(
    events.filter((event) => autoStartGuildIds.includes(event.guildId)),
    now
  );
  for (const event of eventsToStart) {
    try {
      await startEvent(client, event);
    } catch (error) {
      console.error(
        `[auto-start] Unexpected error starting event ${event.id} (${event.name}) in guild ${event.guildId}:`,
        error
      );
    }
  }
}

async function fetchScheduledEvents(client: Client, repository: AlertRepository): Promise<ScheduledEventSnapshot[]> {
  const configuredGuildIds = new Set(repository.listConfiguredGuildIds());
  const snapshots: ScheduledEventSnapshot[] = [];

  for (const [guildId, guild] of client.guilds.cache) {
    if (!configuredGuildIds.has(guildId)) {
      continue;
    }

    const events = await guild.scheduledEvents.fetch();
    for (const [, event] of events) {
      snapshots.push({
        id: event.id,
        guildId,
        name: event.name,
        scheduledStartAt: event.scheduledStartAt,
        status: event.status,
        isRecurring: event.recurrenceRule != null,
        interestedUserIds: await fetchInterestedUserIds(event)
      });
    }
  }

  return snapshots;
}

async function fetchInterestedUserIds(event: GuildScheduledEvent): Promise<string[]> {
  const guild = event.guild;
  if (!guild) {
    return [];
  }

  const userIds = new Set<string>();
  let after: string | undefined;

  while (true) {
    // discord.js supports pagination here at runtime, but the public type omits before/after.
    const subscribers = await guild.scheduledEvents.fetchSubscribers(event.id, { limit: 100, after } as {
      limit: number;
      after?: string;
    });
    for (const userId of subscribers.keys()) {
      userIds.add(userId);
    }

    if (subscribers.size < 100) {
      break;
    }

    after = Array.from(subscribers.keys()).at(-1);
    if (!after) {
      break;
    }
  }

  return Array.from(userIds);
}

async function startEvent(client: Client, event: ScheduledEventSnapshot): Promise<void> {
  const guild = client.guilds.cache.get(event.guildId);
  if (!guild) {
    console.warn(`[auto-start] Guild ${event.guildId} not in cache; skipping event ${event.id} (${event.name}).`);
    return;
  }

  const scheduledEvent = guild.scheduledEvents.cache.get(event.id);
  if (!scheduledEvent) {
    console.warn(`[auto-start] Event ${event.id} (${event.name}) not in cache; skipping.`);
    return;
  }

  try {
    await scheduledEvent.setStatus(GuildScheduledEventStatus.Active, "Auto-started by Gregor.");
    console.log(`[auto-start] Started event ${event.id} (${event.name}) in guild ${event.guildId}.`);
  } catch (error) {
    const code = (error as { code?: number }).code;
    if (code === 10070) {
      console.warn(`[auto-start] Event ${event.id} (${event.name}) no longer exists; skipping.`);
    } else if (code === 50013) {
      console.warn(
        `[auto-start] Missing permissions to start event ${event.id} (${event.name}) in guild ${event.guildId}.`
      );
    } else if (typeof code === "number") {
      // Other Discord API errors (e.g. already active/completed, invalid state) are expected and non-fatal.
      console.warn(
        `[auto-start] Discord error ${code} starting event ${event.id} (${event.name}) in guild ${event.guildId}; skipping.`
      );
    } else {
      throw error;
    }
  }
}

async function sendDueAlert(client: Client, repository: AlertRepository, dueAlert: DueAlert): Promise<void> {
  const attemptedRecipientIds = dueAlert.recipientIds;
  const successfulRecipientIds: string[] = [];
  const failedRecipients: FailedRecipient[] = [];

  for (const userId of attemptedRecipientIds) {
    try {
      const user = await client.users.fetch(userId);
      await user.send(buildAlertMessage(dueAlert));
      successfulRecipientIds.push(userId);
    } catch (error) {
      failedRecipients.push({ userId, error: error instanceof Error ? error.message : String(error) });
    }
  }

  repository.recordSentAlert({
    guildId: dueAlert.guildId,
    eventId: dueAlert.event.id,
    alertId: dueAlert.alert.id,
    eventName: dueAlert.event.name,
    scheduledStartAt: dueAlert.event.scheduledStartAt?.toISOString() ?? new Date().toISOString(),
    offsetAmount: dueAlert.alert.amount,
    offsetUnit: dueAlert.alert.unit,
    attemptedRecipientIds,
    successfulRecipientIds,
    failedRecipients,
    errorSummary: failedRecipients.length > 0 ? `${failedRecipients.length} recipient(s) failed` : null
  });
}

export function buildAlertMessage(dueAlert: DueAlert): MessageCreateOptions {
  const startTimestamp = Math.floor((dueAlert.event.scheduledStartAt?.getTime() ?? Date.now()) / 1000);
  const alertTiming = formatOffset(dueAlert.alert.amount, dueAlert.alert.unit);
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(dueAlert.event.name)
    .setDescription(`Starts <t:${startTimestamp}:R>`)
    .addFields(
      { name: "Start time", value: `<t:${startTimestamp}:F>`, inline: false },
      { name: "Reminder", value: `${alertTiming} before start`, inline: true }
    )
    .setFooter({ text: "Gregor event reminder" })
    .setTimestamp(new Date());

  return {
    content: "Event reminder",
    embeds: [embed]
  };
}

async function sendChannelReminder(
  client: Client,
  repository: AlertRepository,
  reminder: DueChannelReminder
): Promise<void> {
  const associations = repository.listEventChannelsForEvent(reminder.guildId, reminder.event.id);

  for (const association of associations) {
    if (repository.hasSentChannelAlert(reminder.guildId, reminder.event.id, reminder.alert.id, association.channelId)) {
      continue;
    }

    try {
      const channel = await client.channels.fetch(association.channelId);
      if (!channel || !isSendableGuildText(channel)) {
        // Channel deleted or no longer postable — drop the association.
        repository.removeEventChannel(reminder.guildId, reminder.event.id, association.channelId);
        continue;
      }

      await channel.send(buildChannelReminder(reminder.event));
      repository.recordSentChannelAlert(reminder.guildId, reminder.event.id, reminder.alert.id, association.channelId);
    } catch (error) {
      console.warn(
        `[channel-reminder] Failed to post for event ${reminder.event.id} in channel ${association.channelId}:`,
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}

async function handleEventChange(
  client: Client,
  repository: AlertRepository,
  change: EventChange
): Promise<void> {
  const { guildId, event, type } = change;

  // Completed events are terminal — silently stop tracking.
  if (type === "completed") {
    repository.removeEventTracking(guildId, event.id);
    return;
  }

  const associations = repository.listEventChannelsForEvent(guildId, event.id);
  for (const association of associations) {
    try {
      const channel = await client.channels.fetch(association.channelId);
      if (!channel || !isSendableGuildText(channel)) {
        repository.removeEventChannel(guildId, event.id, association.channelId);
        continue;
      }

      await channel.send(buildEventUpdateMessage(event, type));
    } catch (error) {
      console.warn(
        `[event-update] Failed to post ${type} notice for event ${event.id} in channel ${association.channelId}:`,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  if (type === "cancelled") {
    repository.removeEventTracking(guildId, event.id);
  } else {
    repository.updateEventTracking(guildId, event.id, event.scheduledStartAt?.toISOString() ?? null, event.status);
  }
}

// Channel reminder posted to channels that registered an event link. Kept
// minimal so Discord's native event card (unfurled from the link) carries the
// name, time, and "Interested" controls.
export function buildChannelReminder(event: ScheduledEventSnapshot): MessageCreateOptions {
  return { content: `📅 Event reminder: ${buildEventLink(event.guildId, event.id)}` };
}

// Notice posted to channels when a tracked event is rescheduled or cancelled.
export function buildEventUpdateMessage(event: ScheduledEventSnapshot, type: EventChange["type"]): MessageCreateOptions {
  if (type === "cancelled") {
    return { content: `❌ Event cancelled: ${buildEventLink(event.guildId, event.id)}` };
  }

  return { content: `🔄 Event rescheduled: ${buildEventLink(event.guildId, event.id)}` };
}

// Canonical Discord scheduled-event URL, which unfurls into the native event card.
export function buildEventLink(guildId: string, eventId: string): string {
  return `https://discord.com/events/${guildId}/${eventId}`;
}

function isSendableGuildText(channel: { isSendable?: () => boolean }): channel is SendableChannels {
  return typeof channel.isSendable === "function" && channel.isSendable();
}
