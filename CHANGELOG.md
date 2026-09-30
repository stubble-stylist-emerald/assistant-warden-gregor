# Changelog

## [Unreleased]

### Added

- Channel reminder targets: posting a Discord event link in a channel registers that
  channel for reminders. At each configured alert offset the event reminder is also
  posted to every registered channel, and reschedule/cancellation notices are sent
  when a tracked event changes. Requires the `Message Content` privileged intent.
  - `parseEventLink` extracts event IDs from invite (`?event=`) and direct
    (`/events/<guild>/<event>`) links.
  - New tables: `event_channels`, `event_tracking`, `sent_channel_alerts` (schema v6).
  - Pure `findDueChannelReminders` and `detectEventChanges` scheduler functions.
- Auto-start scheduled events at their start time, opt-in per guild via `/gregor-admin` toggle.
  - Pure `findEventsToAutoStart` scheduler function with full unit test coverage.
  - `startEvent` handles Discord API errors gracefully (deleted events, missing permissions).
  - Per-call try/catch isolation so one failing start never blocks alerts or other auto-starts.

### Notes

- **Rollout order**: enable the `Message Content` intent in the Discord Developer
  Portal *before* deploying this version. If the code requests the intent while it
  is disabled, the bot fails to connect (gateway close 4014).

## [0.1.0] — 2025-07-10

### Added

- Initial Gregor bot: scheduled event DM reminders before events start.
- `/gregor-admin` slash command for server admins to configure alerts.
- `/subscribe` slash command for members to manage personal alert subscriptions.
- SQLite persistence with alerts, recipients, sent history, and guild settings.
- Components v2 UI panels for alert configuration and sent history browsing.
- Alert deduplication via `(guild, event, alert)` unique sent-history tracking.
- Docker Compose setup and smoke test suite.
