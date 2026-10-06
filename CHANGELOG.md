# Changelog

## [Unreleased]

### Added

- Channel reminder targets: posting a Discord event link in a channel registers that
  channel for reminders. Registered channels get one reminder at the guild's
  **default reminder offset** (admin-set in `/gregor-admin`), plus reschedule /
  location-change / cancellation notices when a tracked event changes.
  - `parseEventLink` extracts event IDs from invite (`?event=`) and direct
    (`/events/<guild>/<event>`) links.
  - New tables: `event_channels`, `event_tracking`, `sent_channel_alerts`, and a
    `default_reminder_amount`/`default_reminder_unit` guild setting (schema v6).
  - Pure `findDueChannelReminders` and `detectEventChanges` scheduler functions.
  - Channel reminders are **decoupled from the DM alert list** — member
    subscriptions never add channel timings. Guilds default to **24 hours before**
    unless an admin sets a different offset (configurable in `/gregor-admin`;
    "Reset to default" restores 24 hours).
  - Only non-recurring, `Scheduled` events are tracked. When a tracked event is
    cancelled, completed, or deleted, its channel registrations are removed; re-post
    the link to track a new occurrence. A reschedule/location/cancellation notice
    that fails to deliver is retried on the next poll (already-delivered channels
    are not re-notified).
  - Sent history shows channel deliveries alongside DM reminders.
- `/subscribe` now opens a **prefilled** alert form straight away for members with no
  subscriptions — the offset field defaults to the guild's default reminder (24 hours
  unless an admin changed it) so they can just review and hit OK. Members who already
  have subscriptions still get the management panel, whose "Create alert" button also
  prefills the same offset.
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
