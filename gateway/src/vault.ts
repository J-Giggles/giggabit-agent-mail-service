import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const CIPHER = "aes-256-gcm";
const IV_BYTES = 12;
const MASTER_KEY_BYTES = 32;
const VAULT_VERSION = 1;
const GRANT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type MailboxSecret = Record<string, JsonValue>;

export interface CredentialVaultOptions {
  databasePath: string;
  masterKey: Buffer;
  now?: () => Date;
}

export interface MailboxGrantInput {
  grantId: string;
  label: string;
  provider: string;
  secret: MailboxSecret;
}

export interface MailboxGrantSummary {
  grantId: string;
  label: string;
  provider: string;
  createdAt: string;
  updatedAt: string;
}

interface VaultRow {
  grant_id: string;
  label: string;
  provider: string;
  ciphertext: Uint8Array;
  iv: Uint8Array;
  auth_tag: Uint8Array;
  created_at: string;
  updated_at: string;
}

function assertNonEmpty(label: string, value: string): void {
  if (!value.trim()) {
    throw new Error(`${label} is required`);
  }
}

function aadFor(grantId: string, provider: string): Buffer {
  // This is a persisted cryptographic protocol label, not a product name. It
  // must remain stable so grants encrypted before the product rename decrypt.
  return Buffer.from(`giggabit-agent-mail-service-vault:${VAULT_VERSION}:${grantId}:${provider}`, "utf8");
}

function rowToSummary(row: Omit<VaultRow, "ciphertext" | "iv" | "auth_tag">): MailboxGrantSummary {
  return {
    grantId: row.grant_id,
    label: row.label,
    provider: row.provider,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class CredentialVault {
  readonly #database: DatabaseSync;
  readonly #masterKey: Buffer;
  readonly #now: () => Date;

  constructor(options: CredentialVaultOptions) {
    if (options.masterKey.length !== MASTER_KEY_BYTES) {
      throw new Error("credential vault master key must contain exactly 32 bytes");
    }
    mkdirSync(dirname(options.databasePath), { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(options.databasePath);
    chmodSync(options.databasePath, 0o600);
    this.#masterKey = Buffer.from(options.masterKey);
    this.#now = options.now ?? (() => new Date());
    this.#database.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS mailbox_grants (
        grant_id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        provider TEXT NOT NULL,
        ciphertext BLOB NOT NULL,
        iv BLOB NOT NULL,
        auth_tag BLOB NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `);
  }

  put(input: MailboxGrantInput): void {
    if (!GRANT_ID_PATTERN.test(input.grantId)) {
      throw new Error("grantId is invalid");
    }
    assertNonEmpty("label", input.label);
    assertNonEmpty("provider", input.provider);
    const plaintext = Buffer.from(JSON.stringify(input.secret), "utf8");
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(CIPHER, this.#masterKey, iv);
    cipher.setAAD(aadFor(input.grantId, input.provider));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    plaintext.fill(0);
    const now = this.#now().toISOString();

    this.#database
      .prepare(`
        INSERT INTO mailbox_grants (
          grant_id, label, provider, ciphertext, iv, auth_tag, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(grant_id) DO UPDATE SET
          label = excluded.label,
          provider = excluded.provider,
          ciphertext = excluded.ciphertext,
          iv = excluded.iv,
          auth_tag = excluded.auth_tag,
          updated_at = excluded.updated_at
      `)
      .run(input.grantId, input.label, input.provider, ciphertext, iv, authTag, now, now);
  }

  get(grantId: string): MailboxSecret | null {
    const row = this.#database
      .prepare("SELECT * FROM mailbox_grants WHERE grant_id = ?")
      .get(grantId) as VaultRow | undefined;
    if (!row) {
      return null;
    }
    try {
      const decipher = createDecipheriv(CIPHER, this.#masterKey, Buffer.from(row.iv));
      decipher.setAAD(aadFor(row.grant_id, row.provider));
      decipher.setAuthTag(Buffer.from(row.auth_tag));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(row.ciphertext)), decipher.final()]);
      try {
        const value: unknown = JSON.parse(plaintext.toString("utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new Error("credential vault record is invalid");
        }
        return value as MailboxSecret;
      } finally {
        plaintext.fill(0);
      }
    } catch {
      throw new Error("credential vault record could not be decrypted");
    }
  }

  list(): MailboxGrantSummary[] {
    const rows = this.#database
      .prepare(`
        SELECT grant_id, label, provider, created_at, updated_at
        FROM mailbox_grants
        ORDER BY grant_id
      `)
      .all() as Array<Omit<VaultRow, "ciphertext" | "iv" | "auth_tag">>;
    return rows.map(rowToSummary);
  }

  revoke(grantId: string): boolean {
    const result = this.#database.prepare("DELETE FROM mailbox_grants WHERE grant_id = ?").run(grantId);
    return result.changes > 0;
  }

  close(): void {
    this.#database.close();
    this.#masterKey.fill(0);
  }
}
