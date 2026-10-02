// Pure parsing of Discord scheduled-event links from message text.

// Snowflake shape: 17-20 digits. Guards against false positives on short
// numeric query values (e.g. ?event=123 from some unrelated site).
const SNOWFLAKE = /^\d{17,20}$/;

// URLs may be wrapped in <> (suppressed embeds) or markdown (inline code,
// bold, spoilers) or surrounded by punctuation. Exclude whitespace and common
// delimiters — including ``, `|`, and `*` — so we isolate the bare URL.
const URL_REGEX = /https?:\/\/[^\s<>()[\]"'`|*]+/gi;

// Direct event URL path: /events/<guild>/<event>
const DIRECT_EVENT_PATH = /^\/events\/\d{17,20}\/(\d{17,20})$/;

// Extract the first Discord scheduled-event ID from text, or null if none.
// "First" is first-by-position across the message.
export function parseEventLink(text: string): string | null {
  let match: RegExpExecArray | null;
  URL_REGEX.lastIndex = 0;
  while ((match = URL_REGEX.exec(text)) !== null) {
    const eventId = extractEventId(stripTrailingPunctuation(match[0]));
    if (eventId) {
      return eventId;
    }
  }

  return null;
}

function extractEventId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (!isDiscordHost(parsed.hostname)) {
    return null;
  }

  const directMatch = parsed.pathname.match(DIRECT_EVENT_PATH);
  if (directMatch) {
    return directMatch[1];
  }

  const eventParam = parsed.searchParams.get("event");
  if (eventParam && SNOWFLAKE.test(eventParam)) {
    return eventParam;
  }

  return null;
}

function isDiscordHost(hostname: string): boolean {
  // Allow ptb./canary./www. prefixes.
  const normalized = hostname.toLowerCase().replace(/^(?:ptb|canary|www)\./, "");
  return (
    normalized === "discord.com" ||
    normalized === "discord.gg" ||
    normalized === "discordapp.com" ||
    normalized === "discordapp.gg"
  );
}

function stripTrailingPunctuation(url: string): string {
  return url.replace(/[.,;:!?]+$/, "");
}
