import Database from "better-sqlite3";
import { ButtonStyle, ComponentType, MessageFlags, PermissionsBitField } from "discord.js";
import { describe, expect, it } from "vitest";
import { initializeSchema } from "../src/db";
import {
  buildAlertPanel,
  buildAdminAlertModal,
  buildClearHistoryConfirmationPanel,
  buildMainPanel,
  buildSubscriptionPanel,
  canConfigureAlerts,
  moveSubscriptionToEventTarget,
  saveAdminAlert,
  subscribeUserToOffset
} from "../src/interactions";
import { AlertRepository } from "../src/repository";

describe("interaction permissions", () => {
  it("allows members with Manage Events", () => {
    expect(canConfigureAlerts(new PermissionsBitField(PermissionsBitField.Flags.ManageEvents))).toBe(true);
  });

  it("denies members without Manage Events", () => {
    expect(canConfigureAlerts(new PermissionsBitField(PermissionsBitField.Flags.ViewChannel))).toBe(false);
    expect(canConfigureAlerts(null)).toBe(false);
  });
});

describe("main alert panel", () => {
  it("renders an empty Components v2 panel without a select menu", () => {
    const repository = createRepository();
    repository.ensureGuild("guild-1");

    const panel = buildMainPanel(repository, "guild-1");
    const components = JSON.parse(JSON.stringify(panel.components));

    expect(panel.flags).toBe(MessageFlags.IsComponentsV2);
    expect(JSON.stringify(components)).toContain("No alerts configured.");
    expect(JSON.stringify(components)).not.toContain('"type":3');
  });

  it("renders one edit button per alert row without subscription buttons", () => {
    const repository = createRepository();
    const alert = repository.addAlert("guild-1", 30, "minutes");
    repository.setAlertRecipients(alert.id, ["user-1", "user-2"]);

    const panel = buildMainPanel(repository, "guild-1", "user-1");
    const components = JSON.parse(JSON.stringify(panel.components));
    const nestedComponents = collectNestedComponents(components);
    const sections = nestedComponents.filter((component: { type: number }) => component.type === ComponentType.Section);

    expect(sections).toHaveLength(1);
    expect(sections[0].accessory.custom_id).toBe(`eventAlerts:openAlert:${alert.id}`);
    expect(sections[0].components[0].content).toContain("30 minutes before");
    expect(sections[0].components[0].content).toContain("<@user-1>");
    expect(JSON.stringify(components)).not.toContain("eventAlerts:subscribe");
    expect(JSON.stringify(components)).not.toContain("eventAlerts:unsubscribe");
    expect(JSON.stringify(components)).not.toContain('"custom_id":"eventAlerts:alertSelect"');
  });

  it("prioritizes the current user in alert recipient summaries", () => {
    const repository = createRepository();
    const alert = repository.addAlert("guild-1", 1, "days");
    repository.setAlertRecipients(alert.id, ["other-user", "current-user", "third-user"]);

    const panel = buildMainPanel(repository, "guild-1", "current-user");
    const components = JSON.parse(JSON.stringify(panel.components));
    const sectionText = collectNestedComponents(components).find((component: { type: number }) => component.type === ComponentType.Section)
      .components[0].content;

    expect(sectionText).toContain("<@current-user>, <@other-user>, <@third-user>");
  });

  it("preselects saved recipients in the alert user select", () => {
    const repository = createRepository();
    const alert = repository.addAlert("guild-1", 1, "days");
    const updatedAlert = repository.setAlertRecipients(alert.id, ["user-1", "user-2"]);

    const panel = buildAlertPanel(updatedAlert!);
    const components = JSON.parse(JSON.stringify(panel.components));
    const userSelect = components[1].components[0];

    expect(userSelect.default_values).toEqual([
      { id: "user-1", type: "user" },
      { id: "user-2", type: "user" }
    ]);
  });

  it("builds the admin alert modal with filters and recipients", () => {
    const repository = createRepository();
    const alert = repository.addAlert("guild-1", 1, "days", "all");
    const updatedAlert = repository.setAlertRecipients(alert.id, ["user-1", "user-2"]);

    const modal = buildAdminAlertModal(`eventAlerts:modal:edit:${alert.id}`, "Edit alert", updatedAlert!);
    const modalJson = JSON.parse(JSON.stringify(modal));

    expect(JSON.stringify(modalJson)).toContain("Event filters");
    expect(JSON.stringify(modalJson)).toContain("Recipients");
    expect(JSON.stringify(modalJson)).toContain('"custom_id":"recipients"');
    expect(JSON.stringify(modalJson)).toContain('"custom_id":"eventTarget"');
    expect(JSON.stringify(modalJson)).toContain('"value":"all"');
    expect(JSON.stringify(modalJson)).toContain('"default":true');
    expect(JSON.stringify(modalJson)).toContain('"id":"user-1"');
    expect(JSON.stringify(modalJson)).toContain('"id":"user-2"');
    expect(JSON.stringify(modalJson)).toContain('"required":false');
  });

  it("renders a clear-history confirmation with a danger confirm button", () => {
    const repository = createRepository();
    const alert = repository.addAlert("guild-1", 30, "minutes");
    repository.recordSentAlert({
      guildId: "guild-1",
      eventId: "event-1",
      alertId: alert.id,
      eventName: "Session",
      scheduledStartAt: "2026-01-01T12:00:00.000Z",
      offsetAmount: 30,
      offsetUnit: "minutes",
      attemptedRecipientIds: ["user-1"],
      successfulRecipientIds: ["user-1"],
      failedRecipients: [],
      errorSummary: null,
      sentAt: "2026-01-01T11:30:00.000Z"
    });

    const panel = buildClearHistoryConfirmationPanel(repository, "guild-1");
    const components = JSON.parse(JSON.stringify(panel.components));

    expect(components[0].components[0].content).toContain("permanently deletes the sent-history records");
    expect(components[0].components[0].content).toContain("can cause notifications for already-sent event alerts to go out again");
    expect(components[1].components[0]).toMatchObject({
      custom_id: "eventAlerts:confirmClearHistory",
      label: "Clear sent history",
      style: 4
    });
  });

  it("blocks admin-created alerts with the same timing and filter", () => {
    const repository = createRepository();
    const existingAlert = repository.addAlert("guild-1", 1, "days", "interested");
    repository.setAlertRecipients(existingAlert.id, ["user-1"]);

    const savedAlert = saveAdminAlert(repository, "guild-1", 1, "days", "interested", ["user-1", "user-2"]);

    expect(savedAlert).toBeNull();
    expect(repository.listAlerts("guild-1")).toHaveLength(1);
    expect(repository.getAlertRecipients(existingAlert.id)).toEqual(["user-1"]);
  });

  it("blocks admin edits into an existing matching alert", () => {
    const repository = createRepository();
    const targetAlert = repository.addAlert("guild-1", 1, "days", "interested");
    const sourceAlert = repository.addAlert("guild-1", 2, "hours", "all");
    repository.setAlertRecipients(targetAlert.id, ["user-1"]);
    repository.setAlertRecipients(sourceAlert.id, ["user-2"]);

    const savedAlert = saveAdminAlert(repository, "guild-1", 1, "days", "interested", ["user-2", "user-3"], sourceAlert.id);

    expect(savedAlert).toBeNull();
    expect(repository.getAlert(sourceAlert.id)).not.toBeNull();
    expect(repository.listAlerts("guild-1")).toHaveLength(2);
    expect(repository.getAlertRecipients(targetAlert.id)).toEqual(["user-1"]);
    expect(repository.getAlertRecipients(sourceAlert.id)).toEqual(["user-2"]);
  });

  it("includes an auto-start toggle button in the main panel", () => {
    const repository = createRepository();
    repository.ensureGuild("guild-1");

    const panel = buildMainPanel(repository, "guild-1");
    const components = JSON.parse(JSON.stringify(panel.components));

    // Find the button row (last component, type 1 = ActionRow)
    const buttonRow = components[components.length - 1];
    expect(buttonRow.type).toBe(ComponentType.ActionRow);

    const toggleButton = buttonRow.components.find(
      (c: { custom_id: string }) => c.custom_id === "eventAlerts:toggleAutoStart"
    );
    expect(toggleButton).toBeDefined();
    expect(toggleButton.label).toBe("Auto-start: Off");
    expect(toggleButton.style).toBe(ButtonStyle.Secondary);
  });

  it("shows auto-start toggle as On when enabled", () => {
    const repository = createRepository();
    repository.ensureGuild("guild-1");
    repository.setAutoStartEnabled("guild-1", true);

    const panel = buildMainPanel(repository, "guild-1");
    const components = JSON.parse(JSON.stringify(panel.components));

    const buttonRow = components[components.length - 1];
    const toggleButton = buttonRow.components.find(
      (c: { custom_id: string }) => c.custom_id === "eventAlerts:toggleAutoStart"
    );
    expect(toggleButton.label).toBe("Auto-start: On");
    expect(toggleButton.style).toBe(ButtonStyle.Success);
  });

  it("includes a Manage Events permission note in the main panel", () => {
    const repository = createRepository();
    repository.ensureGuild("guild-1");

    const panel = buildMainPanel(repository, "guild-1");
    const components = JSON.parse(JSON.stringify(panel.components));

    expect(JSON.stringify(components)).toContain("Requires the bot to have Manage Events permission");
  });

  it("shows the mention channel as Not configured by default", () => {
    const repository = createRepository();
    repository.ensureGuild("guild-1");

    const panel = buildMainPanel(repository, "guild-1");
    const components = JSON.parse(JSON.stringify(panel.components));

    expect(JSON.stringify(components)).toContain("Not configured");
  });

  it("shows the mention channel when configured", () => {
    const repository = createRepository();
    repository.ensureGuild("guild-1");
    repository.setMentionChannelId("guild-1", "channel-123");

    const panel = buildMainPanel(repository, "guild-1");
    const components = JSON.parse(JSON.stringify(panel.components));

    expect(JSON.stringify(components)).toContain("<#channel-123>");
  });

  it("includes a channel select menu for mention channel", () => {
    const repository = createRepository();
    repository.ensureGuild("guild-1");

    const panel = buildMainPanel(repository, "guild-1");
    const components = JSON.parse(JSON.stringify(panel.components));

    expect(JSON.stringify(components)).toContain("eventAlerts:setMentionChannel");
  });
});

describe("subscription panel", () => {
  it("renders an empty self-service Components v2 panel", () => {
    const repository = createRepository();
    repository.ensureGuild("guild-1");

    const panel = buildSubscriptionPanel(repository, "guild-1", "user-1");
    const components = JSON.parse(JSON.stringify(panel.components));

    expect(panel.flags).toBe(MessageFlags.IsComponentsV2);
    expect(JSON.stringify(components)).toContain("You are not subscribed to any event alerts yet.");
    expect(JSON.stringify(components)).toContain('"custom_id":"subscriptions:add"');
  });

  it("renders subscription duplicate notices in the panel", () => {
    const repository = createRepository();
    repository.ensureGuild("guild-1");

    const panel = buildSubscriptionPanel(repository, "guild-1", "user-1", "Duplicate timing subscriptions are not created.");
    const components = JSON.parse(JSON.stringify(panel.components));

    expect(JSON.stringify(components)).toContain("Notice");
    expect(JSON.stringify(components)).toContain("Duplicate timing subscriptions are not created.");
  });

  it("renders only current-user subscriptions with unsubscribe accessories", () => {
    const repository = createRepository();
    const subscribedAlert = repository.addAlert("guild-1", 30, "minutes", "all");
    const otherAlert = repository.addAlert("guild-1", 1, "days");
    repository.setAlertRecipients(subscribedAlert.id, ["user-1", "user-2"]);
    repository.setAlertRecipients(otherAlert.id, ["user-2"]);

    const panel = buildSubscriptionPanel(repository, "guild-1", "user-1");
    const components = JSON.parse(JSON.stringify(panel.components));
    const nestedComponents = collectNestedComponents(components);
    const sections = nestedComponents.filter(
      (component: { type: number }) => component.type === ComponentType.Section
    );
    const eventTargetRow = nestedComponents.find(
      (component: { type: number; components?: Array<{ custom_id?: string }> }) =>
        component.type === ComponentType.ActionRow &&
        component.components?.[0]?.custom_id === `subscriptions:eventTarget:${subscribedAlert.id}`
    );

    expect(sections).toHaveLength(1);
    expect(sections[0].components[0].content).toContain("30 minutes before");
    expect(sections[0].components[0].content).toContain("All");
    expect(sections[0].components[0].content).not.toContain("1 day before");
    expect(sections[0].accessory).toMatchObject({
      custom_id: `subscriptions:unsubscribe:${subscribedAlert.id}`,
      label: "Unsubscribe"
    });
    expect(eventTargetRow.components[0]).toMatchObject({
      custom_id: `subscriptions:eventTarget:${subscribedAlert.id}`,
      placeholder: "Event filters",
      options: [
        { label: "All", value: "all", default: true },
        { label: "Interested", value: "interested" }
      ]
    });
  });

  it("reuses an existing exact timing when creating a subscription", () => {
    const repository = createRepository();
    const alert = repository.addAlert("guild-1", 30, "minutes", "all");
    repository.setAlertRecipients(alert.id, ["user-2"]);

    const subscribedAlert = subscribeUserToOffset(repository, "guild-1", "user-1", 30, "minutes", "all");

    expect(subscribedAlert?.id).toBe(alert.id);
    expect(repository.listAlerts("guild-1")).toHaveLength(1);
    expect(repository.getAlertRecipients(alert.id)).toEqual(expect.arrayContaining(["user-1", "user-2"]));
    expect(repository.getAlertRecipients(alert.id)).toHaveLength(2);
    expect(repository.getAlert(alert.id)?.eventTarget).toBe("all");
  });

  it("does not duplicate an exact timing the user already has", () => {
    const repository = createRepository();
    const alert = repository.addAlert("guild-1", 2, "hours", "all");
    repository.setAlertRecipients(alert.id, ["user-1"]);

    const subscribedAlert = subscribeUserToOffset(repository, "guild-1", "user-1", 2, "hours", "all");

    expect(subscribedAlert?.id).toBe(alert.id);
    expect(repository.listAlerts("guild-1")).toHaveLength(1);
    expect(repository.getAlertRecipients(alert.id)).toEqual(["user-1"]);
    expect(repository.getAlert(alert.id)?.eventTarget).toBe("all");
  });

  it("prevents the same user from subscribing to the same timing with different filters", () => {
    const repository = createRepository();

    const allAlert = subscribeUserToOffset(repository, "guild-1", "user-1", 1, "days", "all");
    const interestedAlert = subscribeUserToOffset(repository, "guild-1", "user-1", 1, "days", "interested");
    const duplicateAllAlert = subscribeUserToOffset(repository, "guild-1", "user-1", 1, "days", "all");

    expect(interestedAlert?.id).toBe(allAlert?.id);
    expect(duplicateAllAlert?.id).toBe(allAlert?.id);
    expect(repository.listSubscribedAlerts("guild-1", "user-1").map((alert) => alert.eventTarget)).toEqual(["all"]);
    expect(repository.listAlerts("guild-1")).toHaveLength(1);
  });

  it("removes the changed row when switching to an already-subscribed timing filter", () => {
    const repository = createRepository();
    const allAlert = repository.addAlert("guild-1", 1, "days", "all");
    const interestedAlert = repository.addAlert("guild-1", 1, "days", "interested");
    repository.setAlertRecipients(allAlert.id, ["user-1"]);
    repository.setAlertRecipients(interestedAlert.id, ["user-1"]);

    const movedAlert = moveSubscriptionToEventTarget(repository, "guild-1", "user-1", interestedAlert, "all");

    expect(movedAlert?.id).toBe(allAlert.id);
    expect(repository.getAlert(interestedAlert.id)).toBeNull();
    expect(repository.listSubscribedAlerts("guild-1", "user-1").map((alert) => alert.id)).toEqual([allAlert.id]);
  });

  it("includes a mention notifications toggle in the subscription panel", () => {
    const repository = createRepository();
    repository.ensureGuild("guild-1");

    const panel = buildSubscriptionPanel(repository, "guild-1", "user-1");
    const components = JSON.parse(JSON.stringify(panel.components));

    const buttonRow = components[components.length - 1];
    const toggleButton = buttonRow.components.find(
      (c: { custom_id: string }) => c.custom_id === "subscriptions:toggleMentionNotifications"
    );
    expect(toggleButton).toBeDefined();
    expect(toggleButton.label).toBe("@mentions: On");
    expect(toggleButton.style).toBe(ButtonStyle.Success);
  });

  it("shows mention toggle as Off when disabled", () => {
    const repository = createRepository();
    repository.ensureGuild("guild-1");
    repository.setMentionNotificationsEnabled("guild-1", "user-1", false);

    const panel = buildSubscriptionPanel(repository, "guild-1", "user-1");
    const components = JSON.parse(JSON.stringify(panel.components));

    const buttonRow = components[components.length - 1];
    const toggleButton = buttonRow.components.find(
      (c: { custom_id: string }) => c.custom_id === "subscriptions:toggleMentionNotifications"
    );
    expect(toggleButton.label).toBe("@mentions: Off");
    expect(toggleButton.style).toBe(ButtonStyle.Secondary);
  });
});

function createRepository(): AlertRepository {
  const db = new Database(":memory:");
  initializeSchema(db);
  return new AlertRepository(db);
}

function collectNestedComponents(components: Array<{ components?: unknown[] }>): unknown[] {
  return components.flatMap((component) => component.components ?? []);
}
