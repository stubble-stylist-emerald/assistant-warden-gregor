import { Client, GatewayIntentBits, REST, Routes } from "discord.js";
import { EVENT_ALERTS_COMMAND, SUBSCRIBE_COMMAND } from "./commands";
import { loadConfig } from "./config";
import { openDatabase } from "./db";

// Verify the live Discord setup without printing tokens or other secrets.
async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.databasePath);

  // Verify the v5 migration applied the auto_start_enabled column.
  const columns = db.pragma("table_info(guild_settings)") as Array<{ name: string }>;
  const hasAutoStartColumn = columns.some((col) => col.name === "auto_start_enabled");

  // Verify the v6 migration created the event-link reminder tables and the
  // location-tracking columns.
  const tableNames = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
    (row) => row.name
  );
  const hasEventChannelTables =
    tableNames.includes("event_channels") &&
    tableNames.includes("event_tracking") &&
    tableNames.includes("sent_channel_alerts");
  const trackingColumns = (db.pragma("table_info(event_tracking)") as Array<{ name: string }>).map((col) => col.name);
  const hasLocationColumns =
    trackingColumns.includes("last_known_channel_id") && trackingColumns.includes("last_known_location");

  db.close();

  const rest = new REST({ version: "10" }).setToken(config.discordToken);
  const commands = (await rest.get(Routes.applicationCommands(config.discordClientId))) as Array<{ name: string }>;
  const hasEventAlertsCommand = commands.some((command) => command.name === EVENT_ALERTS_COMMAND);
  const hasSubscribeCommand = commands.some((command) => command.name === SUBSCRIBE_COMMAND);

  // Use the same intents as the running bot, so smoke fails fast (close 4014)
  // if the Message Content privileged intent is not enabled in the portal.
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildScheduledEvents,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent
    ]
  });

  const result = await new Promise<{
    readyAs: string;
    guilds: number;
    scheduledEventFetchOk: number;
    scheduledEventFetchFailed: number;
    visibleScheduledEvents: number;
  }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      client.destroy();
      reject(new Error("Discord client did not become ready within 20 seconds."));
    }, 20_000);

    client.once("clientReady", async () => {
      clearTimeout(timeout);
      let scheduledEventFetchOk = 0;
      let scheduledEventFetchFailed = 0;
      let visibleScheduledEvents = 0;

      for (const [, guild] of client.guilds.cache) {
        try {
          const events = await guild.scheduledEvents.fetch();
          scheduledEventFetchOk += 1;
          visibleScheduledEvents += events.size;
        } catch {
          scheduledEventFetchFailed += 1;
        }
      }

      resolve({
        readyAs: client.user?.tag ?? "unknown",
        guilds: client.guilds.cache.size,
        scheduledEventFetchOk,
        scheduledEventFetchFailed,
        visibleScheduledEvents
      });
    });

    client.login(config.discordToken).catch(reject);
  });

  client.destroy();

  console.log(
    JSON.stringify(
      {
        databaseOpened: true,
        hasAutoStartColumn,
        hasEventChannelTables,
        hasLocationColumns,
        hasEventAlertsCommand,
        hasSubscribeCommand,
        ...result
      },
      null,
      2
    )
  );

  if (!hasAutoStartColumn) {
    throw new Error("Database migration v5 did not apply: auto_start_enabled column is missing.");
  }

  if (!hasEventChannelTables) {
    throw new Error("Database migration v6 did not apply: event reminder tables are missing.");
  }

  if (!hasLocationColumns) {
    throw new Error("Database migration v6 did not apply: event_tracking location columns are missing.");
  }

  if (!hasEventAlertsCommand) {
    throw new Error("Global /gregor-admin command is not registered.");
  }

  if (!hasSubscribeCommand) {
    throw new Error("Global /subscribe command is not registered.");
  }

  if (result.guilds === 0) {
    throw new Error("Bot is not installed in any Discord servers yet.");
  }

  if (result.scheduledEventFetchFailed > 0) {
    throw new Error("Scheduled event fetch failed in at least one server.");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
