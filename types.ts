// Content block types for JSONL message content
export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | ContentBlock[];
  is_error?: boolean;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | { type: string; [key: string]: unknown };

// Raw JSONL line structure
export interface JsonlLine {
  type: "user" | "assistant" | "system" | "file-history-snapshot" | "progress";
  uuid: string;
  parentUuid: string | null;
  timestamp: string;       // ISO 8601
  sessionId: string;
  cwd: string;
  version?: string;
  message?: {
    role: string;
    content: string | ContentBlock[];
    model?: string;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  isSidechain?: boolean;
  isMeta?: boolean;
  userType?: string;
  entrypoint?: string;
  gitBranch?: string;
}

// Project — corresponds to a directory under ~/.claude/projects/
export interface Project {
  id: string;              // encoded-cwd (directory name)
  path: string;            // decoded real path
  displayName: string;     // last path segment
  sessionCount: number;    // number of .jsonl files
}

// Message preview for last user/assistant messages
export interface MessagePreview {
  role: "user" | "assistant";
  textPreview: string;     // truncated text
  timeCreated: number;     // ms timestamp
}

// Active session from ~/.claude/sessions/{PID}.json
export interface ActiveSession {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;       // ms timestamp
}

// Subagent info from subagents/*.meta.json
export interface SubagentInfo {
  agentType: string;
  description: string;
  status: "active" | "completed";
  completedAt: number | null;  // ms timestamp when agent became inactive
}

// Session metadata built from JSONL + filesystem
export interface SessionMeta {
  id: string;              // file name (UUID, no extension)
  projectId: string;       // project directory name
  cwd: string;             // from first user message cwd field
  startedAt: number;       // first message timestamp (ms)
  lastActivityAt: number;  // file mtime (ms)
  status: "ACTIVE" | "WAITING" | "RECENT" | "IDLE";
  title: string;           // first real user message content (100 char truncate)
  lastUserMessage: MessagePreview | null;
  lastAssistantMessage: MessagePreview | null;
  hasSubagents: boolean;   // {session-id}/subagents/ directory exists
  subagents: SubagentInfo[];  // parsed from subagents/*.meta.json
  version: string;         // CC version from JSONL version field
  inputTokens: number;     // total input tokens
  outputTokens: number;    // total output tokens
}

// Session view for the frontend (combines SessionMeta + extras)
export interface SessionView extends SessionMeta {
  projectDisplayName: string;
  projectPath: string;
}

// Full dashboard state sent over SSE
export interface DashboardState {
  projects: Project[];
  sessions: SessionView[];
  archivedSessions: SessionView[];
  archivedProjectIds: string[];
  timestamp: number;
}

// Session metadata cache entry
export interface SessionCacheEntry {
  meta: SessionMeta;
  mtime: number;           // cached file mtime (ms)
  hasToolUse: boolean;     // last assistant message has pending tool_use
}
