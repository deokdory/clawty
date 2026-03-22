import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readJsonlHead, readJsonlTail, parseJsonlLine, extractTitle, extractLastMessagesFromLines, extractMeta } from "../jsonl";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const TEST_DIR = join(tmpdir(), "cc-dashboard-jsonl-test-" + Date.now());

const USER_LINE = JSON.stringify({
  parentUuid: null,
  isSidechain: false,
  type: "user",
  message: { role: "user", content: "hello world, please help me" },
  isMeta: false,
  uuid: "abc123",
  timestamp: "2026-03-20T07:00:00.000Z",
  userType: "external",
  entrypoint: "cli",
  cwd: "/home/user/project",
  sessionId: "sess-1",
  version: "2.1.80",
});

const ASSISTANT_LINE = JSON.stringify({
  parentUuid: "abc123",
  isSidechain: false,
  type: "assistant",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Hi there! I can help you with that." }],
    model: "claude-opus-4-5",
    usage: { input_tokens: 10, output_tokens: 5 },
  },
  uuid: "def456",
  timestamp: "2026-03-20T07:00:01.000Z",
  cwd: "/home/user/project",
  sessionId: "sess-1",
  version: "2.1.80",
});

const META_USER_LINE = JSON.stringify({
  parentUuid: null,
  isSidechain: false,
  type: "user",
  message: { role: "user", content: "<local-command-caveat>Caveat message</local-command-caveat>" },
  isMeta: true,
  uuid: "meta1",
  timestamp: "2026-03-20T06:59:00.000Z",
  cwd: "/home/user/project",
  sessionId: "sess-1",
  version: "2.1.80",
});

const SNAPSHOT_LINE = JSON.stringify({
  type: "file-history-snapshot",
  messageId: "snap1",
  snapshot: {},
  isSnapshotUpdate: false,
});

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  try { rmSync(TEST_DIR, { recursive: true }); } catch {}
});

describe("parseJsonlLine", () => {
  test("parses valid JSON line", () => {
    const result = parseJsonlLine(USER_LINE);
    expect(result).not.toBeNull();
    expect(result?.type).toBe("user");
    expect(result?.sessionId).toBe("sess-1");
  });

  test("returns null for empty string", () => {
    expect(parseJsonlLine("")).toBeNull();
    expect(parseJsonlLine("   ")).toBeNull();
  });

  test("returns null for invalid JSON", () => {
    expect(parseJsonlLine("{invalid}")).toBeNull();
  });
});

describe("readJsonlHead", () => {
  test("reads head of file", async () => {
    const filePath = join(TEST_DIR, "head.jsonl");
    writeFileSync(filePath, [META_USER_LINE, USER_LINE, ASSISTANT_LINE].join("\n") + "\n");
    
    const lines = await readJsonlHead(filePath);
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
  });

  test("returns empty array for non-existent file", async () => {
    const lines = await readJsonlHead("/nonexistent/path.jsonl");
    expect(lines).toEqual([]);
  });
});

describe("readJsonlTail", () => {
  test("reads tail of file", async () => {
    const filePath = join(TEST_DIR, "tail.jsonl");
    writeFileSync(filePath, [USER_LINE, ASSISTANT_LINE].join("\n") + "\n");
    
    const lines = await readJsonlTail(filePath);
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
  });

  test("tail returns last message", async () => {
    const filePath = join(TEST_DIR, "tail2.jsonl");
    writeFileSync(filePath, [USER_LINE, ASSISTANT_LINE].join("\n") + "\n");
    
    const lines = await readJsonlTail(filePath);
    const last = lines[lines.length - 1];
    expect(last?.type).toBe("assistant");
  });
});

describe("extractTitle", () => {
  test("extracts title from first real user message", () => {
    const lines = [
      parseJsonlLine(SNAPSHOT_LINE)!,
      parseJsonlLine(META_USER_LINE)!,
      parseJsonlLine(USER_LINE)!,
    ].filter(Boolean);
    
    const title = extractTitle(lines);
    expect(title).toBe("hello world, please help me");
  });

  test("truncates to 100 chars", () => {
    const longContent = "a".repeat(200);
    const longUserLine = JSON.stringify({
      ...JSON.parse(USER_LINE),
      message: { role: "user", content: longContent },
    });
    
    const title = extractTitle([parseJsonlLine(longUserLine)!]);
    expect(title.length).toBe(100);
  });

  test("returns empty string when no real user messages", () => {
    const lines = [parseJsonlLine(META_USER_LINE)!, parseJsonlLine(SNAPSHOT_LINE)!].filter(Boolean);
    expect(extractTitle(lines)).toBe("");
  });
});

describe("extractLastMessages", () => {
  test("extracts both user and assistant messages", () => {
    const lines = [
      parseJsonlLine(USER_LINE)!,
      parseJsonlLine(ASSISTANT_LINE)!,
    ].filter(Boolean);

    const { lastUserMessage, lastAssistantMessage } = extractLastMessagesFromLines(lines);
    expect(lastAssistantMessage).not.toBeNull();
    expect(lastAssistantMessage?.role).toBe("assistant");
    expect(lastAssistantMessage?.textPreview).toContain("Hi there");
    expect(lastUserMessage).not.toBeNull();
    expect(lastUserMessage?.role).toBe("user");
  });

  test("returns nulls for empty array", () => {
    const { lastUserMessage, lastAssistantMessage } = extractLastMessagesFromLines([]);
    expect(lastUserMessage).toBeNull();
    expect(lastAssistantMessage).toBeNull();
  });

  test("truncates textPreview to 200 chars", () => {
    const longText = "b".repeat(300);
    const longAssistantLine = JSON.stringify({
      ...JSON.parse(ASSISTANT_LINE),
      message: {
        role: "assistant",
        content: [{ type: "text", text: longText }],
      },
    });

    const { lastAssistantMessage } = extractLastMessagesFromLines([parseJsonlLine(longAssistantLine)!]);
    expect(lastAssistantMessage?.textPreview.length).toBe(200);
  });
});

describe("extractMeta", () => {
  test("extracts metadata from head lines", () => {
    const lines = [
      parseJsonlLine(SNAPSHOT_LINE)!,
      parseJsonlLine(USER_LINE)!,
    ].filter(Boolean);
    
    const meta = extractMeta(lines);
    expect(meta.cwd).toBe("/home/user/project");
    expect(meta.version).toBe("2.1.80");
    expect(meta.sessionId).toBe("sess-1");
    expect(meta.startedAt).toBeGreaterThan(0);
  });

  test("returns empty values for empty array", () => {
    const meta = extractMeta([]);
    expect(meta.cwd).toBe("");
    expect(meta.version).toBe("");
    expect(meta.sessionId).toBe("");
    expect(meta.startedAt).toBe(0);
  });
});
