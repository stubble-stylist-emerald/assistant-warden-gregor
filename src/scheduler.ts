import {
  ChannelType,
  EmbedBuilder,
  GuildScheduledEventStatus,
  type Client,
  type GuildScheduledEvent,
  type MessageCreateOptions,
  type TextChannel
} from "discord.js";
import { parseMentionedUsers, resolveRoleMembers } from "./mentions";
import { formatOffset, offsetToMilliseconds } from "./offset";
import type { AlertRepository } from "./repository";
import type { Alert, DueAlert, FailedRecipient, ScheduledEventSnapshot } from "./types";

// Decide scheduler work without Discord side effects so the core rules are testable.
export function findDueAlerts(input: {
  now: Date;
  events: ScheduledEventSnapshot[];
  alertsByGuild: Map<string, Alert[]>;
  wasSent: (guildId: string, eventId: string, alertId: string) => boolean;
  isMentionEnabled: (guildId: string, userId: string) => boolean;
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

      // Add mentioned users who have mention notifications enabled and aren't already recipients.
      const mentionRecipients =
        alert.eventTarget !== "all"
          ? event.mentionedUserIds.filter(
              (userId) =>
                input.isMentionEnabled(event.guildId, userId) &&
                !targetRecipientIds.includes(userId)
            )
          : [];

      const allRecipientIds = [...targetRecipientIds, ...mentionRecipients];
      if (allRecipientIds.length === 0 || !alert.enabled || !isAlertDue(event.scheduledStartAt, alert, input.now)) {
        continue;
      }

      if (!input.wasSent(event.guildId, event.id, alert.id)) {
        dueAlerts.push({ guildId: event.guildId, event, alert, recipientIds: allRecipientIds });
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

export async function runAlertPoll(client: Client, repository: AlertRepository, now = new Date()): Promise<void> {
  const events = await fetchScheduledEvents(client, repository);
  const guildIds = Array.from(new Set(events.map((event) => event.guildId)));
  const alertsByGuild = new Map(guildIds.map((guildId) => [guildId, repository.listAlerts(guildId)]));

  const dueAlerts = findDueAlerts({
    now,
    events,
    alertsByGuild,
    wasSent: (guildId, eventId, alertId) => repository.hasSentAlert(guildId, eventId, alertId),
    isMentionEnabled: (guildId, userId) => repository.isMentionNotificationsEnabled(guildId, userId)
  });

  for (const dueAlert of dueAlerts) {
    await sendDueAlert(client, repository, dueAlert);
  }

  // Post mention notifications to configured channels. One message per event
  // regardless of how many alert offsets fired for it.
  const postedChannelEvents = new Set<string>();
  for (const dueAlert of dueAlerts) {
    const eventKey = `${dueAlert.guildId}:${dueAlert.event.id}`;
    if (
      dueAlert.event.mentionedUserIds.length === 0 ||
      postedChannelEvents.has(eventKey)
    ) {
      continue;
    }

    const channelId = repository.getMentionChannelId(dueAlert.guildId);
    if (!channelId) {
      continue;
    }

    try {
      const channel = await client.channels.fetch(channelId);
      if (channel?.type === ChannelType.GuildText) {
        await (channel as TextChannel).send(buildMentionChannelMessage(dueAlert));
        postedChannelEvents.add(eventKey);
      }
    } catch (error) {
      console.warn(
        `[mentions] Failed to post channel notification for event ${dueAlert.event.id} in guild ${dueAlert.guildId}:`,
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

    // Collect all role IDs across events so we resolve members once per guild.
    const allRoleIds = new Set<string>();
    const perEventMentions = new Map<string, { directMentions: string[]; roleIds: string[] }>();
    for (const [, event] of events) {
      const { userIds: directMentions, roleIds } = parseMentionedUsers(event.description);
      perEventMentions.set(event.id, { directMentions, roleIds });
      for (const roleId of roleIds) {
        allRoleIds.add(roleId);
      }
    }

    const roleMembers = await resolveRoleMembers(guild, Array.from(allRoleIds));

    for (const [, event] of events) {
      const mentions = perEventMentions.get(event.id) ?? { directMentions: [], roleIds: [] };
      const mentionedUserIds = Array.from(
        new Set([
          ...mentions.directMentions,
          ...roleMembers.filter((userId) => {
            // Only include role members whose role was mentioned for this specific event.
            const member = guild.members.cache.get(userId);
            return member && mentions.roleIds.some((roleId) => member.roles.cache.has(roleId));
          })
        ])
      );

      snapshots.push({
        id: event.id,
        guildId,
        name: event.name,
        scheduledStartAt: event.scheduledStartAt,
        status: event.status,
        interestedUserIds: await fetchInterestedUserIds(event),
        mentionedUserIds
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

// Channel notification message posted to the guild's configured mention channel.
// Discord renders @mentions in the event description natively, so we don't
// need to reconstruct them — just link to the event.
function buildMentionChannelMessage(dueAlert: DueAlert): MessageCreateOptions {
  const startTimestamp = Math.floor((dueAlert.event.scheduledStartAt?.getTime() ?? Date.now()) / 1000);
  const mentionedCount = dueAlert.event.mentionedUserIds.length;

  return {
    content: [
      `**${dueAlert.event.name}** starts <t:${startTimestamp}:R>`,
      `— you were @mentioned in the event description.`
    ].join(" ")
  };
}
