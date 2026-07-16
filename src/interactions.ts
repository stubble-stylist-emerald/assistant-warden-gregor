import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ComponentType,
  ContainerBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionsBitField,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  type ButtonInteraction,
  type ChannelSelectMenuInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type InteractionReplyOptions,
  type InteractionUpdateOptions,
  type ModalActionRowComponentBuilder,
  type ModalSubmitInteraction,
  type PermissionsBitField as PermissionsBitFieldType,
  type StringSelectMenuInteraction,
  type UserSelectMenuInteraction
} from "discord.js";
import { EVENT_ALERTS_COMMAND, SUBSCRIBE_COMMAND } from "./commands";
import { formatOffset, OffsetParseError, parseAlertOffset } from "./offset";
import type { AlertRepository } from "./repository";
import type { Alert, AlertEventTarget, AlertOffsetUnit, SentAlert } from "./types";

const IDS = {
  addAlert: "eventAlerts:addAlert",
  clearHistory: "eventAlerts:clearHistory",
  confirmClearHistory: "eventAlerts:confirmClearHistory",
  history: "eventAlerts:history",
  back: "eventAlerts:back",
  toggleAutoStart: "eventAlerts:toggleAutoStart",
  setMentionChannel: "eventAlerts:setMentionChannel",
  clearMentionChannel: "eventAlerts:clearMentionChannel"
} as const;

const SUBSCRIPTION_IDS = {
  add: "subscriptions:add",
  modalAdd: "subscriptions:modal:add",
  toggleMentionNotifications: "subscriptions:toggleMentionNotifications"
} as const;

const HISTORY_PAGE_SIZE = 5;
const MAX_ALERTS = 25;
const ALERTS_PER_CONTAINER = 10;
const SUBSCRIPTIONS_PER_CONTAINER = 5;
const ACTIVE_PANEL_TTL_MS = 14 * 60 * 1000;

type PanelInteraction = ChatInputCommandInteraction | ModalSubmitInteraction;
type PanelType = "admin" | "subscribe";

interface ActivePanel {
  interaction: PanelInteraction;
  openedAt: number;
}

const activePanels = new Map<string, ActivePanel>();

// Route Discord interactions into repository-backed alert configuration screens.
export async function handleInteraction(interaction: Interaction, repository: AlertRepository): Promise<void> {
  if (interaction.isChatInputCommand() && interaction.commandName === EVENT_ALERTS_COMMAND) {
    await handleEventAlertsCommand(interaction, repository);
    return;
  }

  if (interaction.isChatInputCommand() && interaction.commandName === SUBSCRIBE_COMMAND) {
    await handleSubscribeCommand(interaction, repository);
    return;
  }

  if (interaction.isUserSelectMenu() && interaction.customId.startsWith("eventAlerts:alertRecipients:")) {
    await handleAlertRecipientSelect(interaction, repository);
    return;
  }

  if (interaction.isStringSelectMenu() && interaction.customId.startsWith("subscriptions:eventTarget:")) {
    await handleSubscriptionEventTargetSelect(interaction, repository);
    return;
  }

  if (interaction.isChannelSelectMenu() && interaction.customId === IDS.setMentionChannel) {
    await handleMentionChannelSelect(interaction, repository);
    return;
  }

  if (interaction.isButton()) {
    if (interaction.customId.startsWith("subscriptions:")) {
      await handleSubscriptionButton(interaction, repository);
      return;
    }

    await handleEventAlertsButton(interaction, repository);
    return;
  }

  if (interaction.isModalSubmit()) {
    if (interaction.customId.startsWith("subscriptions:")) {
      await handleSubscriptionModalSubmit(interaction, repository);
      return;
    }

    await handleEventAlertsModalSubmit(interaction, repository);
  }
}

async function handleSubscriptionEventTargetSelect(
  interaction: StringSelectMenuInteraction,
  repository: AlertRepository
): Promise<void> {
  const guildId = await requireGuild(interaction);
  if (!guildId) {
    return;
  }

  const alertId = interaction.customId.split(":")[2];
  const alert = repository.getAlert(alertId);
  const eventTarget = parseEventTarget(interaction.values[0]);
  let notice: string | undefined;
  if (alert && alert.guildId === guildId && alert.recipientIds.includes(interaction.user.id) && eventTarget) {
    const existingTargetSubscription = findSubscribedAlertByTiming(repository, guildId, interaction.user.id, alert.amount, alert.unit, eventTarget);
    moveSubscriptionToEventTarget(repository, guildId, interaction.user.id, alert, eventTarget);
    if (existingTargetSubscription && alert.eventTarget !== eventTarget) {
      notice = `You already had ${formatOffset(alert.amount, alert.unit)} before - ${formatEventTarget(eventTarget)}. The duplicate row was removed.`;
    }
  }

  await interaction.update(buildSubscriptionPanel(repository, guildId, interaction.user.id, notice));
}

export function canConfigureAlerts(permissions: Readonly<PermissionsBitFieldType> | null | undefined): boolean {
  return Boolean(permissions?.has(PermissionsBitField.Flags.ManageEvents));
}

async function handleMentionChannelSelect(
  interaction: ChannelSelectMenuInteraction,
  repository: AlertRepository
): Promise<void> {
  const guildId = await requireConfigurableGuild(interaction);
  if (!guildId) {
    return;
  }

  const channelId = interaction.values[0];
  repository.setMentionChannelId(guildId, channelId);
  await interaction.update(buildMainPanel(repository, guildId, interaction.user.id));
}

async function handleEventAlertsCommand(
  interaction: ChatInputCommandInteraction,
  repository: AlertRepository
): Promise<void> {
  const guildId = await requireConfigurableGuild(interaction);
  if (!guildId) {
    return;
  }

  repository.ensureGuild(guildId);
  await closePreviousPanel(guildId, interaction.user.id, "admin");
  await interaction.reply(asEphemeralV2(buildMainPanel(repository, guildId, interaction.user.id)));
  rememberActivePanel(guildId, interaction.user.id, "admin", interaction);
}

async function handleSubscribeCommand(
  interaction: ChatInputCommandInteraction,
  repository: AlertRepository
): Promise<void> {
  const guildId = await requireGuild(interaction);
  if (!guildId) {
    return;
  }

  repository.ensureGuild(guildId);
  await closePreviousPanel(guildId, interaction.user.id, "subscribe");
  await interaction.reply(asEphemeralV2(buildSubscriptionPanel(repository, guildId, interaction.user.id)));
  rememberActivePanel(guildId, interaction.user.id, "subscribe", interaction);
}

async function handleAlertRecipientSelect(
  interaction: UserSelectMenuInteraction,
  repository: AlertRepository
): Promise<void> {
  const guildId = await requireConfigurableGuild(interaction);
  if (!guildId) {
    return;
  }

  const alertId = interaction.customId.split(":")[2];
  const alert = repository.getAlert(alertId);
  if (!alert || alert.guildId !== guildId) {
    await interaction.update(buildMainPanel(repository, guildId, interaction.user.id));
    return;
  }

  const updatedAlert = repository.setAlertRecipients(alertId, interaction.values);
  await interaction.update(updatedAlert ? buildAlertPanel(updatedAlert) : buildMainPanel(repository, guildId, interaction.user.id));
}

async function handleEventAlertsButton(interaction: ButtonInteraction, repository: AlertRepository): Promise<void> {
  const guildId = await requireConfigurableGuild(interaction);
  if (!guildId) {
    return;
  }

  if (interaction.customId === IDS.addAlert) {
    if (repository.listAlerts(guildId).length >= MAX_ALERTS) {
      await interaction.reply({ content: `This server already has the maximum of ${MAX_ALERTS} alerts.`, flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.showModal(buildAdminAlertModal("eventAlerts:modal:add", "Add alert"));
    return;
  }

  if (interaction.customId === IDS.back) {
    await interaction.update(buildMainPanel(repository, guildId, interaction.user.id));
    return;
  }

  if (interaction.customId.startsWith(`${IDS.history}:`)) {
    const page = Number(interaction.customId.split(":").at(-1) ?? "0");
    await interaction.update(buildHistoryPanel(repository, guildId, Number.isFinite(page) ? page : 0));
    return;
  }

  if (interaction.customId === IDS.clearHistory) {
    await interaction.update(buildClearHistoryConfirmationPanel(repository, guildId));
    return;
  }

  if (interaction.customId === IDS.confirmClearHistory) {
    repository.clearSentHistory(guildId);
    await interaction.update(buildHistoryPanel(repository, guildId, 0));
    return;
  }

  if (interaction.customId.startsWith("eventAlerts:openAlert:")) {
    const alertId = interaction.customId.split(":")[2];
    const alert = repository.getAlert(alertId);
    if (!alert || alert.guildId !== guildId) {
      await interaction.update(buildMainPanel(repository, guildId, interaction.user.id));
      return;
    }

    await interaction.showModal(buildAdminAlertModal(`eventAlerts:modal:edit:${alert.id}`, "Edit alert", alert));
    return;
  }

  if (interaction.customId.startsWith("eventAlerts:editAlert:")) {
    const alertId = interaction.customId.split(":")[2];
    const alert = repository.getAlert(alertId);
    if (!alert || alert.guildId !== guildId) {
      await interaction.update(buildMainPanel(repository, guildId, interaction.user.id));
      return;
    }

    await interaction.showModal(
      buildAdminAlertModal(`eventAlerts:modal:edit:${alert.id}`, "Edit alert", alert)
    );
    return;
  }

  if (interaction.customId.startsWith("eventAlerts:deleteAlert:")) {
    repository.deleteAlert(interaction.customId.split(":")[2]);
    await interaction.update(buildMainPanel(repository, guildId, interaction.user.id));
    return;
  }

  if (interaction.customId === IDS.toggleAutoStart) {
    if (!canConfigureAlerts(interaction.memberPermissions)) {
      await interaction.reply({
        content: "You need the Manage Events permission to change auto-start.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const enabled = repository.isAutoStartEnabled(guildId);
    repository.setAutoStartEnabled(guildId, !enabled);
    await interaction.update(buildMainPanel(repository, guildId, interaction.user.id));
    return;
  }

  if (interaction.customId === IDS.clearMentionChannel) {
    repository.setMentionChannelId(guildId, null);
    await interaction.update(buildMainPanel(repository, guildId, interaction.user.id));
    return;
  }
}

async function handleSubscriptionButton(interaction: ButtonInteraction, repository: AlertRepository): Promise<void> {
  const guildId = await requireGuild(interaction);
  if (!guildId) {
    return;
  }

  repository.ensureGuild(guildId);

  if (interaction.customId === SUBSCRIPTION_IDS.add) {
    await interaction.showModal(buildSubscriptionOffsetModal());
    return;
  }

  if (interaction.customId === SUBSCRIPTION_IDS.toggleMentionNotifications) {
    const enabled = repository.isMentionNotificationsEnabled(guildId, interaction.user.id);
    repository.setMentionNotificationsEnabled(guildId, interaction.user.id, !enabled);
    await interaction.update(buildSubscriptionPanel(repository, guildId, interaction.user.id));
    return;
  }

  if (interaction.customId.startsWith("subscriptions:unsubscribe:")) {
    const alertId = interaction.customId.split(":")[2];
    const alert = repository.getAlert(alertId);
    if (alert && alert.guildId === guildId) {
      repository.removeAlertRecipient(alert.id, interaction.user.id);
    }

    await interaction.update(buildSubscriptionPanel(repository, guildId, interaction.user.id));
  }
}

async function handleEventAlertsModalSubmit(
  interaction: ModalSubmitInteraction,
  repository: AlertRepository
): Promise<void> {
  const guildId = await requireConfigurableGuild(interaction);
  if (!guildId) {
    return;
  }

  let parsed: ReturnType<typeof parseAlertOffset>;
  try {
    parsed = parseAlertOffset(interaction.fields.getTextInputValue("offset"));
  } catch (error) {
    const message = error instanceof OffsetParseError ? error.message : "Invalid offset.";
    await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
    return;
  }

  if (interaction.customId === "eventAlerts:modal:add") {
    const eventTarget = parseModalEventTarget(interaction);
    const recipientIds = parseModalRecipientIds(interaction);
    if (recipientIds.length === 0) {
      await interaction.reply({ content: "Choose at least one non-bot recipient for this alert.", flags: MessageFlags.Ephemeral });
      return;
    }

    const savedAlert = saveAdminAlert(repository, guildId, parsed.amount, parsed.unit, eventTarget, recipientIds);
    if (!savedAlert) {
      await interaction.reply({
        content: `An alert for ${formatOffset(parsed.amount, parsed.unit)} before - ${formatEventTarget(eventTarget)} already exists. Edit that row instead.`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    await respondToAdminModal(interaction, repository, guildId);
    return;
  }

  if (interaction.customId.startsWith("eventAlerts:modal:edit:")) {
    const eventTarget = parseModalEventTarget(interaction);
    const alertId = interaction.customId.split(":")[3];
    const existingAlert = repository.getAlert(alertId);
    const recipientIds = parseModalRecipientIds(interaction, existingAlert?.recipientIds ?? []);
    const savedAlert = saveAdminAlert(repository, guildId, parsed.amount, parsed.unit, eventTarget, recipientIds, alertId);
    if (!savedAlert) {
      await interaction.reply({
        content: `An alert for ${formatOffset(parsed.amount, parsed.unit)} before - ${formatEventTarget(eventTarget)} already exists. Edit that row instead.`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    await respondToAdminModal(interaction, repository, guildId);
  }
}

async function handleSubscriptionModalSubmit(
  interaction: ModalSubmitInteraction,
  repository: AlertRepository
): Promise<void> {
  const guildId = await requireGuild(interaction);
  if (!guildId) {
    return;
  }

  let parsed: ReturnType<typeof parseAlertOffset>;
  try {
    parsed = parseAlertOffset(interaction.fields.getTextInputValue("offset"));
  } catch (error) {
    const message = error instanceof OffsetParseError ? error.message : "Invalid offset.";
    await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
    return;
  }

  if (interaction.customId === SUBSCRIPTION_IDS.modalAdd) {
    const eventTarget = parseModalEventTarget(interaction);
    const existingTimingSubscription = findSubscribedAlertByTiming(repository, guildId, interaction.user.id, parsed.amount, parsed.unit);
    if (existingTimingSubscription) {
      const notice = `You already have ${formatOffset(parsed.amount, parsed.unit)} before - ${formatEventTarget(existingTimingSubscription.eventTarget)}. Duplicate timing subscriptions are not created.`;
      await closePreviousPanel(guildId, interaction.user.id, "subscribe");
      await interaction.reply(asEphemeralV2(buildSubscriptionPanel(repository, guildId, interaction.user.id, notice)));
      rememberActivePanel(guildId, interaction.user.id, "subscribe", interaction);
      return;
    }

    const alert = subscribeUserToOffset(repository, guildId, interaction.user.id, parsed.amount, parsed.unit, eventTarget);
    if (!alert) {
      await interaction.reply({ content: `This server already has the maximum of ${MAX_ALERTS} alerts.`, flags: MessageFlags.Ephemeral });
      return;
    }

    await closePreviousPanel(guildId, interaction.user.id, "subscribe");
    await interaction.reply(asEphemeralV2(buildSubscriptionPanel(repository, guildId, interaction.user.id)));
    rememberActivePanel(guildId, interaction.user.id, "subscribe", interaction);
  }
}

export function subscribeUserToOffset(
  repository: AlertRepository,
  guildId: string,
  userId: string,
  amount: number,
  unit: AlertOffsetUnit,
  eventTarget: AlertEventTarget = "interested"
): Alert | null {
  const existingTimingSubscription = repository
    .listSubscribedAlerts(guildId, userId)
    .find((alert) => alert.amount === amount && alert.unit === unit);
  if (existingTimingSubscription) {
    return existingTimingSubscription;
  }

  const matchingAlerts = repository.findAlertsByOffset(guildId, amount, unit, eventTarget);
  const existingTargetSubscription = matchingAlerts.find((alert) => alert.recipientIds.includes(userId));
  if (existingTargetSubscription) {
    return existingTargetSubscription;
  }

  const reusableAlert = matchingAlerts[0];
  if (reusableAlert) {
    repository.addAlertRecipient(reusableAlert.id, userId);
    return repository.getAlert(reusableAlert.id);
  }

  if (repository.listAlerts(guildId).length >= MAX_ALERTS) {
    return null;
  }

  const alert = repository.addAlert(guildId, amount, unit, eventTarget);
  repository.addAlertRecipient(alert.id, userId);
  return repository.getAlert(alert.id);
}

function findSubscribedAlertByTiming(
  repository: AlertRepository,
  guildId: string,
  userId: string,
  amount: number,
  unit: AlertOffsetUnit,
  eventTarget?: AlertEventTarget
): Alert | undefined {
  return repository
    .listSubscribedAlerts(guildId, userId)
    .find((alert) => alert.amount === amount && alert.unit === unit && (!eventTarget || alert.eventTarget === eventTarget));
}

export function saveAdminAlert(
  repository: AlertRepository,
  guildId: string,
  amount: number,
  unit: AlertOffsetUnit,
  eventTarget: AlertEventTarget,
  recipientIds: string[],
  sourceAlertId?: string
): Alert | null {
  const uniqueRecipientIds = Array.from(new Set(recipientIds));
  const sourceAlert = sourceAlertId ? repository.getAlert(sourceAlertId) : null;
  const validSourceAlertId = sourceAlert?.guildId === guildId ? sourceAlert.id : undefined;
  const matchingAlerts = repository.findAlertsByOffset(guildId, amount, unit, eventTarget);
  if (matchingAlerts.some((alert) => alert.id !== validSourceAlertId)) {
    return null;
  }

  if (sourceAlertId) {
    const updatedAlert = validSourceAlertId ? repository.updateAlert(validSourceAlertId, amount, unit, eventTarget) : null;
    return updatedAlert && updatedAlert.guildId === guildId ? repository.setAlertRecipients(updatedAlert.id, uniqueRecipientIds) : null;
  }

  const alert = repository.addAlert(guildId, amount, unit, eventTarget);
  return repository.setAlertRecipients(alert.id, uniqueRecipientIds);
}

export function moveSubscriptionToEventTarget(
  repository: AlertRepository,
  guildId: string,
  userId: string,
  alert: Alert,
  eventTarget: AlertEventTarget
): Alert | null {
  if (alert.eventTarget === eventTarget) {
    return alert;
  }

  const targetAlerts = repository.findAlertsByOffset(guildId, alert.amount, alert.unit, eventTarget);
  const existingTargetSubscription = targetAlerts.find((targetAlert) => targetAlert.recipientIds.includes(userId));
  if (existingTargetSubscription) {
    repository.removeAlertRecipient(alert.id, userId);
    return existingTargetSubscription;
  }

  if (targetAlerts.length === 0 && alert.recipientIds.length > 1 && repository.listAlerts(guildId).length >= MAX_ALERTS) {
    return null;
  }

  repository.removeAlertRecipient(alert.id, userId);
  return subscribeUserToOffset(repository, guildId, userId, alert.amount, alert.unit, eventTarget);
}

async function requireConfigurableGuild(
  interaction:
    | ChatInputCommandInteraction
    | UserSelectMenuInteraction
    | ButtonInteraction
    | ModalSubmitInteraction
    | ChannelSelectMenuInteraction
): Promise<string | null> {
  if (!interaction.guildId) {
    await interaction.reply({ content: "Use this command in a server.", flags: MessageFlags.Ephemeral });
    return null;
  }

  if (!canConfigureAlerts(interaction.memberPermissions)) {
    await interaction.reply({
      content: "You need the Manage Events permission to configure event alerts.",
      flags: MessageFlags.Ephemeral
    });
    return null;
  }

  return interaction.guildId;
}

async function requireGuild(
  interaction: ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction | StringSelectMenuInteraction
): Promise<string | null> {
  if (!interaction.guildId) {
    await interaction.reply({ content: "Use this command in a server.", flags: MessageFlags.Ephemeral });
    return null;
  }

  return interaction.guildId;
}

async function closePreviousPanel(guildId: string, userId: string, panelType: PanelType): Promise<void> {
  const key = activePanelKey(guildId, userId, panelType);
  const previous = activePanels.get(key);
  if (!previous) {
    return;
  }

  activePanels.delete(key);
  if (Date.now() - previous.openedAt > ACTIVE_PANEL_TTL_MS) {
    return;
  }

  // Discord interaction tokens expire quickly, so stale cleanup failures are expected.
  try {
    await previous.interaction.deleteReply();
  } catch {
    // Best-effort cleanup only; the new panel should still open.
  }
}

async function respondToAdminModal(
  interaction: ModalSubmitInteraction,
  repository: AlertRepository,
  guildId: string
): Promise<void> {
  const panel = buildMainPanel(repository, guildId, interaction.user.id);
  if (interaction.isFromMessage()) {
    await interaction.update(panel);
    return;
  }

  await closePreviousPanel(guildId, interaction.user.id, "admin");
  await interaction.reply(asEphemeralV2(panel));
  rememberActivePanel(guildId, interaction.user.id, "admin", interaction);
}

function rememberActivePanel(guildId: string, userId: string, panelType: PanelType, interaction: PanelInteraction): void {
  activePanels.set(activePanelKey(guildId, userId, panelType), { interaction, openedAt: Date.now() });
}

function activePanelKey(guildId: string, userId: string, panelType: PanelType): string {
  return `${guildId}:${userId}:${panelType}`;
}

function asEphemeralV2(panel: Pick<InteractionReplyOptions, "components">): InteractionReplyOptions {
  return {
    components: panel.components,
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2
  };
}

export function buildMainPanel(
  repository: AlertRepository,
  guildId: string,
  currentUserId?: string
): InteractionReplyOptions & InteractionUpdateOptions {
  const alerts = repository.listAlerts(guildId);
  const headerContainer = new ContainerBuilder()
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          "# Event alerts",
          "Configure DM reminders for this server's scheduled events.",
          "*Requires the bot to have Manage Events permission for auto-start.*",
          "",
          "**Alerts**"
        ].join("\n")
      )
    );
  const components: Array<ContainerBuilder | ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<ChannelSelectMenuBuilder>> = [headerContainer];

  if (alerts.length === 0) {
    headerContainer.addTextDisplayComponents(new TextDisplayBuilder().setContent("No alerts configured."));
  } else {
    // Keep each container under Discord's v2 component limit while rendering alert rows.
    for (const alertGroup of chunkArray(alerts.slice(0, MAX_ALERTS), ALERTS_PER_CONTAINER)) {
      const alertContainer = new ContainerBuilder();
      for (const alert of alertGroup) {
        alertContainer.addSectionComponents(
          new SectionBuilder()
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(formatAlertSummary(alert, currentUserId)))
            .setButtonAccessory(
              new ButtonBuilder()
                .setCustomId(`eventAlerts:openAlert:${alert.id}`)
                .setLabel("Edit")
                .setStyle(ButtonStyle.Secondary)
            )
        );
      }
      components.push(alertContainer);
    }
  }

  headerContainer.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));

  // Mention channel configuration.
  const mentionChannelId = repository.getMentionChannelId(guildId);
  const mentionChannelLabel = mentionChannelId ? `<#${mentionChannelId}>` : "Not configured";
  headerContainer.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`**Mention channel**: ${mentionChannelLabel}`)
  );

  const channelSelectRow = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId(IDS.setMentionChannel)
      .setPlaceholder("Select a channel for @mention notifications")
      .setChannelTypes([ChannelType.GuildText])
      .setMinValues(1)
      .setMaxValues(1)
  );
  components.push(channelSelectRow);

  if (mentionChannelId) {
    const clearRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(IDS.clearMentionChannel)
        .setLabel("Clear mention channel")
        .setStyle(ButtonStyle.Danger)
    );
    components.push(clearRow);
  }

  const autoStartEnabled = repository.isAutoStartEnabled(guildId);
  const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(IDS.addAlert)
      .setLabel("Add alert")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(alerts.length >= MAX_ALERTS),
    new ButtonBuilder().setCustomId(`${IDS.history}:0`).setLabel("Sent history").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(IDS.toggleAutoStart)
      .setLabel(autoStartEnabled ? "Auto-start: On" : "Auto-start: Off")
      .setStyle(autoStartEnabled ? ButtonStyle.Success : ButtonStyle.Secondary)
  );

  components.push(buttonRow);
  return { components, flags: MessageFlags.IsComponentsV2 };
}

export function buildSubscriptionPanel(
  repository: AlertRepository,
  guildId: string,
  userId: string,
  notice?: string
): InteractionReplyOptions & InteractionUpdateOptions {
  const alerts = repository.listSubscribedAlerts(guildId, userId);
  const headerContainer = new ContainerBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(["# Event subscriptions", "Manage your scheduled event alert DMs."].join("\n"))
  );
  const components: Array<ContainerBuilder | ActionRowBuilder<ButtonBuilder>> = [headerContainer];

  if (notice) {
    headerContainer.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    headerContainer.addTextDisplayComponents(new TextDisplayBuilder().setContent(`**Notice**\n${notice}`));
  }

  if (alerts.length === 0) {
    headerContainer.addTextDisplayComponents(new TextDisplayBuilder().setContent("You are not subscribed to any event alerts yet."));
  } else {
    // Split subscribed alert rows so each v2 container stays under Discord's component cap.
    for (const alertGroup of chunkArray(alerts.slice(0, MAX_ALERTS), SUBSCRIPTIONS_PER_CONTAINER)) {
      const alertContainer = new ContainerBuilder();
      for (const alert of alertGroup) {
        alertContainer.addSectionComponents(
          new SectionBuilder()
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(formatSubscriptionSummary(alert)))
            .setButtonAccessory(
              new ButtonBuilder()
                .setCustomId(`subscriptions:unsubscribe:${alert.id}`)
                .setLabel("Unsubscribe")
                .setStyle(ButtonStyle.Danger)
            )
        );
        alertContainer.addActionRowComponents(buildEventTargetRow(alert));
      }
      components.push(alertContainer);
    }
  }

  headerContainer.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));

  const mentionEnabled = repository.isMentionNotificationsEnabled(guildId, userId);
  const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(SUBSCRIPTION_IDS.add).setLabel("Create alert").setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(SUBSCRIPTION_IDS.toggleMentionNotifications)
      .setLabel(mentionEnabled ? "@mentions: On" : "@mentions: Off")
      .setStyle(mentionEnabled ? ButtonStyle.Success : ButtonStyle.Secondary)
  );

  components.push(buttonRow);
  return { components, flags: MessageFlags.IsComponentsV2 };
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export function buildAlertPanel(alert: Alert): InteractionUpdateOptions {
  const recipients =
    alert.recipientIds.length > 0 ? alert.recipientIds.map((userId) => `<@${userId}>`).join(", ") : "No recipients selected.";
  const container = new ContainerBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      [
        "# Alert",
        `${formatOffset(alert.amount, alert.unit)} before event start.`,
        `Event filters: ${formatEventTarget(alert.eventTarget)}`,
        "",
        `**Recipients**`,
        recipients
      ].join("\n")
    )
  );

  const recipientSelect = new UserSelectMenuBuilder()
    .setCustomId(`eventAlerts:alertRecipients:${alert.id}`)
    .setPlaceholder("Select recipients for this alert")
    .setMinValues(0)
    .setMaxValues(25);

  if (alert.recipientIds.length > 0) {
    recipientSelect.setDefaultUsers(alert.recipientIds.slice(0, 25));
  }

  const recipientRow = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(recipientSelect);

  const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`eventAlerts:editAlert:${alert.id}`).setLabel("Edit alert").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`eventAlerts:deleteAlert:${alert.id}`).setLabel("Delete").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(IDS.back).setLabel("Back").setStyle(ButtonStyle.Secondary)
  );

  return { components: [container, recipientRow, buttonRow], flags: MessageFlags.IsComponentsV2 };
}

function buildHistoryPanel(repository: AlertRepository, guildId: string, page: number): InteractionUpdateOptions {
  const normalizedPage = Math.max(0, page);
  const history = repository.listSentHistory(guildId, normalizedPage, HISTORY_PAGE_SIZE);
  const container = new ContainerBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      ["# Sent history", history.length > 0 ? history.map(formatHistoryEntry).join("\n\n") : "No sent alerts yet."].join("\n")
    )
  );

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${IDS.history}:${Math.max(0, normalizedPage - 1)}`)
      .setLabel("Previous")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(normalizedPage === 0),
    new ButtonBuilder()
      .setCustomId(`${IDS.history}:${normalizedPage + 1}`)
      .setLabel("Next")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(history.length < HISTORY_PAGE_SIZE),
    new ButtonBuilder().setCustomId(IDS.clearHistory).setLabel("Clear history").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(IDS.back).setLabel("Back").setStyle(ButtonStyle.Secondary)
  );

  return { components: [container, row], flags: MessageFlags.IsComponentsV2 };
}

export function buildClearHistoryConfirmationPanel(repository: AlertRepository, guildId: string): InteractionUpdateOptions {
  const history = repository.listSentHistory(guildId, 0, 1);
  const detail =
    history.length > 0
      ? "This permanently deletes the sent-history records for this server. It does not delete alert configurations or recipients. Because Gregor uses sent history to avoid duplicate reminders, clearing it can cause notifications for already-sent event alerts to go out again."
      : "There is no sent history to clear for this server.";
  const container = new ContainerBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(["# Clear sent history?", detail].join("\n\n"))
  );

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(IDS.confirmClearHistory)
      .setLabel("Clear sent history")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(history.length === 0),
    new ButtonBuilder().setCustomId(`${IDS.history}:0`).setLabel("Cancel").setStyle(ButtonStyle.Secondary)
  );

  return { components: [container, row], flags: MessageFlags.IsComponentsV2 };
}

export function buildAdminAlertModal(customId: string, title: string, alert?: Alert): ModalBuilder {
  return buildAlertModal({
    customId,
    title,
    value: alert ? formatOffset(alert.amount, alert.unit) : undefined,
    eventTarget: alert?.eventTarget ?? "interested",
    recipientIds: alert?.recipientIds ?? [],
    includeRecipients: true,
    requireRecipients: !alert
  });
}

function buildOffsetModal(customId: string, title: string, value?: string, eventTarget: AlertEventTarget = "interested"): ModalBuilder {
  return buildAlertModal({ customId, title, value, eventTarget, recipientIds: [], includeRecipients: false, requireRecipients: false });
}

function buildAlertModal(input: {
  customId: string;
  title: string;
  value?: string;
  eventTarget: AlertEventTarget;
  recipientIds: string[];
  includeRecipients: boolean;
  requireRecipients: boolean;
}): ModalBuilder {
  const offsetInput = new TextInputBuilder()
    .setCustomId("offset")
    .setLabel("When should the alert send?")
    .setPlaceholder("30 minutes, 2 hours, or 1 day")
    .setRequired(true)
    .setStyle(TextInputStyle.Short);

  if (input.value) {
    offsetInput.setValue(input.value);
  }

  const eventTargetSelect = buildEventTargetSelect("eventTarget", input.eventTarget);
  const modal = new ModalBuilder()
    .setCustomId(input.customId)
    .setTitle(input.title)
    .addComponents(
      new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(offsetInput),
      {
        type: ComponentType.Label,
        label: "Event filters",
        component: eventTargetSelect.toJSON()
      }
    );

  if (input.includeRecipients) {
    const recipientSelect = new UserSelectMenuBuilder()
      .setCustomId("recipients")
      .setPlaceholder("Select recipients for this alert")
      .setMinValues(input.requireRecipients ? 1 : 0)
      .setMaxValues(25);

    if (input.recipientIds.length > 0) {
      recipientSelect.setDefaultUsers(input.recipientIds.slice(0, 25));
    }

    const recipientComponent = recipientSelect.toJSON() as ReturnType<UserSelectMenuBuilder["toJSON"]> & { required?: boolean };
    recipientComponent.required = input.requireRecipients;

    modal.addComponents({
      type: ComponentType.Label,
      label: "Recipients",
      component: recipientComponent
    });
  }

  // Components v2 modals use labels to host non-text inputs such as select menus.
  return modal;
}

function buildSubscriptionOffsetModal(): ModalBuilder {
  return buildOffsetModal(SUBSCRIPTION_IDS.modalAdd, "Create alert", undefined, "interested");
}

function formatAlertSummary(alert: Alert, currentUserId?: string): string {
  const recipientIds = prioritizeCurrentUser(alert.recipientIds, currentUserId);
  const recipientText = recipientIds.length > 0 ? recipientIds.map((userId) => `<@${userId}>`).join(", ") : "No recipients";
  return `**${formatOffset(alert.amount, alert.unit)} before - ${formatEventTarget(alert.eventTarget)}**\n${recipientText}`;
}

function formatSubscriptionSummary(alert: Alert): string {
  return `**${formatOffset(alert.amount, alert.unit)} before - ${formatEventTarget(alert.eventTarget)}**`;
}

function buildEventTargetRow(alert: Alert): ActionRowBuilder<StringSelectMenuBuilder> {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    buildEventTargetSelect(`subscriptions:eventTarget:${alert.id}`, alert.eventTarget)
  );
}

function buildEventTargetSelect(customId: string, eventTarget: AlertEventTarget): StringSelectMenuBuilder {
  return new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder("Event filters")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel("All")
        .setDescription("Alert me for all scheduled events.")
        .setValue("all")
        .setDefault(eventTarget === "all"),
      new StringSelectMenuOptionBuilder()
        .setLabel("Interested")
        .setDescription("Only alert me for events I marked Interested.")
        .setValue("interested")
        .setDefault(eventTarget === "interested")
    );
}

function parseEventTarget(value: string | undefined): AlertEventTarget | null {
  return value === "all" || value === "interested" ? value : null;
}

function parseModalEventTarget(interaction: ModalSubmitInteraction): AlertEventTarget {
  try {
    return parseEventTarget(interaction.fields.getStringSelectValues("eventTarget")[0]) ?? "interested";
  } catch {
    return "interested";
  }
}

function parseModalRecipientIds(interaction: ModalSubmitInteraction, fallback: string[] = []): string[] {
  try {
    const selectedUsers = interaction.fields.getSelectedUsers("recipients");
    return Array.from(selectedUsers?.values() ?? [])
      .filter((user) => !user.bot)
      .map((user) => user.id);
  } catch {
    return fallback;
  }
}

function formatEventTarget(eventTarget: AlertEventTarget): string {
  return eventTarget === "all" ? "All" : "Interested";
}

function prioritizeCurrentUser(recipientIds: string[], currentUserId?: string): string[] {
  if (!currentUserId || !recipientIds.includes(currentUserId)) {
    return recipientIds;
  }

  return [currentUserId, ...recipientIds.filter((userId) => userId !== currentUserId)];
}

function formatHistoryEntry(entry: SentAlert): string {
  const start = Math.floor(new Date(entry.scheduledStartAt).getTime() / 1000);
  const sent = Math.floor(new Date(entry.sentAt).getTime() / 1000);
  const failed = entry.failedRecipients.length > 0 ? `, ${entry.failedRecipients.length} failed` : "";
  return [
    `**${entry.eventName}**`,
    `Event start: <t:${start}:F>`,
    `Alert: ${formatOffset(entry.offsetAmount, entry.offsetUnit)} before`,
    `Sent: <t:${sent}:R>`,
    `Recipients: ${entry.successfulRecipientIds.length}/${entry.attemptedRecipientIds.length} succeeded${failed}`
  ].join("\n");
}
