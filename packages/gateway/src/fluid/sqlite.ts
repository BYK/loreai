import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type {
  ICollection,
  IDb,
  IDbFactory,
} from "@fluidframework/server-services-core";
import { basename, dirname } from "node:path";
import { db, withTransaction } from "@loreai/core";

type JsonDocument = Record<string, unknown>;

const collectionProperties: Record<
  string,
  { indexes: string[]; range?: boolean; limit?: number }
> = {
  checkpoints: { indexes: ["tenantId", "documentId"] },
  content: {
    indexes: ["tenantId", "documentId", "sequenceNumber"],
    range: true,
    limit: 2000,
  },
  deltas: {
    indexes: ["tenantId", "documentId", "operation.sequenceNumber"],
    range: true,
    limit: 2000,
  },
  documents: { indexes: ["tenantId", "documentId"] },
  nodes: { indexes: ["_id"] },
  scribeDeltas: {
    indexes: ["tenantId", "documentId", "operation.sequenceNumber"],
    range: true,
    limit: 2000,
  },
};

function valueAt(document: JsonDocument, path: string): unknown {
  return path.split(".").reduce<unknown>((value, part) => {
    if (value === null || typeof value !== "object") return undefined;
    return (value as JsonDocument)[part];
  }, document);
}

function keyPart(value: unknown): string {
  const numeric = Number(value);
  return Number.isNaN(numeric) ? String(value) : String(numeric);
}

function indexedString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function indexedValues(value: JsonDocument, indexes: string[]): unknown[] {
  return indexes.map((index) => valueAt(value, index));
}

const fluidParticipantContext = new AsyncLocalStorage<string>();

/** Token key survives gateway restarts so connected participants can reconnect. */
export function fluidSpikeTokenSecret(): string {
  db().exec(
    "CREATE TABLE IF NOT EXISTS fluid_spike_secret (id INTEGER PRIMARY KEY CHECK (id = 1), secret TEXT NOT NULL)",
  );
  db()
    .query(
      "INSERT OR IGNORE INTO fluid_spike_secret (id, secret) VALUES (1, ?)",
    )
    .run(randomBytes(32).toString("base64url"));
  const row = db()
    .query("SELECT secret FROM fluid_spike_secret WHERE id = 1")
    .get() as { secret: string } | undefined;
  if (!row) throw new Error("Fluid spike token secret is unavailable");
  return row.secret;
}

export function withFluidParticipant<T>(
  participant: string,
  callback: () => T,
): T {
  return fluidParticipantContext.run(participant, callback);
}

export function grantFluidShare(documentId: string, participant: string): void {
  db()
    .query(
      "INSERT OR IGNORE INTO fluid_spike_shares(document_id, participant) VALUES (?, ?)",
    )
    .run(documentId, participant);
}

export function revokeFluidShare(
  documentId: string,
  participant: string,
): void {
  db()
    .query(
      "DELETE FROM fluid_spike_shares WHERE document_id = ? AND participant = ?",
    )
    .run(documentId, participant);
}

export function hasFluidShare(
  documentId: string,
  participant: string,
): boolean {
  return Boolean(
    db()
      .query(
        "SELECT 1 AS shared FROM fluid_spike_shares WHERE document_id = ? AND participant = ?",
      )
      .get(documentId, participant),
  );
}

export interface FluidAttribution {
  sequenceNumber: number;
  clientId: string;
  participant: string | null;
  operation: string;
}

export function recordFluidClient(
  documentId: string,
  clientId: string,
  participant: string,
): void {
  db()
    .query(
      `INSERT OR REPLACE INTO fluid_spike_clients(document_id, client_id, participant)
       VALUES (?, ?, ?)`,
    )
    .run(documentId, clientId, participant);
  db()
    .query(
      `UPDATE fluid_spike_attribution SET participant = ?
       WHERE document_id = ? AND client_id = ?`,
    )
    .run(participant, documentId, clientId);
}

export function fluidAttribution(documentId: string): FluidAttribution[] {
  return db()
    .query(
      `SELECT sequence_number AS sequenceNumber, client_id AS clientId,
              participant, operation
       FROM fluid_spike_attribution
       WHERE document_id = ? ORDER BY sequence_number`,
    )
    .all(documentId) as unknown as FluidAttribution[];
}

class SQLiteCollection<T extends JsonDocument> implements ICollection<T> {
  private readonly indexes: string[];
  private readonly range: boolean;
  private readonly limit?: number;

  constructor(private readonly name: string) {
    const properties = collectionProperties[name];
    if (!properties) throw new Error(`Collection ${name} not implemented.`);
    this.indexes = properties.indexes;
    this.range = properties.range === true;
    this.limit = properties.limit;
  }

  aggregate(): never {
    throw new Error("Method Not Implemented");
  }

  async find(query: JsonDocument = {}, _sort?: JsonDocument): Promise<T[]> {
    return this.findInternal(query);
  }

  async findAll(): Promise<T[]> {
    return this.readAll();
  }

  async findOne(query: JsonDocument): Promise<T | null> {
    return (await this.find(query))[0] ?? null;
  }

  async findOrCreate(
    query: JsonDocument,
    value: T,
  ): Promise<{ value: T; existing: boolean }> {
    const existing = await this.findOne(query);
    if (existing) return { value: existing, existing: true };
    return { value: await this.insertOne(value), existing: false };
  }

  async findAndUpdate(): Promise<{ value: T; existing: boolean }> {
    throw new Error("Method Not Implemented");
  }

  async update(filter: JsonDocument, set: JsonDocument): Promise<void> {
    const existing = await this.findOne(filter);
    if (!existing) throw new Error("Not found");
    await this.insertOne({ ...existing, ...set });
  }

  async updateMany(): Promise<void> {
    throw new Error("Method Not Implemented");
  }

  async upsert(filter: JsonDocument, set: JsonDocument): Promise<void> {
    const existing = await this.findOne(filter);
    await this.insertOne((existing ? { ...existing, ...set } : set) as T);
  }

  async insertOne(value: T): Promise<T> {
    const key = this.key(value);
    db()
      .query(
        `INSERT INTO fluid_spike_records(
           collection, tenant_id, document_id, seq, item_key, document
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(collection, item_key) DO UPDATE SET
           tenant_id = excluded.tenant_id,
           document_id = excluded.document_id,
           seq = excluded.seq,
           document = excluded.document`,
      )
      .run(
        this.name,
        this.columnValue(value, "tenantId"),
        this.columnValue(value, "documentId"),
        this.sequenceValue(value),
        key,
        JSON.stringify(value),
      );
    if (this.name === "documents") {
      const participant = fluidParticipantContext.getStore();
      const documentId = valueAt(value, "documentId");
      if (participant && typeof documentId === "string") {
        grantFluidShare(documentId, participant);
      }
    }
    this.recordOperationAttribution(value);
    return value;
  }

  async insertMany(values: T[]): Promise<void> {
    const insert = db().query(
      `INSERT INTO fluid_spike_records(
         collection, tenant_id, document_id, seq, item_key, document
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(collection, item_key) DO UPDATE SET
         tenant_id = excluded.tenant_id,
         document_id = excluded.document_id,
         seq = excluded.seq,
         document = excluded.document`,
    );
    withTransaction(() => {
      for (const value of values) {
        insert.run(
          this.name,
          this.columnValue(value, "tenantId"),
          this.columnValue(value, "documentId"),
          this.sequenceValue(value),
          this.key(value),
          JSON.stringify(value),
        );
        if (this.name === "documents") {
          const participant = fluidParticipantContext.getStore();
          const documentId = valueAt(value, "documentId");
          if (participant && typeof documentId === "string") {
            grantFluidShare(documentId, participant);
          }
        }
        this.recordOperationAttribution(value);
      }
    });
  }

  async deleteOne(filter: JsonDocument): Promise<boolean> {
    const value = await this.findOne(filter);
    if (!value) return false;
    db()
      .query(
        "DELETE FROM fluid_spike_records WHERE collection = ? AND item_key = ?",
      )
      .run(this.name, this.key(value));
    return true;
  }

  async deleteMany(): Promise<never> {
    throw new Error("Method not implemented.");
  }

  async distinct(): Promise<never> {
    throw new Error("Method Not Implemented");
  }

  async createIndex(): Promise<void> {}

  private key(value: JsonDocument): string {
    const parts = indexedValues(value, this.indexes);
    if (parts.some((part) => part === undefined || part === null)) {
      throw new Error(
        `Missing primary key for ${this.name}: ${this.indexes.join(", ")}`,
      );
    }
    return parts.map(keyPart).join("!");
  }

  private columnValue(value: JsonDocument, index: string): string | null {
    if (!this.indexes.includes(index)) return null;
    return indexedString(valueAt(value, index));
  }

  private sequenceValue(value: JsonDocument): number | null {
    if (!this.range) return null;
    const sequenceIndex = this.indexes.at(-1);
    if (!sequenceIndex)
      throw new Error(`Missing sequence index for ${this.name}`);
    const sequence = valueAt(value, sequenceIndex);
    if (typeof sequence !== "number" || !Number.isFinite(sequence)) {
      throw new Error(`Missing numeric sequence for ${this.name}`);
    }
    return sequence;
  }

  private recordOperationAttribution(value: T): void {
    if (this.name !== "deltas") return;
    const operation = valueAt(value, "operation");
    const documentId = valueAt(value, "documentId");
    const clientId =
      operation !== null && typeof operation === "object"
        ? (operation as JsonDocument).clientId
        : undefined;
    const sequenceNumber = this.sequenceValue(value);
    if (
      typeof documentId !== "string" ||
      typeof clientId !== "string" ||
      sequenceNumber === null
    ) {
      return;
    }
    db()
      .query(
        `INSERT OR REPLACE INTO fluid_spike_attribution(
           document_id, sequence_number, client_id, participant, operation
         )
         VALUES (
           ?, ?, ?, (SELECT participant FROM fluid_spike_clients
                      WHERE document_id = ? AND client_id = ?), ?
         )`,
      )
      .run(
        documentId,
        sequenceNumber,
        clientId,
        documentId,
        clientId,
        JSON.stringify(operation),
      );
  }

  private async readAll(): Promise<T[]> {
    const rows = db()
      .query(
        `SELECT document FROM fluid_spike_records
         WHERE collection = ?
         ORDER BY tenant_id, document_id, seq, item_key`,
      )
      .all(this.name) as Array<{ document: string }>;
    return rows.map(({ document }) => JSON.parse(document) as T);
  }

  private async findInternal(query: JsonDocument): Promise<T[]> {
    const indexedFields = this.range ? this.indexes.slice(0, -1) : this.indexes;
    const queryValues: unknown[] = [];
    let missingPrefixField = false;
    for (const index of indexedFields) {
      const value = query[index];
      if (value === undefined) {
        missingPrefixField = true;
      } else {
        if (missingPrefixField) return [];
        queryValues.push(value);
      }
    }
    if (!this.range && queryValues.length !== indexedFields.length) return [];
    if (queryValues.length === 0) return [];
    const where = ["collection = ?"];
    const parameters: Array<string | number> = [this.name];
    for (const [position, value] of queryValues.entries()) {
      const column =
        indexedFields[position] === "_id"
          ? "item_key"
          : position === 0
            ? "tenant_id"
            : "document_id";
      where.push(`${column} = ?`);
      parameters.push(String(value));
    }
    let sql = `SELECT document FROM fluid_spike_records WHERE ${where.join(" AND ")}`;
    if (this.range) {
      const rangeKey = this.indexes.at(-1);
      if (!rangeKey) throw new Error(`Missing sequence index for ${this.name}`);
      const range = query[rangeKey] as
        | { $gt?: number; $lt?: number }
        | undefined;
      const limit = this.limit ?? 2000;
      const from =
        range?.$gt !== undefined && range.$gt > 0 ? Number(range.$gt) + 1 : 1;
      const to =
        range?.$lt !== undefined && range.$lt > 0
          ? Number(range.$lt) - 1
          : from + limit - 1;
      sql += " AND seq >= ? AND seq <= ? ORDER BY seq LIMIT ?";
      parameters.push(from, to, limit);
    }
    const rows = db()
      .query(sql)
      .all(...parameters) as Array<{ document: string }>;
    return rows.map(({ document }) => JSON.parse(document) as T);
  }
}

class SQLiteDb extends EventEmitter implements IDb {
  private readonly collections = new Map<
    string,
    SQLiteCollection<JsonDocument>
  >();

  async close(): Promise<void> {}

  collection<T extends { [key: string]: unknown }>(
    name: string,
  ): ICollection<T> {
    let collection = this.collections.get(name);
    if (!collection) {
      collection = new SQLiteCollection(name);
      this.collections.set(name, collection);
    }
    return collection as ICollection<T>;
  }

  async dropCollection(_name: string): Promise<boolean> {
    throw new Error("Method Not Implemented");
  }
}

const sqliteDb = new SQLiteDb();

export class SQLiteDbFactory implements IDbFactory {
  async connect(): Promise<IDb> {
    return sqliteDb;
  }
}

export function initializeFluidTables(): void {
  db().exec(`
    CREATE TABLE IF NOT EXISTS fluid_spike_records (
      collection TEXT NOT NULL,
      tenant_id TEXT,
      document_id TEXT,
      seq INTEGER,
      item_key TEXT NOT NULL,
      document TEXT NOT NULL,
      PRIMARY KEY (collection, item_key)
    );
    CREATE TABLE IF NOT EXISTS fluid_spike_shares (
      document_id TEXT NOT NULL,
      participant TEXT NOT NULL,
      PRIMARY KEY (document_id, participant)
    );
    CREATE TABLE IF NOT EXISTS fluid_spike_clients (
      document_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      participant TEXT NOT NULL,
      PRIMARY KEY (document_id, client_id)
    );
    CREATE TABLE IF NOT EXISTS fluid_spike_attribution (
      document_id TEXT NOT NULL,
      sequence_number INTEGER NOT NULL,
      client_id TEXT NOT NULL,
      participant TEXT,
      operation TEXT NOT NULL,
      PRIMARY KEY (document_id, sequence_number)
    );
    CREATE TABLE IF NOT EXISTS fluid_spike_files (
      path TEXT PRIMARY KEY,
      parent_path TEXT,
      basename TEXT,
      kind TEXT NOT NULL,
      contents BLOB,
      link_target TEXT,
      mode INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL
    );
  `);
  const recordColumns = new Set(
    (
      db().query("PRAGMA table_info(fluid_spike_records)").all() as Array<{
        name: string;
      }>
    ).map(({ name }) => name),
  );
  const legacyRecords =
    !recordColumns.has("tenant_id") ||
    !recordColumns.has("document_id") ||
    !recordColumns.has("seq");
  for (const [column, type] of [
    ["tenant_id", "TEXT"],
    ["document_id", "TEXT"],
    ["seq", "INTEGER"],
  ]) {
    if (!recordColumns.has(column)) {
      db().exec(`ALTER TABLE fluid_spike_records ADD COLUMN ${column} ${type}`);
    }
  }
  if (legacyRecords) {
    const rows = db()
      .query("SELECT collection, item_key, document FROM fluid_spike_records")
      .all() as Array<{
      collection: string;
      item_key: string;
      document: string;
    }>;
    withTransaction(() => {
      const update = db().query(
        `UPDATE fluid_spike_records
         SET tenant_id = ?, document_id = ?, seq = ?
         WHERE collection = ? AND item_key = ?`,
      );
      for (const row of rows) {
        const document = JSON.parse(row.document) as JsonDocument;
        const indexes = collectionProperties[row.collection]?.indexes ?? [];
        const tenant = indexes.includes("tenantId")
          ? valueAt(document, "tenantId")
          : null;
        const documentId = indexes.includes("documentId")
          ? valueAt(document, "documentId")
          : null;
        const sequenceIndex = indexes.at(-1);
        const sequence =
          collectionProperties[row.collection]?.range && sequenceIndex
            ? valueAt(document, sequenceIndex)
            : null;
        update.run(
          indexedString(tenant),
          indexedString(documentId),
          typeof sequence === "number" ? sequence : null,
          row.collection,
          row.item_key,
        );
      }
    });
  }
  db().exec(`
    CREATE INDEX IF NOT EXISTS idx_fluid_spike_records_lookup
      ON fluid_spike_records(collection, tenant_id, document_id, seq);
  `);
  const fileColumns = new Set(
    (
      db().query("PRAGMA table_info(fluid_spike_files)").all() as Array<{
        name: string;
      }>
    ).map(({ name }) => name),
  );
  const legacyFiles =
    !fileColumns.has("parent_path") || !fileColumns.has("basename");
  if (!fileColumns.has("parent_path")) {
    db().exec("ALTER TABLE fluid_spike_files ADD COLUMN parent_path TEXT");
  }
  if (!fileColumns.has("basename")) {
    db().exec("ALTER TABLE fluid_spike_files ADD COLUMN basename TEXT");
  }
  if (legacyFiles) {
    const rows = db()
      .query("SELECT path FROM fluid_spike_files")
      .all() as Array<{ path: string }>;
    withTransaction(() => {
      const update = db().query(
        "UPDATE fluid_spike_files SET parent_path = ?, basename = ? WHERE path = ?",
      );
      for (const row of rows) {
        update.run(dirname(row.path), basename(row.path), row.path);
      }
    });
  }
  db().exec(
    "CREATE INDEX IF NOT EXISTS idx_fluid_spike_files_parent_path ON fluid_spike_files(parent_path)",
  );
}
