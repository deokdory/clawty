import { discoverProjects, discoverSessions, scanSubagents, CLAUDE_PROJECTS_DIR } from "./scanner";
import { classifyStatus, getActiveSessionsFromPidFiles } from "./session";
import { readJsonlHead, readJsonlTail, extractCustomTitle, extractTitle, extractLastMessages, extractMeta, hasTrailingToolUse, extractTokenUsage } from "./jsonl";
import { statSync } from "fs";
import type { DashboardState, SessionView, Project, SessionCacheEntry, SessionMeta } from "./types";

const ARCHIVE_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const WORKING_TTL = 30 * 60 * 1000; // 30 min auto-expire

// Session metadata cache: sessionId → {meta, mtime}
const sessionCache = new Map<string, SessionCacheEntry>();

// Hook-based session tracking: sessionId → timestamp
const workingSessions = new Map<string, number>();
const permissionSessions = new Set<string>(); // sessionIds waiting for permission
const forcedIdleSessions = new Set<string>(); // manually dismissed to IDLE

// Hook-based message cache: sessionId → MessagePreview
const hookUserMessages = new Map<string, MessagePreview>();
const hookAssistantMessages = new Map<string, MessagePreview>();

let lastPidCheck = 0;
const PID_CHECK_INTERVAL = 30_000; // 30s

async function cleanExpiredWorking() {
  const now = Date.now();
  const cutoff = now - WORKING_TTL;
  for (const [cwd, ts] of workingSessions) {
    if (ts < cutoff) {
      workingSessions.delete(cwd);
      permissionSessions.delete(cwd);
    }
  }

  // PID fallback: only every 30s, and only for stale entries (>60s old)
  if (workingSessions.size === 0 && permissionSessions.size === 0) return;
  if (now - lastPidCheck < PID_CHECK_INTERVAL) return;
  lastPidCheck = now;

  const alive = await getActiveSessionsFromPidFiles();
  const aliveSessionIds = new Set(alive.map((s) => s.sessionId));
  for (const [sid, ts] of workingSessions) {
    if (now - ts < 60_000) continue; // trust recent entries
    if (!aliveSessionIds.has(sid)) {
      workingSessions.delete(sid);
      permissionSessions.delete(sid);
    }
  }
  for (const sid of permissionSessions) {
    if (!aliveSessionIds.has(sid)) permissionSessions.delete(sid);
  }
}

function isSessionWorking(sessionId: string): boolean {
  if (!sessionId) return false;
  const ts = workingSessions.get(sessionId);
  if (!ts) return false;
  if (Date.now() - ts > WORKING_TTL) {
    workingSessions.delete(sessionId);
    return false;
  }
  return true;
}

function isSessionPermission(sessionId: string): boolean {
  return sessionId ? permissionSessions.has(sessionId) : false;
}

async function enrichSession(
  session: SessionMeta,
  projectId: string
): Promise<{ meta: SessionMeta; hasToolUse: boolean }> {
  const filePath = `${CLAUDE_PROJECTS_DIR}/${projectId}/${session.id}.jsonl`;

  let mtime = session.lastActivityAt;
  try {
    const stat = statSync(filePath);
    mtime = stat.mtimeMs;
  } catch {
    // use existing mtime
  }

  const cached = sessionCache.get(session.id);
  if (cached && cached.mtime === mtime) {
    return { meta: cached.meta, hasToolUse: cached.hasToolUse };
  }

  // Parse head for meta
  const headLines = await readJsonlHead(filePath);
  const tailLines = await readJsonlTail(filePath);

  const meta = extractMeta(headLines);
  const customTitle = await extractCustomTitle(filePath);
  const title = customTitle || extractTitle(headLines) || extractTitle(tailLines) || session.id.slice(0, 8);
  const jsonlMessages = await extractLastMessages(filePath, tailLines);
  // Hook cache takes priority (always fresh), fallback to JSONL scan
  const lastUserMessage = hookUserMessages.get(session.id) ?? jsonlMessages.lastUserMessage;
  const lastAssistantMessage = hookAssistantMessages.get(session.id) ?? jsonlMessages.lastAssistantMessage;
  const toolUse = hasTrailingToolUse(tailLines);
  const { inputTokens, outputTokens } = await extractTokenUsage(filePath);

  // Re-scan subagents fresh (not from scanner cache)
  const subagentsDir = `${CLAUDE_PROJECTS_DIR}/${projectId}/${session.id}/subagents`;
  const { hasSubagents, subagents } = scanSubagents(subagentsDir);

  const enriched: SessionMeta = {
    ...session,
    cwd: meta.cwd || session.cwd,
    version: meta.version || session.version,
    startedAt: meta.startedAt || session.startedAt,
    title,
    lastUserMessage,
    lastAssistantMessage,
    lastActivityAt: mtime,
    inputTokens,
    outputTokens,
    hasSubagents,
    subagents,
  };

  sessionCache.set(session.id, { meta: enriched, mtime, hasToolUse: toolUse });
  return { meta: enriched, hasToolUse: toolUse };
}

async function buildState(): Promise<DashboardState | { error: string }> {
  try {
    const projects = await discoverProjects();
    const now = Date.now();
    const archiveCutoff = now - ARCHIVE_THRESHOLD_MS;

    const sessions: SessionView[] = [];
    const archivedSessions: SessionView[] = [];

    for (const project of projects) {
      const rawSessions = await discoverSessions(project.id);

      for (const rawSession of rawSessions) {
        const { meta: enriched, hasToolUse } = await enrichSession(rawSession, project.id);
        const hasActiveSubagents = enriched.subagents.some(a => a.status === "active");
        const status = forcedIdleSessions.has(enriched.id)
          ? "IDLE" as const
          : classifyStatus(enriched.lastActivityAt, isSessionWorking(enriched.id), isSessionPermission(enriched.id), hasActiveSubagents);

        const sessionView: SessionView = {
          ...enriched,
          status,
          projectDisplayName: project.displayName,
          projectPath: project.path,
        };

        if (status === "ACTIVE" || status === "WAITING" || enriched.lastActivityAt > archiveCutoff) {
          sessions.push(sessionView);
        } else {
          archivedSessions.push(sessionView);
        }
      }
    }

    // Sort by lastActivityAt descending
    sessions.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    archivedSessions.sort((a, b) => b.lastActivityAt - a.lastActivityAt);

    const activeSessionProjectIds = new Set(sessions.map((s) => s.projectId));
    const archivedProjectIds = projects
      .filter((p) => !activeSessionProjectIds.has(p.id))
      .map((p) => p.id);

    return {
      projects,
      sessions,
      archivedSessions,
      archivedProjectIds,
      timestamp: now,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function buildDemoState(): DashboardState {
  const now = Date.now();

  const projects: Project[] = [
    { id: "-home-dev-web-app", path: "/home/dev/web-app", displayName: "web-app", sessionCount: 3 },
    { id: "-home-dev-api-server", path: "/home/dev/api-server", displayName: "api-server", sessionCount: 2 },
    { id: "-home-dev-cli-tool", path: "/home/dev/cli-tool", displayName: "cli-tool", sessionCount: 1 },
  ];

  const sessions: SessionView[] = [
    {
      id: "ses-demo-1",
      projectId: "-home-dev-web-app",
      cwd: "/home/dev/web-app",
      startedAt: now - 2_400_000,
      lastActivityAt: now - 3_000,
      status: "ACTIVE",
      title: "Implement OAuth2 login flow",
      lastUserMessage: { role: "user", textPreview: "OAuth2 로그인 플로우 구현해줘", timeCreated: now - 60_000 },
      lastAssistantMessage: { role: "assistant", textPreview: "OAuth callback handler implemented. Adding PKCE verification...", timeCreated: now - 3_000 },
      hasSubagents: true,
      subagents: [
        { agentType: "frontend", description: "UI component implementation", status: "active" as const, completedAt: null },
        { agentType: "backend", description: "API route and database integration", status: "completed" as const, completedAt: Date.now() - 30_000 },
      ],
      version: "2.1.80",
      inputTokens: 245800,
      outputTokens: 38200,
      projectDisplayName: "web-app",
      projectPath: "/home/dev/web-app",
    },
    {
      id: "ses-demo-2",
      projectId: "-home-dev-api-server",
      cwd: "/home/dev/api-server",
      startedAt: now - 1_200_000,
      lastActivityAt: now - 120_000,
      status: "RECENT",
      title: "Add rate limiting middleware",
      lastUserMessage: { role: "user", textPreview: "rate limiting middleware 추가해줘", timeCreated: now - 180_000 },
      lastAssistantMessage: { role: "assistant", textPreview: "Rate limiting middleware complete. Added sliding window algorithm.", timeCreated: now - 120_000 },
      hasSubagents: false,
      subagents: [],
      version: "2.1.80",
      inputTokens: 128500,
      outputTokens: 21300,
      projectDisplayName: "api-server",
      projectPath: "/home/dev/api-server",
    },
    {
      id: "ses-demo-3",
      projectId: "-home-dev-cli-tool",
      cwd: "/home/dev/cli-tool",
      startedAt: now - 420_000,
      lastActivityAt: now - 4_000,
      status: "ACTIVE",
      title: "Add --json output flag",
      lastUserMessage: { role: "user", textPreview: "Add a --json flag for machine-readable output", timeCreated: now - 20_000 },
      lastAssistantMessage: null,
      hasSubagents: false,
      subagents: [],
      version: "2.1.80",
      inputTokens: 52000,
      outputTokens: 8400,
      projectDisplayName: "cli-tool",
      projectPath: "/home/dev/cli-tool",
    },
    {
      id: "ses-demo-4",
      projectId: "-home-dev-web-app",
      cwd: "/home/dev/web-app",
      startedAt: now - 600_000,
      lastActivityAt: now - 15_000,
      status: "WAITING",
      title: "Refactor auth middleware",
      lastUserMessage: { role: "user", textPreview: "auth middleware 리팩토링 해줘", timeCreated: now - 30_000 },
      lastAssistantMessage: { role: "assistant", textPreview: "This will delete 3 files and modify server.ts. Should I proceed?", timeCreated: now - 15_000 },
      hasSubagents: false,
      subagents: [],
      version: "2.1.80",
      inputTokens: 95200,
      outputTokens: 15600,
      projectDisplayName: "web-app",
      projectPath: "/home/dev/web-app",
    },
    {
      id: "ses-demo-5",
      projectId: "-home-dev-api-server",
      cwd: "/home/dev/api-server",
      startedAt: now - 8_400_000,
      lastActivityAt: now - 7_200_000,
      status: "IDLE",
      title: "Database migration v2.3",
      lastUserMessage: null,
      lastAssistantMessage: null,
      hasSubagents: false,
      subagents: [],
      version: "2.1.80",
      inputTokens: 310000,
      outputTokens: 47500,
      projectDisplayName: "api-server",
      projectPath: "/home/dev/api-server",
    },
  ];

  return {
    projects,
    sessions,
    archivedSessions: [],
    archivedProjectIds: [],
    timestamp: now,
  };
}

const DEMO_MODE = Bun.env.DEMO === "true";

type Controller = ReadableStreamDefaultController<Uint8Array>;
const clients = new Set<Controller>();
const encoder = new TextEncoder();

function broadcast(state: DashboardState | { error: string }): void {
  const payload = encoder.encode(`data: ${JSON.stringify(state)}\n\n`);
  for (const client of clients) {
    try {
      client.enqueue(payload);
    } catch {
      clients.delete(client);
    }
  }
}

setInterval(async () => {
  if (clients.size === 0) return;
  await cleanExpiredWorking();
  const state = DEMO_MODE ? buildDemoState() : await buildState();
  broadcast(state);
}, 2_000);

const PORT = parseInt(Bun.env.PORT ?? "3333", 10);

Bun.serve({
  port: PORT,
  async fetch(req: Request) {
    const url = new URL(req.url);

    if (url.pathname === "/events") {
      let clientController: Controller | null = null;

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          clientController = controller;
          clients.add(controller);

          const state = DEMO_MODE ? buildDemoState() : await buildState();
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(state)}\n\n`));
          } catch {
            clients.delete(controller);
          }
        },
        cancel() {
          if (clientController) {
            clients.delete(clientController);
          }
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    if (url.pathname === "/notify" && req.method === "POST") {
      const event = url.searchParams.get("event") || "refresh";
      let body: Record<string, unknown> = {};
      try { body = await req.json() as Record<string, unknown>; } catch {}
      console.log(`[hook] ${event} session=${(body.session_id ?? "?") as string} keys=${Object.keys(body).join(",")}`);

      const sessionId = (body.session_id ?? "") as string;

      if (event === "prompt" && sessionId) {
        workingSessions.set(sessionId, Date.now());
        permissionSessions.delete(sessionId);
        forcedIdleSessions.delete(sessionId);
        const prompt = body.prompt as string | undefined;
        if (prompt) {
          hookUserMessages.set(sessionId, {
            role: "user",
            textPreview: prompt.slice(0, 200),
            timeCreated: Date.now(),
          });
        }
      } else if (event === "permission" && sessionId) {
        permissionSessions.add(sessionId);
      } else if (event === "stop" && sessionId) {
        workingSessions.delete(sessionId);
        permissionSessions.delete(sessionId);
        const lastMsg = body.last_assistant_message as string | undefined;
        if (lastMsg) {
          hookAssistantMessages.set(sessionId, {
            role: "assistant",
            textPreview: lastMsg.slice(0, 200),
            timeCreated: Date.now(),
          });
        }
      }

      if (!DEMO_MODE) {
        const state = await buildState();
        broadcast(state);
      }
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    if (url.pathname === "/dismiss" && req.method === "POST") {
      const sessionId = url.searchParams.get("session") || "";
      if (sessionId) {
        forcedIdleSessions.add(sessionId);
        workingSessions.delete(sessionId);
        permissionSessions.delete(sessionId);
        if (!DEMO_MODE) {
          const state = await buildState();
          broadcast(state);
        }
      }
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(Bun.file(new URL("./public/index.html", import.meta.url)), {
        headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`CC Dashboard running at http://localhost:${PORT}${DEMO_MODE ? " (DEMO MODE)" : ""}`);
