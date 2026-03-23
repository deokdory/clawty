# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Clawty — real-time session monitoring dashboard for Claude Code. Tracks active sessions, subagent orchestration, and status changes via SSE. Zero npm dependencies, pure Bun + TypeScript.

## Commands

- `bun run server.ts` — start the server (port 3333, override with PORT env var)
- `bun test` — run all tests
- `bun test tests/jsonl.test.ts` — run a single test file
- `DEMO=1 bun run server.ts` — start in demo mode with synthetic data

## Architecture

**Server** (`server.ts`): Bun HTTP server with SSE broadcasting. Receives Claude Code lifecycle hooks via `POST /notify` (prompt/permission/stop events), builds dashboard state every 2s by scanning JSONL logs, and streams updates to connected browsers via `GET /events`.

**State pipeline**: `discoverProjects()` → `discoverSessions()` → `enrichSession()` (parse JSONL head/tail, scan subagents, extract tokens) → `classifyStatus()` → broadcast to SSE clients.

**Session status classification** (`session.ts`): ACTIVE (working/permission flag set, or activity <5s, or has active subagents) → WAITING (pending AskUserQuestion tool) → RECENT (<5min inactive) → IDLE (>5min or manually dismissed).

**JSONL parsing** (`jsonl.ts`): Efficient head (8KB) / tail (32KB) reads of `~/.claude/projects/` log files. Progressive backward scanning up to 512KB for missing messages. Hook-cached messages take priority over JSONL scanning.

**Scanner** (`scanner.ts`): Discovers projects and sessions from `~/.claude/projects/`. Scans subagent metadata from `subagents/` directories. 30s cache TTL for project discovery.

**Frontend** (`public/index.html`): Single-file vanilla HTML/CSS/JS SPA. Connects via EventSource to `/events`. Renders session cards grouped by project with status badges, subagent trees, token usage, and message previews. Light/dark theme support.

**Types** (`types.ts`): Core types — `SessionMeta`, `SessionView`, `DashboardState`, `JsonlLine`, `SubagentInfo`.

## Key patterns

- In-memory state maps: `workingSessions`, `permissionSessions`, `forcedIdleSessions` — tracked by sessionId
- Session cache uses mtime-based invalidation to skip re-parsing unchanged JSONL files
- PID file sync every 30s reads `~/.claude/sessions/{PID}.json` to recover/validate active sessions
- Platform-specific process detection: `/proc/{pid}/cmdline` on Linux, `ps` on macOS
