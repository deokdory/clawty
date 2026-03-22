import { describe, test, expect } from "bun:test";
import { isClaudeProcess, classifyStatus } from "../session";

describe("isClaudeProcess", () => {
  test("returns false for current process (not claude)", () => {
    expect(isClaudeProcess(process.pid)).toBe(false);
  });

  test("returns false for non-existent PID", () => {
    expect(isClaudeProcess(9999999)).toBe(false);
  });
});

describe("classifyStatus", () => {
  test("returns ACTIVE when mtime < 5s", () => {
    expect(classifyStatus(Date.now() - 2_000)).toBe("ACTIVE");
  });

  test("returns ACTIVE when isWorking even if mtime stale", () => {
    expect(classifyStatus(Date.now() - 30_000, true)).toBe("ACTIVE");
  });

  test("returns WAITING when isPermission regardless of mtime", () => {
    expect(classifyStatus(Date.now() - 10_000, false, true)).toBe("WAITING");
  });

  test("returns RECENT when mtime 5s-5min", () => {
    expect(classifyStatus(Date.now() - 60_000)).toBe("RECENT");
  });

  test("returns IDLE when mtime > 5min", () => {
    expect(classifyStatus(Date.now() - 600_000)).toBe("IDLE");
  });
});

describe("getActiveSessionsFromPidFiles", () => {
  test("returns array without crashing", async () => {
    const { getActiveSessionsFromPidFiles } = await import("../session");
    const result = await getActiveSessionsFromPidFiles();
    expect(Array.isArray(result)).toBe(true);
  });
});
