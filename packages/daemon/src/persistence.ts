import Database from "better-sqlite3";
import type { AgentEvent } from "@bullpen/core";

/** Append-only event log. State is derived; events are the record. */
export class EventLog {
  private db: Database.Database;
  private insertStmt: Database.Statement;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        provider TEXT NOT NULL,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        type TEXT NOT NULL,
        summary TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
      CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent_id, ts);
    `);
    this.insertStmt = this.db.prepare(
      `INSERT OR IGNORE INTO events (id, ts, provider, session_id, agent_id, type, summary, data)
       VALUES (@id, @ts, @provider, @sessionId, @agentId, @type, @summary, @data)`,
    );
  }

  append(event: AgentEvent): void {
    this.insertStmt.run({ ...event, data: JSON.stringify(event.data) });
  }

  recent(limit = 200): AgentEvent[] {
    const rows = this.db
      .prepare(
        `SELECT id, ts, provider, session_id as sessionId, agent_id as agentId, type, summary, data
         FROM events ORDER BY ts DESC LIMIT ?`,
      )
      .all(limit) as Array<Omit<AgentEvent, "data"> & { data: string }>;
    return rows.map((r) => ({ ...r, data: JSON.parse(r.data) as Record<string, unknown> }));
  }

  close(): void {
    this.db.close();
  }
}
