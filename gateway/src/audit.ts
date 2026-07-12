import { createHmac } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { GatewayAuditEvent } from "./gateway.js";

interface AuditRow {
  occurred_at: string;
  run_id: string;
  node_id: string;
  grant_id: string;
  action: string;
  target_ref_hash: string | null;
}

export interface SqliteGatewayAuditOptions {
  path: string;
  hashKey: Buffer;
}

export interface StoredGatewayAuditEvent {
  occurredAt: string;
  runId: string;
  nodeId: string;
  grantId: string;
  action: string;
  targetRefHash?: string;
}

export class SqliteGatewayAudit {
  readonly #database: DatabaseSync;
  readonly #hashKey: Buffer;

  constructor(options: SqliteGatewayAuditOptions) {
    if (options.hashKey.length < 32) throw new Error("audit hash key must contain at least 32 bytes");
    mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(options.path);
    chmodSync(options.path, 0o600);
    this.#hashKey = Buffer.from(options.hashKey);
    this.#database.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = FULL;
      PRAGMA trusted_schema = OFF;
      CREATE TABLE IF NOT EXISTS gateway_audit (
        event_id INTEGER PRIMARY KEY,
        occurred_at TEXT NOT NULL,
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        grant_id TEXT NOT NULL,
        action TEXT NOT NULL,
        target_ref_hash TEXT
      ) STRICT;
    `);
  }

  record(event: GatewayAuditEvent): void {
    const targetHash = event.targetRef
      ? createHmac("sha256", this.#hashKey).update(event.targetRef).digest("base64url")
      : null;
    this.#database
      .prepare(
        "INSERT INTO gateway_audit(occurred_at, run_id, node_id, grant_id, action, target_ref_hash) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(event.occurredAt, event.runId, event.nodeId, event.grantId, event.action, targetHash);
  }

  recent(limit = 100): StoredGatewayAuditEvent[] {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1_000) throw new Error("audit limit is invalid");
    const rows = this.#database
      .prepare(
        "SELECT occurred_at, run_id, node_id, grant_id, action, target_ref_hash FROM gateway_audit ORDER BY event_id DESC LIMIT ?",
      )
      .all(limit) as unknown as AuditRow[];
    return rows.map((row) => ({
      occurredAt: row.occurred_at,
      runId: row.run_id,
      nodeId: row.node_id,
      grantId: row.grant_id,
      action: row.action,
      ...(row.target_ref_hash ? { targetRefHash: row.target_ref_hash } : {}),
    }));
  }

  close(): void {
    this.#database.close();
    this.#hashKey.fill(0);
  }
}
