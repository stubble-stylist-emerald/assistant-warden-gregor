import type { Guild } from "discord.js";

// Max role size for DM mention notifications. Roles with more members
// skip DMs to avoid rate limits; channel notifications cover them instead.
export const MAX_DM_ROLE_SIZE = 100;

export interface MentionResult {
  userIds: string[];
  roleIds: string[];
}

// Extract user and role mentions from a Discord message body.
// Handles both <@id> and <@!id> (nickname) formats for users,
// and <@&id> for roles. Explicitly ignores @everyone and @here.
export function parseMentionedUsers(description: string | null): MentionResult {
  if (!description) {
    return { userIds: [], roleIds: [] };
  }

  const userMentions = new Set<string>();
  const roleMentions = new Set<string>();

  // Match <@!?digits> for users and <@&digits> for roles.
  // The global flag captures overlapping matches correctly because mention
  // formats are non-overlapping.
  const mentionRegex = /<@(!)?(\d+)>|<@&(\d+)>/g;
  let match: RegExpExecArray | null;
  while ((match = mentionRegex.exec(description)) !== null) {
    if (match[2]) {
      userMentions.add(match[2]);
    } else if (match[3]) {
      roleMentions.add(match[3]);
    }
  }

  return {
    userIds: Array.from(userMentions),
    roleIds: Array.from(roleMentions)
  };
}

// Resolve role IDs to their member user IDs using paginated guild member fetch.
// Members are fetched once per poll cycle and cached by discord.js.
export async function resolveRoleMembers(guild: Guild, roleIds: string[]): Promise<string[]> {
  if (roleIds.length === 0) {
    return [];
  }

  // Fetch all guild members with pagination. discord.js caches the result
  // so repeated calls during the same poll cycle are cheap.
  try {
    await fetchAllMembers(guild);
  } catch (error) {
    // If we can't fetch members (missing permissions, API error), return
    // whatever partial data we have from cache.
    console.warn(
      `[mentions] Failed to fetch all members for guild ${guild.id}:`,
      error instanceof Error ? error.message : String(error)
    );
  }

  const userIds = new Set<string>();
  for (const roleId of roleIds) {
    const role = guild.roles.cache.get(roleId);
    if (!role) {
      continue;
    }

    for (const [, member] of role.members) {
      if (!member.user.bot) {
        userIds.add(member.user.id);
      }
    }
  }

  const roleMembers = Array.from(userIds);
  if (roleMembers.length > MAX_DM_ROLE_SIZE) {
    console.warn(
      `[mentions] Skipping DMs for ${roleMembers.length} role members in guild ${guild.id} ` +
        `(exceeds cap of ${MAX_DM_ROLE_SIZE}). Channel notification will still fire if configured.`
    );
    return [];
  }

  return roleMembers;
}

async function fetchAllMembers(guild: Guild): Promise<void> {
  let after: string | undefined;

  while (true) {
    const members = await guild.members.list({ limit: 1000, after });
    if (members.size === 0) {
      break;
    }

    if (members.size < 1000) {
      break;
    }

    after = members.lastKey();
    if (!after) {
      break;
    }
  }
}
