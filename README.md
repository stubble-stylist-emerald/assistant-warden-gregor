# Gregor

A Discord bot that sends reminders for a server's scheduled events. Admins
configure how far in advance to warn people; Gregor DMs the right members and
can post reminders into channels.

## Features

- **DM reminders** — for each scheduled event, DM the configured recipients a
  chosen amount of time before it starts. Alerts can target everyone in the
  recipient list or only members who marked themselves "Interested".
- **Self-service subscriptions** — any member can use `/subscribe` to pick their
  own reminder timings without admin help.
- **Admin configuration** — `/gregor-admin` lets members with the Manage Events
  permission create, edit, and delete alerts, and review sent history.
- **Channel reminder targets** — post a Discord event link in a channel and
  Gregor registers that channel for reminders. At each alert offset it posts a
  reminder (a link that unfurls into Discord's native event card); it also posts
  a notice if the event is rescheduled, changes location, or is cancelled.
- **Auto-start events** — optionally, Gregor flips an event from Scheduled to
  Active when its start time arrives (opt-in per server).
- **Sent history** — a browsable log of what was sent, to whom, and any failures.

## Intents

Gregor requests these Gateway Intents (set in code, but some must be enabled in
the Discord Developer Portal):

| Intent | Purpose |
|--------|---------|
| `Guilds` | Basic server, channel, and role access |
| `GuildScheduledEvents` | Read and manage scheduled events |
| `GuildMessages` | Receive messages (to detect posted event links) |
| `MessageContent` | **Privileged** — read message text to find event links |

> **`MessageContent` is a privileged intent.** You must enable it under
> **Developer Portal → your app → Bot → Privileged Gateway Intents** *before*
> deploying. If the code requests it while it is disabled, the bot fails to
> connect (Gateway close code `4014`) and the **entire bot stays offline** —
> including DM reminders and auto-start. `npm run smoke` uses the same intents,
> so it will fail fast if the portal is misconfigured.

If you do not want the channel-link feature, the `MessageContent` and
`GuildMessages` intents (and the message handler) can be removed; everything
else works without them.

## Permissions

Grant the bot these permissions (invite link or role):

- **Manage Events** — read event subscribers and auto-start events
- **View Channel** — see the channels it posts in
- **Send Messages** — DM reminders and post channel reminders
- **Add Reactions** *(optional)* — the 👀 confirmation when a link is registered

Invite URL with these permissions:

```
https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&permissions=8589937728&scope=bot%20applications.commands
```

`8589937728` = Manage Events + View Channel + Send Messages + Add Reactions.

## Setup

### 1. Get credentials

In the [Discord Developer Portal](https://discord.com/developers/applications):
- **General Information → Application ID** → this is `DISCORD_CLIENT_ID`
- **Bot → Reset Token** → this is `DISCORD_TOKEN`
- **Bot → Privileged Gateway Intents** → enable **Message Content**

### 2. Configure environment

```bash
cp .env.example .env
```

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_TOKEN` | yes | Bot token |
| `DISCORD_CLIENT_ID` | yes | Application/client ID |
| `DATABASE_PATH` | no | SQLite file path (default `./data/gregor.sqlite`) |
| `POLL_INTERVAL_MS` | no | Scheduler poll interval in ms (default `10000`) |

### 3. Install, register commands, run

```bash
npm install
npm run register-commands   # registers /gregor-admin and /subscribe (once, or when commands change)
npm run dev                 # start the bot
```

Invite the bot to your server with the URL above, then use `/gregor-admin` to
configure your first alert.

### Docker

```bash
docker compose up
```

The compose file installs dependencies, builds, and starts the bot using the
`.env` file.

## Commands

| Command | Who | Description |
|---------|-----|-------------|
| `/gregor-admin` | Manage Events | Configure alerts, auto-start, sent history |
| `/subscribe` | Everyone | Manage your own reminder subscriptions |

## How reminders are triggered

Gregor polls scheduled events on an interval. For each event it checks the
configured alert offsets; when an offset comes due, it DMs the matched
recipients and posts to any registered channels. A sent-history record prevents
the same reminder from going out twice.

Channel targets are registered by posting an event link in a channel — Gregor
reacts with 👀 to confirm. Only non-recurring, `Scheduled` events are tracked;
when a tracked event is cancelled, completed, or deleted, its channel
registrations are removed (re-post the link to track a new occurrence).

## Development

```bash
npm test          # run the unit tests (vitest)
npm run build     # type-check and compile to dist/
npm run smoke     # verify live Discord setup + database migrations
```
