import { describe, expect, it } from "vitest";
import { parseVerdict } from "./judge";
import { buildTranscript, eventToEntry, mentionedThreadIds } from "./transcript";

describe("eventToEntry", () => {
  it("labels who sent each turn", () => {
    const turn = (data: object) => eventToEntry({ type: "client/turn/requested", seq: 1, data });
    const input = [{ type: "text", text: "fix the bug" }];
    expect(turn({ initiator: "user", input })).toBe("### USER\nfix the bug");
    expect(turn({ initiator: "system", input })).toBe("### BB SYSTEM MESSAGE\nfix the bug");
    expect(turn({ initiator: "user", senderThreadId: "thr_abcdef1234", input })).toBe(
      "### MESSAGE FROM @thread:thr_abcdef1234\nfix the bug",
    );
  });

  it("keeps agent replies, commands, tool calls and edits, and drops reads", () => {
    const item = (item: object) => eventToEntry({ type: "item/completed", seq: 1, data: { item } });
    expect(item({ type: "agentMessage", text: "Done." })).toBe("### AGENT\nDone.");
    expect(item({ type: "commandExecution", command: "npm   test\n" })).toBe("$ npm test");
    expect(item({ type: "toolCall", tool: "agent", arguments: { a: 1 }, result: "ok" })).toBe(
      '[tool agent] {"a":1} => ok',
    );
    expect(item({ type: "fileChange", changes: [{ path: "/a.ts", kind: "update" }] })).toBe("[update /a.ts]");
    expect(item({ type: "fileRead", path: "/a.ts" })).toBeNull();
    expect(item({ type: "agentMessage", text: "  " })).toBeNull();
  });
});

describe("buildTranscript", () => {
  it("keeps the start and the end when the thread is over budget", () => {
    const text = buildTranscript(["A".repeat(500), "B".repeat(500), "C".repeat(500)], 400);
    expect(text.startsWith("A".repeat(100))).toBe(true);
    expect(text.endsWith("C".repeat(300))).toBe(true);
    expect(text).toContain("omitted");
  });
});

describe("mentionedThreadIds", () => {
  it("finds other threads once each", () => {
    expect(mentionedThreadIds("@thread:thr_aaaaaa1 and thr_self12 then thr_aaaaaa1, thr_bbbbbb2", "thr_self12")).toEqual([
      "thr_aaaaaa1",
      "thr_bbbbbb2",
    ]);
  });
});

describe("parseVerdict", () => {
  it("reads the last JSON object, ignoring think blocks and fences", () => {
    expect(
      parseVerdict('<think>{"resolved": true, "reason": "x"}</think>```json\n{"resolved": false, "reason": "Asks which option."}\n```'),
    ).toEqual({ resolved: false, reason: "Asks which option." });
  });

  it("refuses a reply without a verdict", () => {
    expect(() => parseVerdict("yes")).toThrow(/no verdict/);
  });
});
