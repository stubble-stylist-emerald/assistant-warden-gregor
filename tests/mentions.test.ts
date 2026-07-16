import { describe, expect, it } from "vitest";
import { parseMentionedUsers } from "../src/mentions";

describe("parseMentionedUsers", () => {
  it("extracts user mentions", () => {
    const result = parseMentionedUsers("hey <@12345> and <@67890>");

    expect(result.userIds).toEqual(["12345", "67890"]);
    expect(result.roleIds).toEqual([]);
  });

  it("extracts nickname-format user mentions", () => {
    const result = parseMentionedUsers("hey <@!12345>");

    expect(result.userIds).toEqual(["12345"]);
  });

  it("extracts role mentions", () => {
    const result = parseMentionedUsers("attention <@&54321>");

    expect(result.userIds).toEqual([]);
    expect(result.roleIds).toEqual(["54321"]);
  });

  it("extracts mixed user and role mentions", () => {
    const result = parseMentionedUsers("<@11111> and <@&22222> and <@!33333>");

    expect(result.userIds).toEqual(["11111", "33333"]);
    expect(result.roleIds).toEqual(["22222"]);
  });

  it("deduplicates repeated mentions", () => {
    const result = parseMentionedUsers("<@12345> <@12345> <@&67890> <@&67890>");

    expect(result.userIds).toEqual(["12345"]);
    expect(result.roleIds).toEqual(["67890"]);
  });

  it("returns empty arrays for null description", () => {
    const result = parseMentionedUsers(null);

    expect(result.userIds).toEqual([]);
    expect(result.roleIds).toEqual([]);
  });

  it("returns empty arrays for description with no mentions", () => {
    const result = parseMentionedUsers("just plain text here");

    expect(result.userIds).toEqual([]);
    expect(result.roleIds).toEqual([]);
  });

  it("ignores @everyone and @here", () => {
    const result = parseMentionedUsers("hey @everyone check this out @here please");

    expect(result.userIds).toEqual([]);
    expect(result.roleIds).toEqual([]);
  });

  it("handles empty string", () => {
    const result = parseMentionedUsers("");

    expect(result.userIds).toEqual([]);
    expect(result.roleIds).toEqual([]);
  });
});
