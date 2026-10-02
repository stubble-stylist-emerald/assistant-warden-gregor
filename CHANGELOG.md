# Changelog

## [Unreleased]

### Added

- Channel reminder targets: posting a Discord event link in a channel registers that
  channel for reminders. At each configured alert offset the event reminder is also
  posted to every registered channel, and reschedule / location-change / cancellation
  notices are sent when a tracked event changes.
  - `parseEventLink` extracts event IDs from invite (`?event=`) and direct
    (`/events/<guild>/<event>`) links.
  - New tables: `event_channels`, `event_tracking`, `sent_channel_alerts` (schema v6).
  - Pure `findDueChannelReminders` and `detectEventChanges` scheduler functions.
  - Channel reminders ignore the alert's `all`/`interested` filter — the channel
    itself is the interested party.
  - Only non-recurring, `Scheduled` events are tracked. When a tracked event is
    cancelled, completed, or deleted, its channel registrations are removed; re-post
    the link to track a new occurrence.
- Auto-start scheduled events at their start time, opt-in per guild via `/gregor-admin` toggle.
  - Pure `findEventsToAutoStart` scheduler function with full unit test coverage.
  - `startEvent` handles Discord API errors gracefully (deleted events, missing permissions).
  - Per-call try/catch isolation so one failing start never blocks alerts or other auto-starts.

### Changed

- "Clear sent history" now also clears channel-reminder dedupe records, and the
  confirmation copy reflects this.

### Notes

- **Required intents**: `Guilds`, `GuildScheduledEvents`, `GuildMessages`, and the
  privileged `Message Content`.
- **Rollout order**: enable the `Message Content` intent in the Discord Developer
  Portal *before* deploying this version. If the code requests the intent while it
  is disabled, the bot fails to connect (gateway close 4014). `bun run smoke` uses
  the same intents, so it fails fast if the portal is misconfigured.
- The bot needs **View Channel**, **Read Message History**, and **Send Messages** in
  the channels where links are posted and reminders are delivered.

## [0.1.0] — 2025-07-10

### Added

- Initial Gregor bot: scheduled event DM reminders before events start.
- `/gregor-admin` slash command for server admins to configure alerts.
- `/subscribe` slash command for members to manage personal alert subscriptions.
- SQLite persistence with alerts, recipients, sent history, and guild settings.
- Components v2 UI panels for alert configuration and sent history browsing.
- Alert deduplication via `(guild, event, alert)` unique sent-history tracking.
- Docker Compose setup and smoke test suite.
