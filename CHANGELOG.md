# Changelog

## [Unreleased]

### Added

- @Mention notifications: users and roles @mentioned in event descriptions receive DM
  reminders alongside existing alert recipients. Toggleable per-user via `/subscribe`.
- New `user_settings` table (schema v6) for per-user per-guild mention preferences.
- Mention parsing module (`src/mentions.ts`): pure `parseMentionedUsers` handles `<@id>`,
  `<@!id>`, `<@&id>` formats with role resolution via paginated guild member fetch.

- Auto-start scheduled events at their start time, opt-in per guild via `/gregor-admin` toggle.
  - Pure `findEventsToAutoStart` scheduler function with full unit test coverage.
  - `startEvent` handles Discord API errors gracefully (deleted events, missing permissions).
  - Per-call try/catch isolation so one failing start never blocks alerts or other auto-starts.

### Changed

- Database migration: replaced destructive version-check with transaction-wrapped
  `migrateSchema()` chain (v4→v5→v6). Unknown versions now throw instead of silently
  dropping data.

## [0.1.0] — 2025-07-10

### Added

- Initial Gregor bot: scheduled event DM reminders before events start.
- `/gregor-admin` slash command for server admins to configure alerts.
- `/subscribe` slash command for members to manage personal alert subscriptions.
- SQLite persistence with alerts, recipients, sent history, and guild settings.
- Components v2 UI panels for alert configuration and sent history browsing.
- Alert deduplication via `(guild, event, alert)` unique sent-history tracking.
- Docker Compose setup and smoke test suite.
