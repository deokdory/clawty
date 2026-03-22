import { readlink } from "fs/promises";
import { $ } from "bun";

export interface CcProcess {
  pid: number;
  cpu: string;
  mem: string;
  elapsed: string;
  cwd: string;
}

export function isClaudeCodeProcess(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  
  // Direct claude binary
  if (trimmed === "claude") return true;
  if (trimmed.endsWith("/claude")) return true;
  if (/\/claude\s/.test(trimmed)) return true;
  if (/^claude\s/.test(trimmed)) return true;
  
  // bun/node running claude script
  if (/\bclaude\b/.test(trimmed) && (trimmed.includes("bun") || trimmed.includes("node"))) return true;
  
  return false;
}

export async function getCwd(pid: number): Promise<string> {
  if (process.platform === "linux") {
    try {
      const cwd = await readlink(`/proc/${pid}/cwd`);
      return cwd.replace(/ \(deleted\)$/, "");
    } catch {
      return "";
    }
  } else if (process.platform === "darwin") {
    try {
      const out = await $`lsof -p ${pid} -a -d cwd -Fn`.text();
      const match = out.split("\n").find((l) => l.startsWith("n"));
      return match ? match.slice(1).trim() : "";
    } catch {
      return "";
    }
  } else {
    return "";
  }
}

export async function getClaudeCodeProcesses(): Promise<CcProcess[]> {
  try {
    const psOutput = await $`ps aux`.text();
    const lines = psOutput.trim().split("\n").slice(1);
    
    const processes: CcProcess[] = [];
    
    for (const line of lines) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 11) continue;
      
      const command = cols.slice(10).join(" ");
      if (!isClaudeCodeProcess(command)) continue;
      
      const pid = parseInt(cols[1], 10);
      if (isNaN(pid)) continue;
      
      const cpu = cols[2];
      const mem = cols[3];
      const elapsed = cols[9];
      const cwd = await getCwd(pid);
      
      processes.push({ pid, cpu, mem, elapsed, cwd });
    }
    
    return processes;
  } catch {
    return [];
  }
}
