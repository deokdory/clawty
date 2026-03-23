import type { JsonlLine, MessagePreview, TextBlock } from "./types";

const DEFAULT_HEAD_BYTES = 8192;
const DEFAULT_TAIL_BYTES = 32768;

export function parseJsonlLine(line: string): JsonlLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as JsonlLine;
  } catch {
    return null;
  }
}

export async function readJsonlHead(filePath: string, maxBytes = DEFAULT_HEAD_BYTES): Promise<JsonlLine[]> {
  try {
    const file = Bun.file(filePath);
    const size = file.size;
    if (size === 0) return [];
    const sliced = file.slice(0, Math.min(size, maxBytes));
    const text = await sliced.text();
    const lines = text.split("\n");
    const result: JsonlLine[] = [];
    for (const line of lines) {
      const parsed = parseJsonlLine(line);
      if (parsed) result.push(parsed);
    }
    return result;
  } catch {
    return [];
  }
}

export async function readJsonlTail(filePath: string, maxBytes = DEFAULT_TAIL_BYTES): Promise<JsonlLine[]> {
  try {
    const file = Bun.file(filePath);
    const size = file.size;
    if (size === 0) return [];
    const sliced = file.slice(Math.max(0, size - maxBytes));
    const text = await sliced.text();
    const lines = text.split("\n");
    const result: JsonlLine[] = [];
    for (const line of lines) {
      const parsed = parseJsonlLine(line);
      if (parsed) result.push(parsed);
    }
    return result;
  } catch {
    return [];
  }
}

function extractTextFromContent(content: string | Array<{ type: string; [key: string]: unknown }>): string {
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "text")
    .map((b) => (b as TextBlock).text)
    .join("");
}

function isRealUserMessage(line: JsonlLine): boolean {
  if (line.type !== "user") return false;
  if (line.isMeta === true) return false;
  if (!line.message?.content) return false;
  const text = extractTextFromContent(line.message.content);
  if (text.startsWith("<local-command-caveat>")) return false;
  if (text.startsWith("<system-reminder>")) return false;
  return true;
}

export async function extractCustomTitle(filePath: string): Promise<string> {
  // custom-title records are small but can be buried under large progress entries.
  // Scan from end in 64KB chunks until found or 512KB scanned.
  try {
    const file = Bun.file(filePath);
    const size = file.size;
    if (size === 0) return "";

    const chunkSize = 65536;
    const maxScan = 524288;
    let offset = Math.max(0, size - chunkSize);

    while (size - offset <= maxScan && offset >= 0) {
      const text = await file.slice(offset, Math.min(offset + chunkSize, size)).text();
      const lines = text.split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (line.includes('"custom-title"')) {
          try {
            const parsed = JSON.parse(line);
            if (parsed.type === "custom-title" && parsed.customTitle) {
              return parsed.customTitle;
            }
          } catch { /* skip */ }
        }
      }
      if (offset === 0) break;
      offset = Math.max(0, offset - chunkSize);
    }
  } catch { /* skip */ }
  return "";
}

export function extractTitle(lines: JsonlLine[]): string {
  for (const line of lines) {
    if (line.type === "file-history-snapshot" || line.type === "progress") continue;
    if (!isRealUserMessage(line)) continue;
    const text = extractTextFromContent(line.message!.content).replace(/<[^>]*>/g, "").trim();
    return text.slice(0, 100);
  }
  return "";
}

export function extractLastMessagesFromLines(lines: JsonlLine[]): {
  lastUserMessage: MessagePreview | null;
  lastAssistantMessage: MessagePreview | null;
} {
  let lastUserMessage: MessagePreview | null = null;
  let lastAssistantMessage: MessagePreview | null = null;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.isSidechain) continue;

    if (!lastAssistantMessage && line.type === "assistant" && line.message?.content) {
      const text = extractTextFromContent(line.message.content);
      if (text.trim()) {
        lastAssistantMessage = {
          role: "assistant",
          textPreview: text.slice(0, 200),
          timeCreated: new Date(line.timestamp).getTime(),
        };
      }
    }

    if (!lastUserMessage && isRealUserMessage(line)) {
      const text = extractTextFromContent(line.message!.content);
      if (text.trim()) {
        lastUserMessage = {
          role: "user",
          textPreview: text.slice(0, 200),
          timeCreated: new Date(line.timestamp).getTime(),
        };
      }
    }

    if (lastUserMessage && lastAssistantMessage) break;
  }

  return { lastUserMessage, lastAssistantMessage };
}

// Progressively scan from tail to find both last user and assistant messages.
// Starts with tailLines (already parsed), then expands chunk-by-chunk if user message is missing.
export async function extractLastMessages(filePath: string, tailLines: JsonlLine[]): Promise<{
  lastUserMessage: MessagePreview | null;
  lastAssistantMessage: MessagePreview | null;
}> {
  const result = extractLastMessagesFromLines(tailLines);
  if (result.lastUserMessage) return result;

  // Assistant found but no user message — scan backwards for user message only.
  try {
    const file = Bun.file(filePath);
    const size = file.size;
    const chunkSize = 65536; // 64KB chunks
    const maxScan = Math.min(size, 4 * 1024 * 1024); // up to 4MB or entire file
    let offset = Math.max(0, size - DEFAULT_TAIL_BYTES - chunkSize);

    while (size - offset <= maxScan && offset >= 0) {
      const text = await file.slice(offset, offset + chunkSize).text();
      for (const rawLine of text.split("\n").reverse()) {
        if (!rawLine.includes('"type":"user"') && !rawLine.includes('"type": "user"')) continue;
        const parsed = parseJsonlLine(rawLine);
        if (parsed && isRealUserMessage(parsed)) {
          const msgText = extractTextFromContent(parsed.message!.content);
          if (msgText.trim()) {
            return {
              lastUserMessage: {
                role: "user",
                textPreview: msgText.slice(0, 200),
                timeCreated: new Date(parsed.timestamp).getTime(),
              },
              lastAssistantMessage: result.lastAssistantMessage,
            };
          }
        }
      }
      if (offset === 0) break;
      offset = Math.max(0, offset - chunkSize);
    }
  } catch { /* skip */ }
  return result;
}

const WAITING_TOOLS = new Set(["AskUserQuestion"]);

export function hasTrailingToolUse(lines: JsonlLine[]): boolean {
  // Only flag as waiting when the pending tool_use is a user-interaction tool
  // (e.g., AskUserQuestion). Regular tools (Bash, Read, Edit) during execution
  // should not trigger WAITING.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.type === "file-history-snapshot" || line.type === "progress") continue;
    if (line.isSidechain) continue;

    if (line.type === "user" && line.message?.content) {
      const content = line.message.content;
      if (Array.isArray(content) && content.some((b) => b.type === "tool_result")) {
        return false;
      }
    }

    if (line.type === "assistant" && line.message?.content) {
      const content = line.message.content;
      if (!Array.isArray(content)) break;
      const pendingToolUse = content.find(
        (b) => b.type === "tool_use" && WAITING_TOOLS.has((b as { name?: string }).name ?? "")
      );
      return !!pendingToolUse;
    }
  }

  return false;
}

export async function extractTokenUsage(filePath: string): Promise<{ inputTokens: number; outputTokens: number }> {
  let inputTokens = 0;
  let outputTokens = 0;
  try {
    const file = Bun.file(filePath);
    if (file.size === 0) return { inputTokens, outputTokens };
    const text = await file.text();
    // Fast scan: only parse lines that contain "usage"
    for (const line of text.split("\n")) {
      if (!line.includes('"usage"')) continue;
      const parsed = parseJsonlLine(line);
      if (parsed?.message?.usage) {
        inputTokens += parsed.message.usage.input_tokens || 0;
        outputTokens += parsed.message.usage.output_tokens || 0;
      }
    }
  } catch { /* skip */ }
  return { inputTokens, outputTokens };
}

export function extractMeta(headLines: JsonlLine[]): {
  cwd: string;
  version: string;
  sessionId: string;
  startedAt: number;
} {
  let cwd = "";
  let version = "";
  let sessionId = "";
  let startedAt = 0;

  for (const line of headLines) {
    if (line.type === "file-history-snapshot" || line.type === "progress") continue;
    if (line.sessionId && !sessionId) sessionId = line.sessionId;
    if (line.cwd && !cwd) cwd = line.cwd;
    if (line.version && !version) version = line.version;
    if (line.timestamp && !startedAt) {
      const t = new Date(line.timestamp).getTime();
      if (!isNaN(t)) startedAt = t;
    }
    if (cwd && version && sessionId && startedAt) break;
  }

  return { cwd, version, sessionId, startedAt };
}
