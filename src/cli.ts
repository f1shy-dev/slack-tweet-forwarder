import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  candidatesFromStoredEvent,
  enrichCandidate,
  getAppConfig,
  postIdsFromEvent,
  slackMessage,
} from "./index.js";
import { refetchMetrics } from "./ingest.js";
import { PostStore, type Observation } from "./store.js";
import { authorUsername, fullText, includesFor, searchRecent, xApiBaseUrl } from "./x.js";

const postReadUsd = 0.005;
const userReadUsd = 0.01;
const searchQueryLimit = 512;
const recentSearchWindowMs = 7 * 24 * 60 * 60 * 1000;

const usage = `Usage: node dist/cli.js <command> [options]

Commands:
  backfill [--days 7] [--max-posts 2000]   Pull recent posts matching the stream rules via search/recent
  refetch                                  Re-fetch public_metrics for posts first seen 24 h ago or earlier
  export [--posted-only] [--since ISO] [--labels user-labels.json] [--out file]
                                           Emit labelling-app JSONL joined to the stored X objects
  replay [--since ISO] [--until ISO]       Dry-run the forwarder over stored stream events as JSONL
  stats                                    Print store row counts

Environment: STORE_PATH (default data/posts.sqlite), X_BEARER_TOKEN for backfill and refetch, X_API_BASE_URL to point backfill and refetch at a recorded-fixture server.`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bearerToken(): string {
  const token = process.env.X_BEARER_TOKEN;
  if (token === undefined || token.trim() === "") {
    throw new Error("X_BEARER_TOKEN is required");
  }
  return token;
}

function openStore(): PostStore {
  return new PostStore(process.env.STORE_PATH ?? "data/posts.sqlite");
}

function xBaseUrl(): string {
  return process.env.X_API_BASE_URL ?? xApiBaseUrl;
}

export function backfillQuery(
  authors: ReadonlyArray<string>,
  mentions: ReadonlyArray<string>,
): string {
  const query = [
    ...mentions.map((handle) => `@${handle}`),
    ...authors.map((handle) => `from:${handle}`),
  ].join(" OR ");
  if (query.length > searchQueryLimit) {
    throw new Error(
      `Backfill query is ${query.length} characters; search/recent allows ${searchQueryLimit}`,
    );
  }
  return query;
}

async function backfill(days: number, maxPosts: number): Promise<void> {
  const config = await getAppConfig("config.json");
  const query = backfillQuery(config.tracking.authors, config.tracking.mentions);
  const now = Date.now();
  const startTime = new Date(
    Math.max(now - days * 24 * 60 * 60 * 1000, now - recentSearchWindowMs + 60_000),
  ).toISOString();
  const store = openStore();
  const users = new Set<string>();
  let returned = 0;
  let stored = 0;
  let pages = 0;
  let nextToken: string | null = null;
  try {
    do {
      const page = await searchRecent(query, startTime, nextToken, bearerToken(), xBaseUrl());
      pages += 1;
      for (const user of isRecord(page.includes) && Array.isArray(page.includes.users)
        ? page.includes.users
        : []) {
        if (isRecord(user) && typeof user.id === "string") {
          users.add(user.id);
        }
      }
      for (const post of page.posts) {
        returned += 1;
        if (typeof post.id !== "string" || store.hasObservation(post.id, ["stream", "backfill"])) {
          continue;
        }
        store.appendObservation(post.id, "backfill", post, includesFor(post, page.includes));
        stored += 1;
      }
      nextToken = page.nextToken;
    } while (nextToken !== null && returned < maxPosts);

    console.log(
      JSON.stringify({
        query,
        startTime,
        pages,
        returned,
        stored,
        uniqueUsers: users.size,
        truncatedAtMaxPosts: nextToken !== null,
        estimatedUsd: Number((returned * postReadUsd + users.size * userReadUsd).toFixed(3)),
      }),
    );
  } finally {
    store.close();
  }
}

function contextMissing(first: Observation): boolean {
  const refs = Array.isArray(first.post.referenced_tweets) ? first.post.referenced_tweets : [];
  const included = new Set<unknown>(
    (first.includes !== null && Array.isArray(first.includes.tweets) ? first.includes.tweets : [])
      .map((tweet) => (isRecord(tweet) ? tweet.id : null))
      .filter((id) => typeof id === "string"),
  );
  return refs.some((ref) => !isRecord(ref) || !included.has(ref.id));
}

async function exportPosts(
  postedOnly: boolean,
  since: string | null,
  labelsPath: string | null,
  out: string | null,
): Promise<void> {
  const labels: unknown = labelsPath === null ? {} : JSON.parse(await readFile(labelsPath, "utf8"));
  const store = openStore();
  try {
    const rows = store
      .firstObservations()
      .map((first) => ({ first, postedAt: store.firstPostedAt(first.postId) }))
      .filter(({ postedAt }) => !postedOnly || postedAt !== null)
      .map(({ first, postedAt }) => ({ first, postedAt, observedAt: postedAt ?? first.fetchedAt }))
      .filter(({ observedAt }) => since === null || observedAt >= since)
      .sort((a, b) => b.observedAt.localeCompare(a.observedAt))
      .map(({ first, postedAt, observedAt }, index) => {
        const observations = store.observations(first.postId);
        const refetch = observations.findLast((observation) => observation.source === "refetch");
        const label =
          isRecord(labels) && isRecord(labels[first.postId]) ? labels[first.postId] : null;
        return {
          index,
          id: first.postId,
          username: authorUsername(first.post, first.includes),
          text: fullText(first.post) ?? "",
          context_missing: contextMissing(first),
          slack_ts: null,
          observed_at: observedAt,
          source: `capy-tweets store (${first.source}${postedAt === null ? "" : ", posted"})`,
          label: null,
          human_label: isRecord(label) && typeof label.label === "string" ? label.label : null,
          x: {
            post: first.post,
            includes: first.includes,
            fetched_at: first.fetchedAt,
            posted_at: postedAt,
            refetch:
              refetch === undefined
                ? null
                : {
                    fetched_at: refetch.fetchedAt,
                    public_metrics: refetch.post.public_metrics ?? null,
                    unavailable: refetch.post.unavailable === true,
                  },
          },
        };
      });
    const jsonl = rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : "");
    if (out === null) {
      process.stdout.write(jsonl);
    } else {
      await writeFile(out, jsonl);
      console.error(`Wrote ${rows.length} rows to ${out}`);
    }
  } finally {
    store.close();
  }
}

async function replay(since: string, until: string): Promise<void> {
  const config = await getAppConfig("config.json");
  const handles = new Set(config.tracking.mentions.map((handle) => handle.toLowerCase()));
  const store = openStore();
  const seen = new Set<string>();
  try {
    for (const event of store.eventsBetween(since, until)) {
      let value: unknown;
      try {
        value = JSON.parse(event.line);
      } catch {
        console.log(
          JSON.stringify({ seq: event.seq, received_at: event.receivedAt, decision: "unparsed" }),
        );
        continue;
      }
      const candidates = candidatesFromStoredEvent(event.source, value, handles);
      if (candidates.length === 0) {
        console.log(
          JSON.stringify({
            seq: event.seq,
            source: event.source,
            received_at: event.receivedAt,
            post_id: postIdsFromEvent(event.source, value)[0] ?? null,
            decision: "ignored",
          }),
        );
        continue;
      }
      for (const candidate of candidates) {
        const first = store
          .observations(candidate.id)
          .find((observation) => observation.source === "stream");
        const post = enrichCandidate(
          candidate,
          first === undefined ? undefined : { post: first.post, includes: first.includes },
        );
        const decision = seen.has(post.id)
          ? "duplicate"
          : post.text === null || post.username === null
            ? "unresolved"
            : "post";
        seen.add(post.id);
        console.log(
          JSON.stringify({
            seq: event.seq,
            source: event.source,
            received_at: event.receivedAt,
            post_id: post.id,
            decision,
            slack_text:
              decision === "post" && post.text !== null && post.username !== null
                ? slackMessage({ id: post.id, text: post.text, username: post.username })
                : null,
          }),
        );
      }
    }
  } finally {
    store.close();
  }
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      days: { type: "string", default: "7" },
      "max-posts": { type: "string", default: "2000" },
      "posted-only": { type: "boolean", default: false },
      since: { type: "string" },
      until: { type: "string" },
      labels: { type: "string" },
      out: { type: "string" },
    },
  });

  switch (positionals[0]) {
    case "backfill":
      await backfill(Number(values.days), Number(values["max-posts"]));
      return;
    case "refetch": {
      const store = openStore();
      try {
        console.log(
          JSON.stringify({
            refetched: await refetchMetrics(store, bearerToken(), Date.now(), xBaseUrl()),
          }),
        );
      } finally {
        store.close();
      }
      return;
    }
    case "export":
      await exportPosts(
        values["posted-only"],
        values.since ?? null,
        values.labels ?? null,
        values.out ?? null,
      );
      return;
    case "replay":
      await replay(values.since ?? "0000", values.until ?? "9999");
      return;
    case "stats": {
      const store = openStore();
      try {
        console.log(JSON.stringify(store.counts()));
      } finally {
        store.close();
      }
      return;
    }
    default:
      console.error(usage);
      process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
