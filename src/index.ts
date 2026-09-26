import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText, Output } from "ai";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { hydratePosts, refetchMetrics, rehydrateEvents, type Hydrated } from "./ingest.js";
import { PostStore, type StoredEvent, type StreamSource } from "./store.js";
import { authorUsername, fullText } from "./x.js";

const modelId = "gemini-3.1-flash-lite";
const dedupeTtlMs = 60 * 60 * 24 * 1000;
const activityStreamUrl = "https://api.x.com/2/activity/stream";
const filteredStreamUrl = "https://api.x.com/2/tweets/search/stream";
const configPath = "config.json";
const defaultDedupePath = "data/dedupe.json";
const defaultStorePath = "data/posts.sqlite";
const maintenanceIntervalMs = 15 * 60 * 1000;
const mentionRuleTag = "slack-tweet-forwarder:mentions";
const defaultClassifierPrompt = [
  "Decide whether this X post should be forwarded into the Slack channel.",
  "Choose send for substantive, high-signal posts: product/company updates, launches, incidents, security items, technical analysis, research, release notes, hiring/funding/business news, or other posts likely useful to the team.",
  "Choose skip for low-signal posts: memes, jokes, personal chatter, engagement bait, giveaways, repost prompts, vague replies without context, spam, or anything that does not stand alone.",
  "When uncertain, choose skip.",
].join("\n");

export type Runtime = {
  xBearerToken: string;
  slackWebhookUrl: string;
  googleApiKey: string | null;
  configPath: string;
  dedupePath: string;
  storePath: string;
};

export type ForwardOutcome =
  | "posted"
  | "duplicate"
  | "unresolved"
  | "classifier-skipped"
  | "classifier-unavailable";

export type PostCandidate = {
  id: string;
  text: string | null;
  username: string | null;
};

export type XPost = {
  id: string;
  text: string;
  username: string;
};

export type ClassifierConfig = {
  enabled: boolean;
  prompt: string | null;
};

export type AppConfig = {
  tracking: {
    authors: Array<string>;
    mentions: Array<string>;
  };
  classifier: ClassifierConfig;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function recordField(value: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const field = value[key];
  return isRecord(field) ? field : null;
}

function arrayField(value: Record<string, unknown>, key: string): Array<unknown> {
  const field = value[key];
  return Array.isArray(field) ? field : [];
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : null;
}

function idField(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  if (typeof field === "string" && field.length > 0) {
    return field;
  }

  return typeof field === "number" && Number.isSafeInteger(field) ? String(field) : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required`);
  }

  return value;
}

function optionalEnv(name: string): string | null {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? null : value;
}

function readRuntime(): Runtime {
  return {
    xBearerToken: requiredEnv("X_BEARER_TOKEN"),
    slackWebhookUrl: requiredEnv("SLACK_WEBHOOK_URL"),
    googleApiKey: optionalEnv("GOOGLE_GENERATIVE_AI_API_KEY"),
    configPath,
    dedupePath: defaultDedupePath,
    storePath: optionalEnv("STORE_PATH") ?? defaultStorePath,
  };
}

function normalizeHandle(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_]{1,15}$/.test(value)) {
    throw new Error(`${field} must be a valid X handle without @`);
  }

  return value;
}

function normalizeHandles(value: unknown, field: string): Array<string> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty array`);
  }

  const handles = value.map((handle, index) => normalizeHandle(handle, `${field}[${index}]`));
  if (new Set(handles.map((handle) => handle.toLowerCase())).size !== handles.length) {
    throw new Error(`${field} must not contain duplicate handles`);
  }

  return handles;
}

export async function getAppConfig(path: string): Promise<AppConfig> {
  const raw = await readFile(path, "utf8");
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value)) {
    throw new Error("config must contain a JSON object");
  }

  const tracking = recordField(value, "tracking");
  const classifier = recordField(value, "classifier");
  if (tracking === null || classifier === null) {
    throw new Error("config requires tracking and classifier objects");
  }

  const prompt = classifier.prompt;
  if (typeof classifier.enabled !== "boolean") {
    throw new Error("classifier.enabled must be a boolean");
  }
  if (prompt !== null && typeof prompt !== "string") {
    throw new Error("classifier.prompt must be a string or null");
  }

  return {
    tracking: {
      authors: normalizeHandles(tracking.authors, "tracking.authors"),
      mentions: normalizeHandles(tracking.mentions, "tracking.mentions"),
    },
    classifier: {
      enabled: classifier.enabled,
      prompt: typeof prompt === "string" && prompt.trim() !== "" ? prompt : null,
    },
  };
}

function usernameFromUser(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }

  return stringField(value, "username");
}

function candidate(
  id: string | null,
  text: string | null,
  username: string | null,
): PostCandidate | null {
  return id === null ? null : { id, text, username };
}

function candidateFromPost(
  value: unknown,
  includes: Record<string, unknown> | null,
): PostCandidate | null {
  if (!isRecord(value)) {
    return null;
  }

  const authorId = idField(value, "author_id");
  return candidate(
    idField(value, "id"),
    stringField(value, "text"),
    stringField(value, "username") ?? usernameFromIncludes(includes, authorId),
  );
}

function usernameFromIncludes(
  includes: Record<string, unknown> | null,
  authorId: string | null,
): string | null {
  const users = includes === null ? [] : arrayField(includes, "users");
  const user = users.find(
    (item) => isRecord(item) && authorId !== null && idField(item, "id") === authorId,
  );
  return usernameFromUser(user);
}

export function candidatesFromActivityEvent(value: unknown): Array<PostCandidate> {
  if (!isRecord(value)) {
    return [];
  }

  const data = recordField(value, "data");
  if (data === null || stringField(data, "event_type") !== "post.create") {
    return [];
  }

  const post = candidateFromPost(data.payload, recordField(data, "includes"));
  return post === null ? [] : [post];
}

function matchingRuleTags(value: Record<string, unknown>): Array<string> {
  return arrayField(value, "matching_rules")
    .map((rule) => (isRecord(rule) ? stringField(rule, "tag") : null))
    .filter((tag): tag is string => tag !== null);
}

function mentionedHandles(post: Record<string, unknown>): Array<string> {
  const entities = recordField(post, "entities");
  return (entities === null ? [] : arrayField(entities, "mentions"))
    .map((mention) => (isRecord(mention) ? stringField(mention, "username") : null))
    .filter((username): username is string => username !== null)
    .map((username) => username.toLowerCase());
}

export function candidatesFromMentionEvent(
  value: unknown,
  configuredHandles: ReadonlySet<string>,
): Array<PostCandidate> {
  if (!isRecord(value) || !matchingRuleTags(value).includes(mentionRuleTag)) {
    return [];
  }

  const post = recordField(value, "data");
  if (post === null) {
    return [];
  }

  if (!mentionedHandles(post).some((handle) => configuredHandles.has(handle))) {
    return [];
  }

  const candidate = candidateFromPost(post, recordField(value, "includes"));
  return candidate === null ? [] : [candidate];
}

function describeEvent(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return { type: typeof value };
  }

  const data = recordField(value, "data");
  const payload = data === null ? recordField(value, "payload") : recordField(data, "payload");
  const includes = data === null ? recordField(value, "includes") : recordField(data, "includes");
  return {
    keys: Object.keys(value).slice(0, 12),
    dataKeys: data === null ? [] : Object.keys(data).slice(0, 12),
    payloadKeys: payload === null ? [] : Object.keys(payload).slice(0, 12),
    eventType:
      stringField(value, "event_type") ?? (data === null ? null : stringField(data, "event_type")),
    eventUuid: data === null ? null : stringField(data, "event_uuid"),
    tag: data === null ? stringField(value, "tag") : stringField(data, "tag"),
    payloadId: payload === null ? null : idField(payload, "id"),
    payloadAuthorId: payload === null ? null : idField(payload, "author_id"),
    includesUsers: includes === null ? 0 : arrayField(includes, "users").length,
    includesTweets: includes === null ? 0 : arrayField(includes, "tweets").length,
  };
}

function candidateSummary(candidate: PostCandidate): Record<string, unknown> {
  return {
    postId: candidate.id,
    username: candidate.username,
    hasText: candidate.text !== null,
    textLength: candidate.text?.length ?? 0,
    needsLookup: candidate.text === null || candidate.username === null,
  };
}

function postSummary(post: XPost): Record<string, unknown> {
  return {
    postId: post.id,
    username: post.username,
    textLength: post.text.length,
  };
}

function postFromCandidate(candidate: PostCandidate): XPost | null {
  return candidate.text === null || candidate.username === null
    ? null
    : {
        id: candidate.id,
        text: candidate.text,
        username: candidate.username,
      };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tempPath, path);
}

export class DedupeStore {
  readonly #path: string;
  readonly #entries = new Map<string, number>();

  constructor(path: string) {
    this.#path = path;
  }

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.#path, "utf8");
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") {
        await writeJson(this.#path, {});
        return;
      }

      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      console.error("Dedupe file is invalid JSON; resetting", {
        path: this.#path,
        error: errorMessage(error),
      });
      this.#entries.clear();
      await this.#save();
      return;
    }

    if (!isRecord(parsed)) {
      console.error("Dedupe file must contain a JSON object; resetting", { path: this.#path });
      this.#entries.clear();
      await this.#save();
      return;
    }

    this.#entries.clear();
    for (const [key, expiresAt] of Object.entries(parsed)) {
      if (typeof expiresAt === "number" && Number.isFinite(expiresAt)) {
        this.#entries.set(key, expiresAt);
      }
    }
    await this.#prune();
  }

  async isDuplicate(postId: string): Promise<boolean> {
    await this.#prune();
    return this.#entries.has(this.#key(postId));
  }

  async put(postId: string): Promise<void> {
    this.#entries.set(this.#key(postId), Date.now() + dedupeTtlMs);
    await this.#save();
  }

  async #prune(): Promise<void> {
    const now = Date.now();
    let changed = false;
    for (const [key, expiresAt] of this.#entries) {
      if (expiresAt <= now) {
        this.#entries.delete(key);
        changed = true;
      }
    }

    if (changed) {
      await this.#save();
    }
  }

  async #save(): Promise<void> {
    await writeJson(this.#path, Object.fromEntries(this.#entries));
  }

  #key(postId: string): string {
    return `post:${postId}`;
  }
}

export function slackMessage(post: XPost): string {
  const link = `https://x.com/${encodeURIComponent(post.username)}/status/${encodeURIComponent(post.id)}`;
  return link;
}

function classificationPrompt(post: XPost): string {
  return [`Author: @${post.username}`, "Post text:", post.text].join("\n");
}

async function shouldForwardToSlack(
  post: XPost,
  googleApiKey: string,
  classifierPrompt: string,
): Promise<boolean> {
  const google = createGoogleGenerativeAI({ apiKey: googleApiKey });
  const { output } = await generateText({
    model: google(modelId),
    output: Output.choice({
      name: "SlackForwardDecision",
      description: "Whether an X post should be forwarded into the Slack channel.",
      options: ["send", "skip"] as const,
    }),
    system: classifierPrompt,
    temperature: 0,
    prompt: classificationPrompt(post),
  });

  return output === "send";
}

async function postToSlack(post: XPost, webhookUrl: string): Promise<void> {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text: slackMessage(post),
      unfurl_links: true,
      unfurl_media: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`Slack webhook returned ${response.status}`);
  }
}

async function lookupPost(candidate: PostCandidate, runtime: Runtime): Promise<XPost | null> {
  const url = new URL(`https://api.x.com/2/tweets/${encodeURIComponent(candidate.id)}`);
  url.searchParams.set("expansions", "author_id");
  url.searchParams.set("tweet.fields", "created_at");
  url.searchParams.set("user.fields", "id,name,username");

  const response = await fetch(url, {
    headers: { authorization: `Bearer ${runtime.xBearerToken}` },
  });

  if (!response.ok) {
    throw new Error(`X post lookup returned ${response.status}`);
  }

  const body: unknown = await response.json();
  if (!isRecord(body)) {
    return null;
  }

  const data = recordField(body, "data");
  if (data === null) {
    return null;
  }

  const text = candidate.text ?? stringField(data, "text");
  const authorId = idField(data, "author_id");
  const username =
    candidate.username ?? usernameFromIncludes(recordField(body, "includes"), authorId);

  return text === null || username === null
    ? null
    : {
        id: candidate.id,
        text,
        username,
      };
}

async function processCandidate(
  candidate: PostCandidate,
  runtime: Runtime,
  dedupe: DedupeStore,
): Promise<ForwardOutcome> {
  console.info("Processing X post candidate", candidateSummary(candidate));

  if (await dedupe.isDuplicate(candidate.id)) {
    console.info("Skipping duplicate X post", { postId: candidate.id });
    return "duplicate";
  }

  let post = postFromCandidate(candidate);
  if (post === null) {
    console.info("X stream event needs post lookup", {
      postId: candidate.id,
      candidate: candidateSummary(candidate),
    });

    try {
      post = await lookupPost(candidate, runtime);
    } catch (error) {
      console.error("X post lookup failed", {
        postId: candidate.id,
        error: errorMessage(error),
      });
      return "unresolved";
    }

    if (post === null) {
      console.error("X post lookup did not return enough post data", {
        postId: candidate.id,
        candidate: candidateSummary(candidate),
      });
      return "unresolved";
    }
  }

  console.info("Resolved X post", postSummary(post));

  const config = (await getAppConfig(runtime.configPath)).classifier;
  console.info("Loaded classifier config", {
    postId: post.id,
    enabled: config.enabled,
    hasCustomPrompt: config.prompt !== null,
  });

  if (config.enabled) {
    if (runtime.googleApiKey === null) {
      console.error(
        "GOOGLE_GENERATIVE_AI_API_KEY is missing while classification is enabled; skipping post",
        {
          postId: post.id,
        },
      );
      return "classifier-unavailable";
    } else {
      try {
        const shouldForward = await shouldForwardToSlack(
          post,
          runtime.googleApiKey,
          config.prompt ?? defaultClassifierPrompt,
        );
        if (!shouldForward) {
          console.info("AI classifier skipped X post", postSummary(post));
          await dedupe.put(post.id);
          return "classifier-skipped";
        }

        console.info("AI classifier approved X post", postSummary(post));
      } catch (error) {
        console.error("AI classification failed; forwarding post", {
          postId: post.id,
          username: post.username,
          error: errorMessage(error),
        });
      }
    }
  } else {
    console.info("AI classification disabled; forwarding X post", postSummary(post));
  }

  console.info("Posting X post to Slack", postSummary(post));
  await postToSlack(post, runtime.slackWebhookUrl);
  console.info("Slack webhook accepted X post", postSummary(post));
  await dedupe.put(post.id);
  return "posted";
}

export class SerialPostProcessor {
  readonly #runtime: Runtime;
  readonly #dedupe: DedupeStore;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(runtime: Runtime, dedupe: DedupeStore) {
    this.#runtime = runtime;
    this.#dedupe = dedupe;
  }

  process(candidate: PostCandidate): Promise<ForwardOutcome> {
    const result = this.#tail.then(() => processCandidate(candidate, this.#runtime, this.#dedupe));
    this.#tail = result.catch(() => undefined);
    return result;
  }
}

export function postIdsFromEvent(source: StreamSource, value: unknown): Array<string> {
  if (!isRecord(value)) {
    return [];
  }

  const data = recordField(value, "data");
  const post = data === null ? null : source === "activity" ? recordField(data, "payload") : data;
  const id = post === null ? null : idField(post, "id");
  return id === null ? [] : [id];
}

export function candidatesFromStoredEvent(
  source: StreamSource,
  value: unknown,
  mentionHandles: ReadonlySet<string>,
): Array<PostCandidate> {
  return source === "activity"
    ? candidatesFromActivityEvent(value)
    : candidatesFromMentionEvent(value, mentionHandles);
}

export function enrichCandidate(
  candidate: PostCandidate,
  hydrated: Hydrated | undefined,
): PostCandidate {
  if (hydrated === undefined) {
    return candidate;
  }

  return {
    id: candidate.id,
    text: fullText(hydrated.post) ?? candidate.text,
    username: authorUsername(hydrated.post, hydrated.includes) ?? candidate.username,
  };
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

export class StoreForwarder {
  readonly #runtime: Runtime;
  readonly #store: PostStore;
  readonly #processor: SerialPostProcessor;
  readonly #mentionHandles: ReadonlySet<string>;
  #draining: Promise<void> | null = null;
  #pending = false;

  constructor(
    runtime: Runtime,
    store: PostStore,
    processor: SerialPostProcessor,
    mentionHandles: ReadonlySet<string>,
  ) {
    this.#runtime = runtime;
    this.#store = store;
    this.#processor = processor;
    this.#mentionHandles = mentionHandles;
  }

  ingest(source: StreamSource, line: string): Promise<void> {
    const seq = this.#store.appendEvent(source, line);
    console.info("Stored X stream event", { source, seq, lineLength: line.length });
    return this.drain();
  }

  drain(): Promise<void> {
    this.#pending = true;
    if (this.#draining === null) {
      this.#draining = this.#drainLoop().finally(() => {
        this.#draining = null;
      });
    }

    return this.#draining;
  }

  async #drainLoop(): Promise<void> {
    while (this.#pending) {
      this.#pending = false;
      for (;;) {
        const events = this.#store.eventsAfter(this.#store.forwardedThrough());
        if (events.length === 0) {
          break;
        }

        for (const event of events) {
          await this.#forward(event);
        }
      }
    }
  }

  async #forward(event: StoredEvent): Promise<void> {
    const value = parseLine(event.line);
    if (value === undefined) {
      console.error(`Could not parse ${event.source} stream line as JSON`, { seq: event.seq });
      this.#store.appendDelivery(event.seq, null, "unparsed");
      return;
    }

    const ids = postIdsFromEvent(event.source, value);
    let hydrated = new Map<string, Hydrated>();
    if (ids.length > 0) {
      try {
        hydrated = await hydratePosts(
          this.#store,
          ids,
          "stream",
          event.seq,
          this.#runtime.xBearerToken,
        );
      } catch (error) {
        console.error("X post hydration failed; forwarding from stream data", {
          seq: event.seq,
          postIds: ids,
          error: errorMessage(error),
        });
      }
    }

    const candidates = candidatesFromStoredEvent(event.source, value, this.#mentionHandles);
    console.info("Forwarding stored X stream event", {
      seq: event.seq,
      source: event.source,
      event: describeEvent(value),
      candidateCount: candidates.length,
    });
    if (candidates.length === 0) {
      this.#store.appendDelivery(event.seq, ids[0] ?? null, "ignored");
      return;
    }

    for (const candidate of candidates) {
      let outcome: ForwardOutcome | "failed";
      try {
        outcome = await this.#processor.process(
          enrichCandidate(candidate, hydrated.get(candidate.id)),
        );
      } catch (error) {
        console.error("X post candidate processing failed", {
          source: event.source,
          candidate: candidateSummary(candidate),
          error: errorMessage(error),
        });
        outcome = "failed";
      }
      this.#store.appendDelivery(event.seq, candidate.id, outcome);
    }
  }
}

async function processCandidates(
  source: string,
  candidates: Array<PostCandidate>,
  processor: SerialPostProcessor,
): Promise<void> {
  for (const next of candidates) {
    try {
      await processor.process(next);
    } catch (error) {
      console.error("X post candidate processing failed", {
        source,
        candidate: candidateSummary(next),
        error: errorMessage(error),
      });
    }
  }
}

export async function processActivityEvent(
  value: unknown,
  processor: SerialPostProcessor,
): Promise<void> {
  const candidates = candidatesFromActivityEvent(value);
  console.info("X Activity stream event received", {
    event: describeEvent(value),
    candidateCount: candidates.length,
    candidates: candidates.map(candidateSummary),
  });

  if (candidates.length === 0) {
    console.warn("X Activity stream event did not contain a supported post payload", {
      event: describeEvent(value),
    });
    return;
  }

  await processCandidates("activity", candidates, processor);
}

export async function processMentionEvent(
  value: unknown,
  configuredHandles: ReadonlySet<string>,
  processor: SerialPostProcessor,
): Promise<void> {
  const candidates = candidatesFromMentionEvent(value, configuredHandles);
  console.info("X mention stream event received", {
    candidateCount: candidates.length,
    candidates: candidates.map(candidateSummary),
    matchingRuleTags: isRecord(value) ? matchingRuleTags(value) : [],
  });

  if (candidates.length === 0) {
    console.info("Ignoring filtered stream event without a configured direct mention");
    return;
  }

  await processCandidates("mentions", candidates, processor);
}

export async function* streamLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) {
        break;
      }

      buffer += decoder.decode(result.value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line !== "") {
          yield line;
        }
        newlineIndex = buffer.indexOf("\n");
      }
    }

    buffer += decoder.decode();
    const line = buffer.trim();
    if (line !== "") {
      yield line;
    }
  } finally {
    reader.releaseLock();
  }
}

type StreamOptions = {
  name: string;
  url: URL | string;
  runtime: Runtime;
  signal: AbortSignal;
  processLine: (line: string) => Promise<void>;
};

async function consumeStream(options: StreamOptions, onConnected: () => void): Promise<void> {
  console.info(`Connecting to ${options.name}`);
  const response = await fetch(options.url, {
    headers: { authorization: `Bearer ${options.runtime.xBearerToken}` },
    signal: options.signal,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${options.name} returned ${response.status}: ${text.slice(0, 1000)}`);
  }

  if (response.body === null) {
    throw new Error(`${options.name} response had no body`);
  }

  console.info(`Connected to ${options.name}`);
  onConnected();
  for await (const line of streamLines(response.body)) {
    void options.processLine(line).catch((error: unknown) => {
      console.error(`Could not store ${options.name} line`, { error: errorMessage(error) });
    });
  }

  throw new Error(`${options.name} ended`);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Aborted"));
      return;
    }

    const onAbort = () => {
      clearTimeout(timeout);
      reject(new Error("Aborted"));
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function runStreamLoop(options: StreamOptions): Promise<void> {
  let backoffMs = 1000;
  while (!options.signal.aborted) {
    try {
      await consumeStream(options, () => {
        backoffMs = 1000;
      });
    } catch (error) {
      if (options.signal.aborted) {
        return;
      }

      console.error(`${options.name} connection failed`, {
        error: errorMessage(error),
        retryInMs: backoffMs,
      });
      try {
        await sleep(backoffMs, options.signal);
      } catch (sleepError) {
        if (options.signal.aborted) {
          return;
        }

        throw sleepError;
      }
      backoffMs = Math.min(backoffMs * 2, 60_000);
    }
  }
}

function mentionStreamUrl(): URL {
  const url = new URL(filteredStreamUrl);
  url.searchParams.set("expansions", "author_id");
  url.searchParams.set("tweet.fields", "author_id,created_at,entities");
  url.searchParams.set("user.fields", "id,name,username");
  return url;
}

export async function run(signal: AbortSignal): Promise<void> {
  const runtime = readRuntime();
  const config = await getAppConfig(runtime.configPath);
  const mentionHandles = new Set(config.tracking.mentions.map((handle) => handle.toLowerCase()));
  const dedupe = new DedupeStore(runtime.dedupePath);
  await dedupe.load();
  const processor = new SerialPostProcessor(runtime, dedupe);
  const store = new PostStore(runtime.storePath);
  const forwarder = new StoreForwarder(runtime, store, processor, mentionHandles);

  try {
    await forwarder.drain();
    await Promise.all([
      runStreamLoop({
        name: "X Activity stream",
        url: activityStreamUrl,
        runtime,
        signal,
        processLine: (line) => forwarder.ingest("activity", line),
      }),
      runStreamLoop({
        name: "X mention stream",
        url: mentionStreamUrl(),
        runtime,
        signal,
        processLine: (line) => forwarder.ingest("mentions", line),
      }),
      runMaintenanceLoop(store, runtime, signal),
    ]);
    await forwarder.drain();
  } finally {
    store.close();
  }
}

async function runMaintenanceLoop(
  store: PostStore,
  runtime: Runtime,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
      const rehydrated = await rehydrateEvents(store, runtime.xBearerToken);
      const refetched = await refetchMetrics(store, runtime.xBearerToken);
      console.info("Store maintenance finished", { rehydrated, refetched, ...store.counts() });
    } catch (error) {
      console.error("Store maintenance failed", { error: errorMessage(error) });
    }

    try {
      await sleep(maintenanceIntervalMs, signal);
    } catch {
      return;
    }
  }
}

function isDirectRun(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectRun()) {
  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      console.info(`Received ${signal}; shutting down`);
      controller.abort();
    });
  }

  run(controller.signal).catch((error: unknown) => {
    console.error("Fatal error", { error: errorMessage(error) });
    process.exitCode = 1;
  });
}
