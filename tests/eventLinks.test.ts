import { describe, expect, it } from "vitest";
import { parseEventLink } from "../src/eventLinks";

const EVENT_ID = "1553221952360022126";

describe("parseEventLink", () => {
  it("parses an invite link with ?event=", () => {
    expect(parseEventLink(`https://discord.gg/Uecdv2KjB?event=${EVENT_ID}`)).toBe(EVENT_ID);
  });

  it("parses discord.com/invite links", () => {
    expect(parseEventLink(`https://discord.com/invite/Uecdv2KjB?event=${EVENT_ID}`)).toBe(EVENT_ID);
  });

  it("parses direct event links", () => {
    expect(parseEventLink(`https://discord.com/events/1413192357637263370/${EVENT_ID}`)).toBe(EVENT_ID);
  });

  it("parses discordapp.com event links", () => {
    expect(parseEventLink(`https://discordapp.com/events/1413192357637263370/${EVENT_ID}`)).toBe(EVENT_ID);
  });

  it("parses canary and ptb subdomains", () => {
    expect(parseEventLink(`https://canary.discord.com/events/1413192357637263370/${EVENT_ID}`)).toBe(EVENT_ID);
    expect(parseEventLink(`https://ptb.discord.com/invite/abc?event=${EVENT_ID}`)).toBe(EVENT_ID);
  });

  it("handles extra query params around event", () => {
    expect(parseEventLink(`https://discord.gg/abc?foo=1&event=${EVENT_ID}&bar=2`)).toBe(EVENT_ID);
  });

  it("finds a link embedded in surrounding text", () => {
    expect(parseEventLink(`hey check this out https://discord.gg/abc?event=${EVENT_ID} thanks`)).toBe(EVENT_ID);
  });

  it("handles markdown-wrapped and angle-bracket links", () => {
    expect(parseEventLink(`[click](https://discord.gg/abc?event=${EVENT_ID})`)).toBe(EVENT_ID);
    expect(parseEventLink(`<https://discord.gg/abc?event=${EVENT_ID}>`)).toBe(EVENT_ID);
  });

  it("tolerates trailing punctuation", () => {
    expect(parseEventLink(`https://discord.com/events/1413192357637263370/${EVENT_ID}.`)).toBe(EVENT_ID);
    expect(parseEventLink(`join here: https://discord.gg/abc?event=${EVENT_ID},`)).toBe(EVENT_ID);
  });

  it("returns the first link by position", () => {
    const other = "1553221952360022199";
    expect(parseEventLink(`https://discord.gg/a?event=${EVENT_ID} https://discord.gg/b?event=${other}`)).toBe(EVENT_ID);
  });

  it("rejects non-discord hosts", () => {
    expect(parseEventLink(`https://example.com/?event=${EVENT_ID}`)).toBeNull();
    expect(parseEventLink(`https://notdiscord.com/events/1/${EVENT_ID}`)).toBeNull();
  });

  it("rejects non-snowflake event values", () => {
    expect(parseEventLink(`https://discord.gg/abc?event=123`)).toBeNull();
    expect(parseEventLink(`https://discord.gg/abc?event=notanumber`)).toBeNull();
  });

  it("returns null when there is no link", () => {
    expect(parseEventLink("just some text")).toBeNull();
    expect(parseEventLink("")).toBeNull();
  });
});
