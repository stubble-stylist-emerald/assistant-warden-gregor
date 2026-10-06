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
  AlertOffsetUnit,
  DefaultReminder,
  DueAlert,
  DueChannelReminder,
  EventChange,
  EventTracking,
  EventTrackingState,
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

// Single source of truth for mapping a Discord event's mutable state into the
// tracked snapshot. Used by both registration (message handler) and the poll,
// so the two can never derive location/channel/start differently.
export function eventTrackingStateFromDiscord(event: GuildScheduledEvent): EventTrackingState {
  return {
    lastKnownStartAt: event.scheduledStartAt?.toISOString() ?? null,
    lastKnownChannelId: event.channelId ?? null,
    lastKnownLocation: event.entityMetadata?.location ?? null
  };
}

// Which events are due for a channel reminder. Channel delivery is driven by the
// guild's admin-configured default reminder offset (decoupled from the DM alert
// list, so member subscriptions never cause channel traffic). One reminder per
// event when the offset comes due.
export function findDueChannelReminders(
  events: ScheduledEventSnapshot[],
  defaultReminders: Map<string, DefaultReminder>,
  now: Date
): DueChannelReminder[] {
  const reminders: DueChannelReminder[] = [];

  for (const event of events) {
    if (!event.scheduledStartAt || event.status !== GuildScheduledEventStatus.Scheduled) {
      continue;
    }

    const reminder = defaultReminders.get(event.guildId);
    if (!reminder) {
      continue;
    }

    const alertAt = new Date(event.scheduledStartAt.getTime() - offsetToMilliseconds(reminder.amount, reminder.unit));
    if (alertAt.getTime() <= now.getTime() && now.getTime() < event.scheduledStartAt.getTime()) {
      reminders.push({ guildId: event.guildId, event, amount: reminder.amount, unit: reminder.unit });
    }
  }

  return reminders;
}

// Shared key for the (guild, event) tracking map, so the pure detector and its
// I/O caller can never disagree on the format.
export function eventTrackingKey(guildId: string, eventId: string): string {
  return `${guildId}:${eventId}`;
}

// Detect reschedules, location changes, cancellations, and completions for
// tracked events. Recurring events cannot be registered as targets (see the
// message handler), so they are skipped — defensively, since their start time
// cycles each occurrence. Pure and unit-testable.
export function detectEventChanges(
  events: ScheduledEventSnapshot[],
  tracking: Map<string, EventTracking>
): EventChange[] {
  const changes: EventChange[] = [];

  for (const event of events) {
    const previous = tracking.get(eventTrackingKey(event.guildId, event.id));
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

    // Location covers both channel (voice/stage) and external text locations;
    // either changing is reported as a single "location_changed".
    if (event.channelId !== previous.lastKnownChannelId || event.location !== previous.lastKnownLocation) {
      changes.push({ guildId: event.guildId, event, type: "location_changed" });
    }

    const currentStart = event.scheduledStartAt?.toISOString() ?? null;
    if (currentStart !== previous.lastKnownStartAt) {
      changes.push({ guildId: event.guildId, event, type: "rescheduled" });
    }
  }

  return changes;
}

export async function runAlertPoll(client: Client, repository: AlertRepository, now = new Date()): Promise<void> {
  // Capture tracked state BEFORE fetching events. A channel registered during
  // this poll's async work must never be mistaken for a deleted event and pruned
  // (the poll overlap guard does not serialize concurrent message handlers).
  const tracking = new Map<string, EventTracking>();
  for (const configuredGuildId of repository.listConfiguredGuildIds()) {
    for (const eventId of repository.listTrackedEventIds(configuredGuildId)) {
      const state = repository.getEventTracking(configuredGuildId, eventId);
      if (state) {
        tracking.set(eventTrackingKey(configuredGuildId, eventId), state);
      }
    }
  }

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

  // Channel reminders: driven by each guild's default reminder offset, decoupled
  // from the DM alert list. Each post is deduped per channel.
  const defaultReminders = new Map(
    repository.listGuildDefaultReminders().map((reminder) => [reminder.guildId, reminder])
  );
  const dueChannelReminders = findDueChannelReminders(events, defaultReminders, now);
  for (const reminder of dueChannelReminders) {
    try {
      await sendChannelReminder(client, repository, reminder);
    } catch (error) {
      console.warn(
        `[channel-reminder] Failed for event ${reminder.event.id} in guild ${reminder.guildId}:`,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  // Prune tracking for events that vanished from Discord: only records captured
  // before this poll started are candidates (see the capture above).
  const liveEventKeys = new Set(events.map((event) => eventTrackingKey(event.guildId, event.id)));
  for (const [key, state] of tracking) {
    if (!liveEventKeys.has(key)) {
      repository.removeEventTracking(state.guildId, state.eventId);
    }
  }

  // Event update notices (reschedule / location change / cancellation).
  for (const change of detectEventChanges(events, tracking)) {
    try {
      await handleEventChange(client, repository, change);
    } catch (error) {
      console.warn(
        `[event-update] Failed to handle ${change.type} for event ${change.event.id}:`,
        error instanceof Error ? error.message : String(error)
      );
    }
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
      const state = eventTrackingStateFromDiscord(event);
      snapshots.push({
        id: event.id,
        guildId,
        name: event.name,
        scheduledStartAt: event.scheduledStartAt,
        status: event.status,
        isRecurring: event.recurrenceRule != null,
        channelId: state.lastKnownChannelId,
        location: state.lastKnownLocation,
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
  // Dedupe keyed by the default offset so each channel gets one reminder.
  const dedupeKey = channelReminderDedupeKey(reminder.amount, reminder.unit);

  for (const association of associations) {
    if (repository.hasSentChannelAlert(reminder.guildId, reminder.event.id, dedupeKey, association.channelId)) {
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
      repository.recordSentChannelAlert({
        guildId: reminder.guildId,
        eventId: reminder.event.id,
        dedupeKey,
        channelId: association.channelId,
        eventName: reminder.event.name,
        offsetAmount: reminder.amount,
        offsetUnit: reminder.unit
      });
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
  const dedupeKey = eventChangeDedupeKey(event, type);
  let allDelivered = true;

  for (const association of associations) {
    if (repository.hasSentChannelAlert(guildId, event.id, dedupeKey, association.channelId)) {
      continue;
    }

    try {
      const channel = await client.channels.fetch(association.channelId);
      if (!channel || !isSendableGuildText(channel)) {
        repository.removeEventChannel(guildId, event.id, association.channelId);
        continue;
      }

      await channel.send(buildEventUpdateMessage(event, type));
      repository.recordSentChannelAlert({
        guildId,
        eventId: event.id,
        dedupeKey,
        channelId: association.channelId,
        eventName: event.name
      });
    } catch (error) {
      allDelivered = false;
      console.warn(
        `[event-update] Failed to post ${type} notice for event ${event.id} in channel ${association.channelId}:`,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  // If any delivery failed, keep the previous tracking snapshot so the change is
  // re-detected and retried next poll. Already-delivered channels are skipped by
  // the per-channel dedupe, so retries never duplicate.
  if (!allDelivered) {
    return;
  }

  if (type === "cancelled") {
    repository.removeEventTracking(guildId, event.id);
  } else {
    repository.updateEventTracking(guildId, event.id, {
      lastKnownStartAt: event.scheduledStartAt?.toISOString() ?? null,
      lastKnownChannelId: event.channelId,
      lastKnownLocation: event.location
    });
  }
}

// Channel reminder posted to channels that registered an event link. Kept
// minimal so Discord's native event card (unfurled from the link) carries the
// name, time, and "Interested" controls.
export function buildChannelReminder(event: ScheduledEventSnapshot): MessageCreateOptions {
  return { content: `📅 Event reminder: ${buildEventLink(event.guildId, event.id)}` };
}

// Notice posted to channels when a tracked event is rescheduled, relocated, or
// cancelled. Kept minimal so Discord's native event card carries the details.
// "completed" is excluded — a completed event never produces a message.
export function buildEventUpdateMessage(
  event: ScheduledEventSnapshot,
  type: Exclude<EventChange["type"], "completed">
): MessageCreateOptions {
  if (type === "cancelled") {
    return { content: `❌ Event cancelled: ${buildEventLink(event.guildId, event.id)}` };
  }

  if (type === "location_changed") {
    return { content: `📍 Event location changed: ${buildEventLink(event.guildId, event.id)}` };
  }

  return { content: `🔄 Event rescheduled: ${buildEventLink(event.guildId, event.id)}` };
}

// Canonical Discord scheduled-event URL, which unfurls into the native event card.
export function buildEventLink(guildId: string, eventId: string): string {
  return `https://discord.com/events/${guildId}/${eventId}`;
}

// Dedupe key for a channel reminder: keyed by effective offset so same-timing
// rules collapse to one delivery regardless of which rule fires.
export function channelReminderDedupeKey(amount: number, unit: AlertOffsetUnit): string {
  return `reminder:${offsetToMilliseconds(amount, unit)}`;
}

// Dedupe key for an event update notice: keyed by the event's new state, so a
// pending (undelivered) notice stays stable across retry polls while a further
// change produces a new key.
export function eventChangeDedupeKey(event: ScheduledEventSnapshot, type: EventChange["type"]): string {
  return `change:${type}:${event.scheduledStartAt?.toISOString() ?? ""}:${event.channelId ?? ""}:${event.location ?? ""}`;
}

// Narrow a fetched channel to something postable (text-based and not a DM).
// Structural parameter keeps this usable without importing the full Channel union.
function isSendableGuildText(channel: { isSendable?: () => boolean }): channel is SendableChannels {
  return typeof channel.isSendable === "function" && channel.isSendable();
}
