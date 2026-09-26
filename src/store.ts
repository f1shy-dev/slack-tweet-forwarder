import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type StreamSource = "activity" | "mentions";
export type ObservationSource = "stream" | "backfill" | "refetch";

export type StoredEvent = {
  seq: number;
  source: StreamSource;
  receivedAt: string;
  line: string;
};

export type Observation = {
  seq: number;
  postId: string;
  source: ObservationSource;
  eventSeq: number | null;
  fetchedAt: string;
  post: Record<string, unknown>;
  includes: Record<string, unknown> | null;
};

export type Delivery = {
  eventSeq: number;
  outcome: string;
  decidedAt: string;
};

type ObservationRow = {
  seq: number;
  post_id: string;
  source: ObservationSource;
  event_seq: number | null;
  fetched_at: string;
  post: string;
  includes: string | null;
};

const schema = `
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  received_at TEXT NOT NULL,
  line TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS observations (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id TEXT NOT NULL,
  source TEXT NOT NULL,
  event_seq INTEGER REFERENCES events(seq),
  fetched_at TEXT NOT NULL,
  post TEXT NOT NULL,
  includes TEXT
);
CREATE INDEX IF NOT EXISTS observations_post ON observations(post_id, seq);
CREATE TABLE IF NOT EXISTS deliveries (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_seq INTEGER NOT NULL REFERENCES events(seq),
  post_id TEXT,
  outcome TEXT NOT NULL,
  decided_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deliveries_event ON deliveries(event_seq);
CREATE INDEX IF NOT EXISTS deliveries_post ON deliveries(post_id);
${["events", "observations", "deliveries"]
  .map(
    (table) => `
CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table}
BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;
CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table}
BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;`,
  )
  .join("\n")}
`;

function parseObject(value: string | null): Record<string, unknown> | null {
  if (value === null) {
    return null;
  }

  const parsed: unknown = JSON.parse(value);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

function observationFromRow(row: ObservationRow): Observation {
  return {
    seq: row.seq,
    postId: row.post_id,
    source: row.source,
    eventSeq: row.event_seq,
    fetchedAt: row.fetched_at,
    post: parseObject(row.post) ?? {},
    includes: parseObject(row.includes),
  };
}

export class PostStore {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.#db = new DatabaseSync(path);
    this.#db.exec(
      "PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;",
    );
    this.#db.exec(schema);
  }

  close(): void {
    this.#db.close();
  }

  appendEvent(source: StreamSource, line: string, receivedAt = new Date().toISOString()): number {
    const result = this.#db
      .prepare("INSERT INTO events (source, received_at, line) VALUES (?, ?, ?)")
      .run(source, receivedAt, line);
    return Number(result.lastInsertRowid);
  }

  appendObservation(
    postId: string,
    source: ObservationSource,
    post: Record<string, unknown>,
    includes: Record<string, unknown> | null,
    eventSeq: number | null = null,
    fetchedAt = new Date().toISOString(),
  ): number {
    const result = this.#db
      .prepare(
        "INSERT INTO observations (post_id, source, event_seq, fetched_at, post, includes) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        postId,
        source,
        eventSeq,
        fetchedAt,
        JSON.stringify(post),
        includes === null ? null : JSON.stringify(includes),
      );
    return Number(result.lastInsertRowid);
  }

  appendDelivery(
    eventSeq: number,
    postId: string | null,
    outcome: string,
    decidedAt = new Date().toISOString(),
  ): void {
    this.#db
      .prepare(
        "INSERT INTO deliveries (event_seq, post_id, outcome, decided_at) VALUES (?, ?, ?, ?)",
      )
      .run(eventSeq, postId, outcome, decidedAt);
  }

  forwardedThrough(): number {
    const row = this.#db.prepare("SELECT MAX(event_seq) AS seq FROM deliveries").get() as
      | { seq: number | null }
      | undefined;
    return row?.seq ?? 0;
  }

  eventsAfter(seq: number, limit = 100): Array<StoredEvent> {
    return (
      this.#db
        .prepare(
          "SELECT seq, source, received_at, line FROM events WHERE seq > ? ORDER BY seq LIMIT ?",
        )
        .all(seq, limit) as Array<{
        seq: number;
        source: StreamSource;
        received_at: string;
        line: string;
      }>
    ).map((row) => ({
      seq: row.seq,
      source: row.source,
      receivedAt: row.received_at,
      line: row.line,
    }));
  }

  eventsBetween(since: string, until: string): Array<StoredEvent> {
    return (
      this.#db
        .prepare(
          "SELECT seq, source, received_at, line FROM events WHERE received_at >= ? AND received_at < ? ORDER BY seq",
        )
        .all(since, until) as Array<{
        seq: number;
        source: StreamSource;
        received_at: string;
        line: string;
      }>
    ).map((row) => ({
      seq: row.seq,
      source: row.source,
      receivedAt: row.received_at,
      line: row.line,
    }));
  }

  hasObservation(postId: string, sources: ReadonlyArray<ObservationSource>): boolean {
    const row = this.#db
      .prepare(
        `SELECT 1 AS found FROM observations WHERE post_id = ? AND source IN (${sources.map(() => "?").join(", ")}) LIMIT 1`,
      )
      .get(postId, ...sources);
    return row !== undefined;
  }

  observations(postId: string): Array<Observation> {
    return (
      this.#db
        .prepare(
          "SELECT seq, post_id, source, event_seq, fetched_at, post, includes FROM observations WHERE post_id = ? ORDER BY seq",
        )
        .all(postId) as Array<ObservationRow>
    ).map(observationFromRow);
  }

  firstObservations(): Array<Observation> {
    return (
      this.#db
        .prepare(
          `SELECT o.seq, o.post_id, o.source, o.event_seq, o.fetched_at, o.post, o.includes
           FROM observations o
           JOIN (
             SELECT post_id, MIN(seq) AS seq FROM observations
             WHERE source IN ('stream', 'backfill') GROUP BY post_id
           ) f ON f.seq = o.seq
           ORDER BY o.seq`,
        )
        .all() as Array<ObservationRow>
    ).map(observationFromRow);
  }

  refetchDue(cutoff: string, limit: number): Array<string> {
    return (
      this.#db
        .prepare(
          `SELECT o.post_id AS post_id
           FROM observations o
           WHERE o.source IN ('stream', 'backfill')
             AND NOT EXISTS (
               SELECT 1 FROM json_each(o.post, '$.referenced_tweets') r
               WHERE json_extract(r.value, '$.type') = 'retweeted'
             )
             AND NOT EXISTS (
               SELECT 1 FROM observations r WHERE r.post_id = o.post_id AND r.source = 'refetch'
             )
           GROUP BY o.post_id
           HAVING MIN(o.fetched_at) <= ?
           ORDER BY MIN(o.seq)
           LIMIT ?`,
        )
        .all(cutoff, limit) as Array<{ post_id: string }>
    ).map((row) => row.post_id);
  }

  unhydratedEventPosts(
    receivedSince: string,
    limit: number,
  ): Array<{ postId: string; eventSeq: number }> {
    return (
      this.#db
        .prepare(
          `SELECT post_id, MIN(seq) AS event_seq FROM (
             SELECT seq, CASE source
               WHEN 'activity' THEN json_extract(line, '$.data.payload.id')
               ELSE json_extract(line, '$.data.id')
             END AS post_id
             FROM events WHERE received_at >= ? AND json_valid(line)
           ) e
           WHERE post_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM observations o WHERE o.post_id = e.post_id)
           GROUP BY post_id
           ORDER BY event_seq
           LIMIT ?`,
        )
        .all(receivedSince, limit) as Array<{ post_id: string | number; event_seq: number }>
    ).map((row) => ({ postId: String(row.post_id), eventSeq: row.event_seq }));
  }

  firstPostedAt(postId: string): string | null {
    const row = this.#db
      .prepare(
        "SELECT MIN(decided_at) AS at FROM deliveries WHERE post_id = ? AND outcome = 'posted'",
      )
      .get(postId) as { at: string | null } | undefined;
    return row?.at ?? null;
  }

  counts(): Record<string, number> {
    const count = (sql: string) => (this.#db.prepare(sql).get() as { n: number }).n;
    return {
      events: count("SELECT COUNT(*) AS n FROM events"),
      observations: count("SELECT COUNT(*) AS n FROM observations"),
      posts: count("SELECT COUNT(DISTINCT post_id) AS n FROM observations"),
      deliveries: count("SELECT COUNT(*) AS n FROM deliveries"),
      posted: count("SELECT COUNT(*) AS n FROM deliveries WHERE outcome = 'posted'"),
    };
  }
}
