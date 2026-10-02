import { Client, Events, GatewayIntentBits, GuildScheduledEventStatus, MessageFlags, type Message } from "discord.js";
import { loadConfig } from "./config";
import { openDatabase } from "./db";
import { parseEventLink } from "./eventLinks";
import { handleInteraction } from "./interactions";
import { AlertRepository } from "./repository";
import { runAlertPoll } from "./scheduler";

// Wire Discord, storage, and the polling loop into the runtime process.
async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.databasePath);
  const repository = new AlertRepository(db);
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildScheduledEvents,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent
    ]
  });
  let pollRunning = false;

  // Keep scheduler polls single-flight so slow Discord calls cannot overlap.
  async function pollOnce(): Promise<void> {
    if (pollRunning) {
      console.warn("Skipping alert poll because the previous poll is still running.");
      return;
    }

    pollRunning = true;
    try {
      await runAlertPoll(client, repository);
    } finally {
      pollRunning = false;
    }
  }

  client.once(Events.ClientReady, () => {
    console.log(`Logged in as ${client.user?.tag ?? "unknown bot"}.`);

    void pollOnce().catch((error) => console.error("Initial alert poll failed:", error));
    setInterval(() => {
      void pollOnce().catch((error) => console.error("Alert poll failed:", error));
    }, config.pollIntervalMs);
  });

  client.on("interactionCreate", (interaction) => {
    void handleInteraction(interaction, repository).catch(async (error) => {
      console.error("Interaction failed:", error);
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: "Something went wrong while handling that interaction.",
          flags: MessageFlags.Ephemeral
        });
      }
    });
  });

  // Register a channel as a reminder target when a human posts an event link.
  client.on(Events.MessageCreate, (message) => {
    void registerEventLinkMessage(message, repository).catch((error) => {
      console.error("Event link handling failed:", error);
    });
  });

  process.once("SIGINT", () => {
    db.close();
    client.destroy();
    process.exit(0);
  });

  await client.login(config.discordToken);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

// Detect an event link in a message and record the channel as a reminder target.
async function registerEventLinkMessage(
  message: Message,
  repository: AlertRepository
): Promise<void> {
  if (message.author.bot || !message.inGuild() || !message.guild) {
    return;
  }

  const eventId = parseEventLink(message.content);
  if (!eventId) {
    return;
  }

  let event;
  try {
    event = await message.guild.scheduledEvents.fetch(eventId);
  } catch {
    return; // Not a valid event in this guild.
  }

  if (
    !event ||
    event.status !== GuildScheduledEventStatus.Scheduled ||
    event.recurrenceRule != null
  ) {
    return;
  }

  repository.registerEventChannel(
    message.guild.id,
    event.id,
    message.channelId,
    event.scheduledStartAt?.toISOString() ?? null,
    event.status,
    event.channelId ?? null,
    event.entityMetadata?.location ?? null
  );

  // Best-effort confirmation reaction.
  try {
    await message.react("✅");
  } catch {
    // Missing Add Reactions permission — not fatal.
  }
}
