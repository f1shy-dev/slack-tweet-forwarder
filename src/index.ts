import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText, Output } from "ai";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const modelId = "gemini-3.1-flash-lite";
const dedupeTtlMs = 60 * 60 * 24 * 1000;
const activityStreamUrl = "https://api.x.com/2/activity/stream";
const defaultConfigPath = "data/classifier-config.json";
const defaultDedupePath = "data/dedupe.json";
const defaultClassifierPrompt = [
  "Decide whether this X post should be forwarded into the Slack channel.",
  "Choose send for substantive, high-signal posts: product/company updates, launches, incidents, security items, technical analysis, research, release notes, hiring/funding/business news, or other posts likely useful to the team.",
  "Choose skip for low-signal posts: memes, jokes, personal chatter, engagement bait, giveaways, repost prompts, vague replies without context, spam, or anything that does not stand alone.",
  "When uncertain, choose skip.",
].join("\n");

export type Env = {
  xBearerToken: string;
  slackWebhookUrl: string;
  googleApiKey: string | null;
  configPath: string;
  dedupePath: string;
};

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

const defaultClassifierConfig: ClassifierConfig = {
  enabled: true,
  prompt: null,
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

function readEnv(): Env {
  return {
    xBearerToken: requiredEnv("X_BEARER_TOKEN"),
    slackWebhookUrl: requiredEnv("SLACK_WEBHOOK_URL"),
    googleApiKey: optionalEnv("GOOGLE_GENERATIVE_AI_API_KEY"),
    configPath: process.env.CONFIG_PATH ?? defaultConfigPath,
    dedupePath: process.env.DEDUPE_PATH ?? defaultDedupePath,
  };
}

function usernameFromUser(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }

  const username = stringField(value, "username") ?? stringField(value, "screen_name");
  return username?.replace(/^@/, "") ?? null;
}

function candidate(
  id: string | null,
  text: string | null,
  username: string | null,
): PostCandidate | null {
  return id === null ? null : { id, text, username };
}

function mergeCandidates(candidates: Array<PostCandidate | null>): Array<PostCandidate> {
  const merged = new Map<string, PostCandidate>();
  for (const next of candidates) {
    if (next === null) {
      continue;
    }

    const current = merged.get(next.id);
    merged.set(next.id, {
      id: next.id,
      text: current?.text ?? next.text,
      username: current?.username ?? next.username,
    });
  }

  return [...merged.values()];
}

function candidateFromTweetObject(
  value: unknown,
  subscribedUserId: string | null = null,
): PostCandidate | null {
  if (!isRecord(value)) {
    return null;
  }

  const user = recordField(value, "user") ?? recordField(value, "author");
  const userId = isRecord(user) ? (idField(user, "id_str") ?? idField(user, "id")) : null;
  if (subscribedUserId !== null && userId !== null && subscribedUserId !== userId) {
    return null;
  }

  const extendedTweet = recordField(value, "extended_tweet");
  const id =
    idField(value, "id_str") ??
    idField(value, "id") ??
    idField(value, "post_id") ??
    idField(value, "tweet_id") ??
    idField(value, "postId") ??
    idField(value, "tweetId");
  const text =
    (extendedTweet === null ? null : stringField(extendedTweet, "full_text")) ??
    stringField(value, "full_text") ??
    stringField(value, "text");
  const username =
    usernameFromUser(user) ??
    stringField(value, "username") ??
    stringField(value, "screen_name")?.replace(/^@/, "") ??
    null;

  return candidate(id, text, username);
}

function candidatesFromActivityPayload(payload: unknown, depth = 0): Array<PostCandidate> {
  if (depth > 3) {
    return [];
  }

  if (Array.isArray(payload)) {
    return mergeCandidates(
      payload.flatMap((item) => candidatesFromActivityPayload(item, depth + 1)),
    );
  }

  const candidates: Array<PostCandidate | null> = [candidateFromTweetObject(payload)];

  if (!isRecord(payload) || depth >= 3) {
    return mergeCandidates(candidates);
  }

  for (const event of arrayField(payload, "tweet_create_events")) {
    candidates.push(candidateFromTweetObject(event, idField(payload, "for_user_id")));
  }

  for (const key of ["payload", "post", "tweet", "status", "data", "events"]) {
    const nested: unknown = payload[key];
    if (nested !== undefined && nested !== payload) {
      candidates.push(...candidatesFromActivityPayload(nested, depth + 1));
    }
  }

  return mergeCandidates(candidates);
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

function candidateFromActivityData(data: Record<string, unknown>): PostCandidate | null {
  const payload = recordField(data, "payload");
  if (payload === null) {
    return null;
  }

  const post = candidateFromTweetObject(payload);
  const authorId = idField(payload, "author_id");

  return post === null
    ? null
    : {
        id: post.id,
        text: post.text,
        username: post.username ?? usernameFromIncludes(recordField(data, "includes"), authorId),
      };
}

function isPostCreateEventType(value: string | null): boolean {
  return value === "post.create" || value === "PostCreate" || value === "tweet.create";
}

export function candidatesFromActivityEvent(value: unknown): Array<PostCandidate> {
  if (!isRecord(value)) {
    return [];
  }

  const dataValue = value.data;
  if (Array.isArray(dataValue)) {
    return mergeCandidates(dataValue.flatMap((item) => candidatesFromActivityEvent(item)));
  }

  const data = recordField(value, "data") ?? value;
  if (!isPostCreateEventType(stringField(data, "event_type"))) {
    return [];
  }

  return mergeCandidates([
    candidateFromActivityData(data),
    ...candidatesFromActivityPayload(data.payload ?? data),
  ]);
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

async function atomicWrite(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.tmp`;
  await writeFile(tempPath, value);
  await rename(tempPath, path);
}

function normalizeClassifierConfig(value: unknown): ClassifierConfig {
  if (!isRecord(value)) {
    return defaultClassifierConfig;
  }

  const prompt = stringField(value, "prompt");
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : defaultClassifierConfig.enabled,
    prompt: prompt === null || prompt.trim() === "" ? null : prompt,
  };
}

export async function getClassifierConfig(path: string): Promise<ClassifierConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      await atomicWrite(path, `${JSON.stringify(defaultClassifierConfig, null, 2)}\n`);
      console.info("Created default classifier config", { path });
      return defaultClassifierConfig;
    }

    console.error("Classifier config read failed; using default config", {
      path,
      error: errorMessage(error),
    });
    return defaultClassifierConfig;
  }

  try {
    return normalizeClassifierConfig(JSON.parse(raw));
  } catch (error) {
    console.error("Classifier config is invalid JSON; using default config", {
      path,
      error: errorMessage(error),
    });
    return defaultClassifierConfig;
  }
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
        await this.#save();
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
    await atomicWrite(
      this.#path,
      `${JSON.stringify(Object.fromEntries(this.#entries), null, 2)}\n`,
    );
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

async function lookupPost(candidate: PostCandidate, env: Env): Promise<XPost | null> {
  const url = new URL(`https://api.x.com/2/tweets/${encodeURIComponent(candidate.id)}`);
  url.searchParams.set("expansions", "author_id");
  url.searchParams.set("tweet.fields", "created_at");
  url.searchParams.set("user.fields", "id,name,username");

  const response = await fetch(url, {
    headers: { authorization: `Bearer ${env.xBearerToken}` },
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
  env: Env,
  dedupe: DedupeStore,
): Promise<void> {
  console.info("Processing X post candidate", candidateSummary(candidate));

  if (await dedupe.isDuplicate(candidate.id)) {
    console.info("Skipping duplicate X post", { postId: candidate.id });
    return;
  }

  let post = postFromCandidate(candidate);
  if (post === null) {
    console.info("X stream event needs post lookup", {
      postId: candidate.id,
      candidate: candidateSummary(candidate),
    });

    try {
      post = await lookupPost(candidate, env);
    } catch (error) {
      console.error("X post lookup failed", {
        postId: candidate.id,
        error: errorMessage(error),
      });
      return;
    }

    if (post === null) {
      console.error("X post lookup did not return enough post data", {
        postId: candidate.id,
        candidate: candidateSummary(candidate),
      });
      return;
    }
  }

  console.info("Resolved X post", postSummary(post));

  const config = await getClassifierConfig(env.configPath);
  console.info("Loaded classifier config", {
    postId: post.id,
    enabled: config.enabled,
    hasCustomPrompt: config.prompt !== null,
  });

  if (config.enabled) {
    if (env.googleApiKey === null) {
      console.error(
        "GOOGLE_GENERATIVE_AI_API_KEY is missing while classification is enabled; skipping post",
        {
          postId: post.id,
        },
      );
      return;
    } else {
      try {
        const shouldForward = await shouldForwardToSlack(
          post,
          env.googleApiKey,
          config.prompt ?? defaultClassifierPrompt,
        );
        if (!shouldForward) {
          console.info("AI classifier skipped X post", postSummary(post));
          await dedupe.put(post.id);
          return;
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
  await postToSlack(post, env.slackWebhookUrl);
  console.info("Slack webhook accepted X post", postSummary(post));
  await dedupe.put(post.id);
}

export async function processActivityEvent(
  value: unknown,
  env: Env,
  dedupe: DedupeStore,
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

  for (const next of candidates) {
    try {
      await processCandidate(next, env, dedupe);
    } catch (error) {
      console.error("X post candidate processing failed", {
        candidate: candidateSummary(next),
        error: errorMessage(error),
      });
    }
  }
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

async function connectActivityStream(
  env: Env,
  dedupe: DedupeStore,
  signal: AbortSignal,
): Promise<void> {
  console.info("Connecting to X Activity stream");
  const response = await fetch(activityStreamUrl, {
    headers: { authorization: `Bearer ${env.xBearerToken}` },
    signal,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`X Activity stream returned ${response.status}: ${text.slice(0, 1000)}`);
  }

  if (response.body === null) {
    throw new Error("X Activity stream response had no body");
  }

  console.info("Connected to X Activity stream");
  for await (const line of streamLines(response.body)) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      console.error("Could not parse X Activity stream line as JSON", {
        error: errorMessage(error),
        lineLength: line.length,
      });
      continue;
    }

    await processActivityEvent(value, env, dedupe);
  }

  throw new Error("X Activity stream ended");
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Aborted"));
      return;
    }

    const timeout = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(new Error("Aborted"));
      },
      { once: true },
    );
  });
}

export async function run(signal: AbortSignal): Promise<void> {
  const env = readEnv();
  const dedupe = new DedupeStore(env.dedupePath);
  await dedupe.load();
  await getClassifierConfig(env.configPath);

  let backoffMs = 1000;
  while (!signal.aborted) {
    try {
      await connectActivityStream(env, dedupe, signal);
      backoffMs = 1000;
    } catch (error) {
      if (signal.aborted) {
        return;
      }

      console.error("X Activity stream connection failed", {
        error: errorMessage(error),
        retryInMs: backoffMs,
      });
      try {
        await sleep(backoffMs, signal);
      } catch (sleepError) {
        if (signal.aborted) {
          return;
        }

        throw sleepError;
      }
      backoffMs = Math.min(backoffMs * 2, 60_000);
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
