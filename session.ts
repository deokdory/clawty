import { readdirSync, readFileSync } from "fs";
import type { ActiveSession } from "./types";

export const CLAUDE_DIR = `${Bun.env.HOME ?? ""}/.claude`;
export const SESSIONS_DIR = `${CLAUDE_DIR}/sessions`;

export function isClaudeProcess(pid: number): boolean {
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf-8");
    return cmdline.includes("claude");
  } catch {
    return false;
  }
}

export async function getActiveSessionsFromPidFiles(): Promise<ActiveSession[]> {
  try {
    const entries = readdirSync(SESSIONS_DIR);
    const sessions: ActiveSession[] = [];
    
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const pidStr = entry.slice(0, -5);
      const pid = parseInt(pidStr, 10);
      if (isNaN(pid)) continue;
      
      if (!isClaudeProcess(pid)) continue;
      
      try {
        const file = Bun.file(`${SESSIONS_DIR}/${entry}`);
        const data = await file.json() as { pid: number; sessionId: string; cwd: string; startedAt: number };
        sessions.push({
          pid: data.pid,
          sessionId: data.sessionId,
          cwd: data.cwd,
          startedAt: data.startedAt,
        });
      } catch {
        // skip malformed session file
      }
    }
    
    return sessions;
  } catch {
    return [];
  }
}

export function classifyStatus(
  mtime: number,
  isWorking = false,
  isPermission = false,
  hasActiveSubagents = false
): "ACTIVE" | "WAITING" | "RECENT" | "IDLE" {
  const age = Date.now() - mtime;

  if (isPermission) return "WAITING";
  if (isWorking || hasActiveSubagents) return "ACTIVE";
  if (age < 5_000) return "ACTIVE";
  if (age < 300_000) return "RECENT";
  return "IDLE";
}
