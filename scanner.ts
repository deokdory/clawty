import { readdirSync, readFileSync, statSync } from "fs";
import type { Project, SessionMeta, SubagentInfo } from "./types";
import { readJsonlHead, extractMeta } from "./jsonl";

export const CLAUDE_PROJECTS_DIR = `${Bun.env.HOME ?? ""}/.claude/projects`;

const ACTIVE_THRESHOLD = 10_000; // 10s — recently written = active

export function scanSubagents(subagentsDir: string): { hasSubagents: boolean; subagents: SubagentInfo[] } {
  try {
    statSync(subagentsDir);
  } catch {
    return { hasSubagents: false, subagents: [] };
  }

  const subagents: SubagentInfo[] = [];
  try {
    const now = Date.now();
    const metaFiles = readdirSync(subagentsDir).filter((f) => f.endsWith(".meta.json"));
    for (const metaFile of metaFiles) {
      try {
        const raw = readFileSync(`${subagentsDir}/${metaFile}`, "utf8");
        const parsed = JSON.parse(raw) as Partial<SubagentInfo>;
        if (parsed.agentType && parsed.description) {
          const jsonlFile = metaFile.replace(".meta.json", ".jsonl");
          let agentStatus: "active" | "completed" = "completed";
          let completedAt: number | null = null;
          try {
            const jsonlStat = statSync(`${subagentsDir}/${jsonlFile}`);
            const age = now - jsonlStat.mtimeMs;
            if (age < ACTIVE_THRESHOLD) {
              agentStatus = "active";
            } else {
              completedAt = jsonlStat.mtimeMs;
            }
          } catch {
            completedAt = now;
          }
          subagents.push({ agentType: parsed.agentType, description: parsed.description, status: agentStatus, completedAt });
        }
      } catch {
        // skip malformed meta file
      }
    }
  } catch {
    // readdirSync failed
  }

  return { hasSubagents: true, subagents };
}

export function decodeProjectPath(encoded: string): string {
  // Fallback: naive decode (loses hyphens in directory names)
  return encoded.replace(/^-/, "/").replace(/-/g, "/");
}

async function cwdFromFirstJsonl(projectDir: string, jsonlFiles: string[]): Promise<string> {
  if (jsonlFiles.length === 0) return "";
  try {
    const head = await readJsonlHead(`${projectDir}/${jsonlFiles[0]}`);
    return extractMeta(head).cwd;
  } catch {
    return "";
  }
}

let projectsCache: Project[] = [];
let projectsCacheAt = 0;
const PROJECTS_TTL = 30_000;

export async function discoverProjects(): Promise<Project[]> {
  if (Date.now() - projectsCacheAt < PROJECTS_TTL && projectsCache.length > 0) {
    return projectsCache;
  }

  try {
    const entries = readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true });
    const projects: Project[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const id = entry.name;
      const projectDir = `${CLAUDE_PROJECTS_DIR}/${id}`;

      // Count .jsonl files and collect names
      const jsonlFiles: string[] = [];
      try {
        const sessionEntries = readdirSync(projectDir, { withFileTypes: true });
        for (const se of sessionEntries) {
          if (se.isFile() && se.name.endsWith(".jsonl")) jsonlFiles.push(se.name);
        }
      } catch {
        // skip
      }

      // Get real path from JSONL cwd, fall back to naive decode
      const cwd = await cwdFromFirstJsonl(projectDir, jsonlFiles);
      const path = cwd || decodeProjectPath(id);
      const segments = path.split("/").filter(Boolean);
      const displayName = segments[segments.length - 1] ?? id;

      projects.push({ id, path, displayName, sessionCount: jsonlFiles.length });
    }

    projectsCache = projects;
    projectsCacheAt = Date.now();
    return projects;
  } catch {
    return [];
  }
}

export async function discoverSessions(projectId: string): Promise<SessionMeta[]> {
  const projectDir = `${CLAUDE_PROJECTS_DIR}/${projectId}`;
  
  try {
    const entries = readdirSync(projectDir, { withFileTypes: true });
    const sessions: SessionMeta[] = [];
    
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      
      const id = entry.name.slice(0, -6); // remove .jsonl
      const filePath = `${projectDir}/${entry.name}`;
      
      let mtime = 0;
      try {
        const stat = statSync(filePath);
        mtime = stat.mtimeMs;
      } catch {
        // skip
      }
      
      const { hasSubagents, subagents } = scanSubagents(`${projectDir}/${id}/subagents`);
      
      sessions.push({
        id,
        projectId,
        cwd: "",
        startedAt: 0,
        lastActivityAt: mtime,
        status: "IDLE",
        title: "",
        lastUserMessage: null,
        lastAssistantMessage: null,
        hasSubagents,
        subagents,
        version: "",
        inputTokens: 0,
        outputTokens: 0,
      });
    }
    
    return sessions;
  } catch {
    return [];
  }
}
