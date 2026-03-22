import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";

const TEST_PORT = 3335;
const BASE_URL = `http://localhost:${TEST_PORT}`;

describe("server endpoints", () => {
  let proc: Subprocess;

  beforeAll(async () => {
    proc = Bun.spawn(["bun", "run", "server.ts"], {
      cwd: import.meta.dir + "/..",
      env: { ...process.env, PORT: String(TEST_PORT), DEMO: "true" },
      stdout: "ignore",
      stderr: "ignore",
    });

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(BASE_URL, {
          signal: AbortSignal.timeout(500),
        });
        await res.text();
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    throw new Error("Server did not start within 10s");
  }, 15000);

  afterAll(() => {
    proc?.kill();
  });

  test("GET / returns HTML", async () => {
    const res = await fetch(BASE_URL);
    expect(res.status).toBe(200);
    const ct = res.headers.get("content-type") ?? "";
    expect(ct.toLowerCase()).toContain("text/html");
  });

  test("SSE /events returns text/event-stream", async () => {
    const res = await fetch(`${BASE_URL}/events`);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    res.body?.cancel();
  });

  test("SSE first event has DashboardState shape", async () => {
    const res = await fetch(`${BASE_URL}/events`);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let parsed: any = null;

    const timeout = setTimeout(() => reader.cancel(), 8000);

    try {
      while (!parsed) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (const line of buffer.split("\n")) {
          if (line.startsWith("data: ")) {
            try {
              parsed = JSON.parse(line.slice(6));
            } catch {
              /* partial JSON, keep reading */
            }
          }
        }
      }
    } finally {
      clearTimeout(timeout);
      reader.cancel();
    }

    expect(parsed).not.toBeNull();
    expect(parsed).toHaveProperty("projects");
    expect(parsed).toHaveProperty("sessions");
    expect(parsed).toHaveProperty("timestamp");
    expect(Array.isArray(parsed.projects)).toBe(true);
    expect(Array.isArray(parsed.sessions)).toBe(true);
    expect(typeof parsed.timestamp).toBe("number");
  }, 10000);

  test("GET /404 returns 404", async () => {
    const res = await fetch(`${BASE_URL}/nonexistent`);
    expect(res.status).toBe(404);
  });
});
