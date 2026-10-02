export type AlertOffsetUnit = "minutes" | "hours" | "days";
export type AlertEventTarget = "all" | "interested";

export interface Alert {
  id: string;
  guildId: string;
  amount: number;
  unit: AlertOffsetUnit;
  eventTarget: AlertEventTarget;
  recipientIds: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FailedRecipient {
  userId: string;
  error: string;
}

export interface SentAlert {
  id: string;
  guildId: string;
  eventId: string;
  alertId: string;
  eventName: string;
  scheduledStartAt: string;
  offsetAmount: number;
  offsetUnit: AlertOffsetUnit;
  attemptedRecipientIds: string[];
  successfulRecipientIds: string[];
  failedRecipients: FailedRecipient[];
  sentAt: string;
  errorSummary: string | null;
}

export interface ScheduledEventSnapshot {
  id: string;
  guildId: string;
  name: string;
  scheduledStartAt: Date | null;
  status: number;
  isRecurring: boolean;
  channelId: string | null;
  location: string | null;
  interestedUserIds: string[];
}

export interface DueAlert {
  guildId: string;
  event: ScheduledEventSnapshot;
  alert: Alert;
  recipientIds: string[];
}

export interface EventChannel {
  guildId: string;
  eventId: string;
  channelId: string;
  createdAt: string;
}

export interface EventTracking {
  guildId: string;
  eventId: string;
  lastKnownStartAt: string | null;
  lastKnownStatus: number;
  lastKnownChannelId: string | null;
  lastKnownLocation: string | null;
  createdAt: string;
  updatedAt: string;
}

export type EventChangeType = "rescheduled" | "cancelled" | "completed" | "location_changed";

export interface EventChange {
  guildId: string;
  event: ScheduledEventSnapshot;
  type: EventChangeType;
}

export interface DueChannelReminder {
  guildId: string;
  event: ScheduledEventSnapshot;
  alert: Alert;
}
