import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const IDEMPOTENCY_KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/;

export interface MailCircuitLimits {
  perMinute: number;
  perHour: number;
  perDay: number;
  maxRecipients: number;
}

export interface MailCircuitBreakerOptions {
  limits?: MailCircuitLimits;
  now?: () => Date;
  stateStore?: MailCircuitStateStore;
}

interface SendEvent {
  idempotencyKey: string;
  occurredAt: number;
}

interface IdempotencyEntry {
  status: "pending" | "complete";
  result?: Record<string, unknown>;
  replyToRef?: string;
}

export interface MailCircuitState {
  events: Array<{ grantId: string; idempotencyKey: string; occurredAt: number }>;
  frozenGrantIds: string[];
  idempotency: Array<{ key: string; entry: IdempotencyEntry }>;
  repliedMessages: Array<{ grantId: string; messageRefs: string[] }>;
}

export interface MailCircuitStateStore {
  load(): MailCircuitState | undefined;
  save(state: MailCircuitState): void;
}

function emptyState(): MailCircuitState {
  return { events: [], frozenGrantIds: [], idempotency: [], repliedMessages: [] };
}

function parseState(value: string): MailCircuitState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("mail circuit state is corrupt");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("mail circuit state is corrupt");
  }
  const state = parsed as Partial<MailCircuitState>;
  if (
    !Array.isArray(state.events) ||
    !Array.isArray(state.frozenGrantIds) ||
    !Array.isArray(state.idempotency) ||
    !Array.isArray(state.repliedMessages)
  ) {
    throw new Error("mail circuit state is corrupt");
  }
  return state as MailCircuitState;
}

export class SqliteMailCircuitStateStore implements MailCircuitStateStore {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.#database.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;");
    this.#database.exec(
      "CREATE TABLE IF NOT EXISTS circuit_state (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), state_json TEXT NOT NULL)",
    );
  }

  load(): MailCircuitState | undefined {
    const row = this.#database.prepare("SELECT state_json FROM circuit_state WHERE singleton = 1").get() as
      | { state_json: string }
      | undefined;
    return row ? parseState(row.state_json) : undefined;
  }

  save(state: MailCircuitState): void {
    this.#database
      .prepare(
        "INSERT INTO circuit_state(singleton, state_json) VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET state_json = excluded.state_json",
      )
      .run(JSON.stringify(state));
  }

  close(): void {
    this.#database.close();
  }
}

interface ReserveInput {
  grantId: string;
  idempotencyKey: string;
  recipientCount: number;
  replyToRef?: string;
  automaticResponse?: boolean;
  providerLimits?: Partial<MailCircuitLimits>;
}

export type Reservation = { status: "reserved" } | { status: "duplicate"; result: Record<string, unknown> };

const DEFAULT_LIMITS: MailCircuitLimits = {
  perMinute: 10,
  perHour: 50,
  perDay: 200,
  maxRecipients: 25,
};

function assertPositiveInteger(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}

export class MailCircuitBreaker {
  readonly #events = new Map<string, SendEvent[]>();
  readonly #frozenGrants = new Set<string>();
  readonly #idempotency = new Map<string, IdempotencyEntry>();
  readonly #limits: MailCircuitLimits;
  readonly #now: () => Date;
  readonly #repliedMessages = new Map<string, Set<string>>();
  readonly #stateStore: MailCircuitStateStore | undefined;

  constructor(options: MailCircuitBreakerOptions = {}) {
    this.#limits = options.limits ?? DEFAULT_LIMITS;
    this.#now = options.now ?? (() => new Date());
    this.#stateStore = options.stateStore;
    assertPositiveInteger("perMinute", this.#limits.perMinute);
    assertPositiveInteger("perHour", this.#limits.perHour);
    assertPositiveInteger("perDay", this.#limits.perDay);
    assertPositiveInteger("maxRecipients", this.#limits.maxRecipients);
    this.#restore(this.#stateStore?.load() ?? emptyState());
  }

  reserve(input: ReserveInput): Reservation {
    if (!IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey)) {
      throw new Error("idempotency key is invalid");
    }
    const entryKey = `${input.grantId}:${input.idempotencyKey}`;
    const existing = this.#idempotency.get(entryKey);
    if (existing?.status === "complete" && existing.result) {
      return { status: "duplicate", result: existing.result };
    }
    if (existing) {
      throw new Error("outbound operation with this idempotency key is already in progress");
    }
    if (this.#frozenGrants.has(input.grantId)) {
      throw new Error("mail circuit breaker is open for this mailbox grant");
    }
    if (input.automaticResponse) {
      throw new Error("mail circuit breaker refused an automatic response target");
    }
    const repliedMessages = this.#repliedMessages.get(input.grantId) ?? new Set<string>();
    if (input.replyToRef && repliedMessages.has(input.replyToRef)) {
      throw new Error("mail circuit breaker already replied to this inbound message");
    }
    if (!Number.isSafeInteger(input.recipientCount) || input.recipientCount <= 0) {
      throw new Error("at least one recipient is required");
    }
    const limits = this.#effectiveLimits(input.providerLimits);
    if (input.recipientCount > limits.maxRecipients) {
      throw new Error("mail circuit breaker rejected the recipient limit");
    }

    const now = this.#now().getTime();
    const dayAgo = now - 24 * 60 * 60 * 1_000;
    const events = (this.#events.get(input.grantId) ?? []).filter((event) => event.occurredAt > dayAgo);
    const minuteCount = events.filter((event) => event.occurredAt > now - 60_000).length;
    const hourCount = events.filter((event) => event.occurredAt > now - 60 * 60 * 1_000).length;
    if (
      minuteCount >= limits.perMinute ||
      hourCount >= limits.perHour ||
      events.length >= limits.perDay
    ) {
      this.#frozenGrants.add(input.grantId);
      this.#persist();
      throw new Error("mail circuit breaker opened after the outbound rate limit was reached");
    }

    events.push({ idempotencyKey: input.idempotencyKey, occurredAt: now });
    this.#events.set(input.grantId, events);
    this.#idempotency.set(entryKey, {
      status: "pending",
      ...(input.replyToRef ? { replyToRef: input.replyToRef } : {}),
    });
    if (input.replyToRef) {
      repliedMessages.add(input.replyToRef);
      this.#repliedMessages.set(input.grantId, repliedMessages);
    }
    this.#persist();
    return { status: "reserved" };
  }

  commit(grantId: string, idempotencyKey: string, result: Record<string, unknown>): void {
    const entryKey = `${grantId}:${idempotencyKey}`;
    const pendingEntry = this.#idempotency.get(entryKey);
    if (pendingEntry?.status !== "pending") {
      throw new Error("outbound reservation was not found");
    }
    this.#idempotency.set(entryKey, {
      status: "complete",
      result: structuredClone(result),
      ...(pendingEntry.replyToRef ? { replyToRef: pendingEntry.replyToRef } : {}),
    });
    this.#persist();
  }

  abort(grantId: string, idempotencyKey: string): void {
    const entryKey = `${grantId}:${idempotencyKey}`;
    const entry = this.#idempotency.get(entryKey);
    if (entry?.status !== "pending") {
      return;
    }
    this.#idempotency.delete(entryKey);
    if (entry.replyToRef) {
      this.#repliedMessages.get(grantId)?.delete(entry.replyToRef);
    }
    const events = this.#events.get(grantId) ?? [];
    this.#events.set(
      grantId,
      events.filter((event) => event.idempotencyKey !== idempotencyKey),
    );
    this.#persist();
  }

  reset(grantId: string): void {
    this.#frozenGrants.delete(grantId);
    this.#persist();
  }

  #persist(): void {
    if (!this.#stateStore) return;
    this.#stateStore.save({
      events: [...this.#events.entries()].flatMap(([grantId, events]) =>
        events.map((event) => ({ grantId, idempotencyKey: event.idempotencyKey, occurredAt: event.occurredAt })),
      ),
      frozenGrantIds: [...this.#frozenGrants],
      idempotency: [...this.#idempotency.entries()].map(([key, entry]) => ({ key, entry: structuredClone(entry) })),
      repliedMessages: [...this.#repliedMessages.entries()].map(([grantId, refs]) => ({
        grantId,
        messageRefs: [...refs],
      })),
    });
  }

  #effectiveLimits(providerLimits: Partial<MailCircuitLimits> | undefined): MailCircuitLimits {
    if (!providerLimits) return this.#limits;
    for (const [name, value] of Object.entries(providerLimits)) {
      if (value !== undefined) assertPositiveInteger(`provider ${name}`, value);
    }
    return {
      perMinute: Math.min(this.#limits.perMinute, providerLimits.perMinute ?? this.#limits.perMinute),
      perHour: Math.min(this.#limits.perHour, providerLimits.perHour ?? this.#limits.perHour),
      perDay: Math.min(this.#limits.perDay, providerLimits.perDay ?? this.#limits.perDay),
      maxRecipients: Math.min(this.#limits.maxRecipients, providerLimits.maxRecipients ?? this.#limits.maxRecipients),
    };
  }

  #restore(state: MailCircuitState): void {
    for (const event of state.events) {
      const events = this.#events.get(event.grantId) ?? [];
      events.push({ idempotencyKey: event.idempotencyKey, occurredAt: event.occurredAt });
      this.#events.set(event.grantId, events);
    }
    for (const grantId of state.frozenGrantIds) this.#frozenGrants.add(grantId);
    for (const item of state.idempotency) this.#idempotency.set(item.key, structuredClone(item.entry));
    for (const item of state.repliedMessages) {
      this.#repliedMessages.set(item.grantId, new Set(item.messageRefs));
    }
  }
}
