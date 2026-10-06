import type { AlertOffsetUnit } from "./types";

const UNIT_ALIASES: Record<string, AlertOffsetUnit> = {
  m: "minutes",
  min: "minutes",
  minute: "minutes",
  minutes: "minutes",
  h: "hours",
  hr: "hours",
  hour: "hours",
  hours: "hours",
  d: "days",
  day: "days",
  days: "days"
};

export class OffsetParseError extends Error {}

// Fallback used when a guild has not configured its own default reminder
// offset. Also prefills the /subscribe form so members can just hit OK.
export const DEFAULT_REMINDER_OFFSET: { amount: number; unit: AlertOffsetUnit } = { amount: 24, unit: "hours" };

// Parse concise human input into the canonical offset shape stored in SQLite.
export function parseAlertOffset(input: string): { amount: number; unit: AlertOffsetUnit } {
  const match = input.trim().toLowerCase().match(/^(\d+)\s*([a-z]+)$/);
  if (!match) {
    throw new OffsetParseError("Use an offset like 30 minutes, 2 hours, or 1 day.");
  }

  const amount = Number(match[1]);
  const unit = UNIT_ALIASES[match[2]];

  if (!Number.isInteger(amount) || amount <= 0 || !unit) {
    throw new OffsetParseError("Use a positive number with minutes, hours, or days.");
  }

  return { amount, unit };
}

// Convert alert offsets to milliseconds for scheduler comparisons.
export function offsetToMilliseconds(amount: number, unit: AlertOffsetUnit): number {
  if (unit === "minutes") {
    return amount * 60 * 1000;
  }

  if (unit === "hours") {
    return amount * 60 * 60 * 1000;
  }

  return amount * 24 * 60 * 60 * 1000;
}

export function formatOffset(amount: number, unit: AlertOffsetUnit): string {
  const singular = unit.slice(0, -1);
  return `${amount} ${amount === 1 ? singular : unit}`;
}
