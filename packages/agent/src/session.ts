import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import type { Message, TokenUsage } from "@timetickme/llm";

// ============================================================================
// Types
// ============================================================================

/** Session metadata stored as the first line of each JSONL file. */
export interface SessionMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turnCount: number;
}

/** Internal JSON representation of the meta line (first line). */
interface MetaLine {
  type: "meta";
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turnCount: number;
}

/** A single turn record appended as a line after the meta line. */
export interface TurnRecord {
  type: "turn";
  timestamp: string;
  userInput: string;
  messages: Message[];
  usage?: TokenUsage;
}

// ============================================================================
// SessionManager
// ============================================================================

export class SessionManager {
  private sessionsDir: string;

  constructor(sessionsDir?: string) {
    this.sessionsDir =
      sessionsDir ?? path.join(os.homedir(), ".deepcode", "sessions");
  }

  // ==========================================================================
  // Public API — Write
  // ==========================================================================

  /**
   * Create a new session file with the given first user input as the title.
   * Returns the session metadata.
   */
  async createSession(firstUserInput: string): Promise<SessionMeta> {
    await this._ensureDir();

    const id = this._generateSessionId();
    const now = new Date().toISOString();
    const title = firstUserInput.slice(0, 50);

    const metaLine: MetaLine = {
      type: "meta",
      id,
      title,
      createdAt: now,
      updatedAt: now,
      turnCount: 0,
    };

    const filePath = this._getFilePath(id);
    await fs.writeFile(filePath, JSON.stringify(metaLine) + "\n", "utf-8");

    return { id, title, createdAt: now, updatedAt: now, turnCount: 0 };
  }

  /**
   * Append a turn record to the session file and update the meta line
   * (updatedAt, turnCount).
   */
  async appendTurn(sessionId: string, record: TurnRecord): Promise<void> {
    const filePath = this._getFilePath(sessionId);
    const content = await fs.readFile(filePath, "utf-8");
    const lines = content.trim().split("\n");

    // Update the meta line
    const metaLine = JSON.parse(lines[0]) as MetaLine;
    metaLine.updatedAt = new Date().toISOString();
    metaLine.turnCount = (metaLine.turnCount ?? 0) + 1;

    // Rebuild the file: updated meta + existing turns + new turn
    const newContent =
      [
        JSON.stringify(metaLine),
        ...lines.slice(1),
        JSON.stringify(record),
      ].join("\n") + "\n";

    await fs.writeFile(filePath, newContent, "utf-8");
  }

  /**
   * Update the title in the meta line of a session file.
   */
  async updateTitle(sessionId: string, title: string): Promise<void> {
    const filePath = this._getFilePath(sessionId);
    const content = await fs.readFile(filePath, "utf-8");
    const lines = content.trim().split("\n");

    const metaLine = JSON.parse(lines[0]) as MetaLine;
    metaLine.title = title;

    const newContent =
      [JSON.stringify(metaLine), ...lines.slice(1)].join("\n") + "\n";

    await fs.writeFile(filePath, newContent, "utf-8");
  }

  // ==========================================================================
  // Public API — Read
  // ==========================================================================

  /**
   * List all sessions, sorted by updatedAt descending (most recent first).
   * Only reads the first line of each file — fast even with many sessions.
   */
  async listSessions(): Promise<SessionMeta[]> {
    await this._ensureDir();
    const files = await fs.readdir(this.sessionsDir);
    const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));

    const sessions: SessionMeta[] = [];
    for (const file of jsonlFiles) {
      const filePath = path.join(this.sessionsDir, file);
      try {
        const content = await fs.readFile(filePath, "utf-8");
        const firstLineEnd = content.indexOf("\n");
        const firstLine =
          firstLineEnd >= 0 ? content.slice(0, firstLineEnd) : content;
        const meta = JSON.parse(firstLine) as MetaLine;
        if (meta.type === "meta") {
          sessions.push({
            id: meta.id,
            title: meta.title,
            createdAt: meta.createdAt,
            updatedAt: meta.updatedAt,
            turnCount: meta.turnCount ?? 0,
          });
        }
      } catch {
        // Skip files that can't be read or parsed
      }
    }

    sessions.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
    return sessions;
  }

  /**
   * Load all messages from a session file.
   * Iterates every line, filters for type === "turn", and concatenates
   * their messages arrays into a single Message[] ready for the LLM.
   */
  async loadMessages(sessionId: string): Promise<Message[]> {
    const filePath = this._getFilePath(sessionId);
    const content = await fs.readFile(filePath, "utf-8");
    const lines = content.trim().split("\n");

    const allMessages: Message[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === "turn" && Array.isArray(parsed.messages)) {
          allMessages.push(...parsed.messages);
        }
      } catch {
        console.warn(
          `[SessionManager] Skipping malformed line in session ${sessionId}`,
        );
      }
    }

    return allMessages;
  }

  /**
   * Get metadata for a single session, or null if not found.
   */
  async getSessionMeta(sessionId: string): Promise<SessionMeta | null> {
    const filePath = this._getFilePath(sessionId);
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const firstLineEnd = content.indexOf("\n");
      const firstLine =
        firstLineEnd >= 0 ? content.slice(0, firstLineEnd) : content;
      const meta = JSON.parse(firstLine) as MetaLine;
      if (meta.type === "meta") {
        return {
          id: meta.id,
          title: meta.title,
          createdAt: meta.createdAt,
          updatedAt: meta.updatedAt,
          turnCount: meta.turnCount ?? 0,
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  // ==========================================================================
  // Private helpers
  // ==========================================================================

  private _getFilePath(sessionId: string): string {
    return path.join(this.sessionsDir, `${sessionId}.jsonl`);
  }

  private async _ensureDir(): Promise<void> {
    await fs.mkdir(this.sessionsDir, { recursive: true });
  }

  /**
   * Generate a unique session ID: {8-char hex}-{ISO datetime without separators}
   * Example: "a1b2c3d4-20260704T103000"
   */
  private _generateSessionId(): string {
    const hex = crypto.randomBytes(4).toString("hex");
    const dateStr = new Date()
      .toISOString()
      .replace(/-/g, "")
      .replace(/:/g, "")
      .replace(/\..+Z$/, "");
    return `${hex}-${dateStr}`;
  }
}
