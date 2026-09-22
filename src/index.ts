import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const dedupeTtlMs = 60 * 60 * 24 * 1000;
const activityStreamUrl = "https://api.x.com/2/activity/stream";
const filteredStreamUrl = "https://api.x.com/2/tweets/search/stream";
const configPath = "config.json";
const defaultDedupePath = "data/dedupe.json";
const mentionRuleTag = "slack-tweet-forwarder:mentions";
const gatewayUrl = "https://ai-gateway.vercel.sh/v4/ai/evaluation-model";
const jevModelId = "typesafe-ai/jev";
const defaultThreshold = 0.7;
const jevAttempts = 3;
const jevRetryMs = 500;
const jevTimeoutMs = 20_000;
const defaultInstructions =
  "Should this X post be forwarded into the team's Capy mentions channel?";
const keepCriteria = {
  true: "A substantive post about Capy: a product or company update, a real user question, a bug report, a comparison, press, or praise from a notable account that stands on its own.",
  false:
    "A retweet of a post already seen, a one-word or emoji reply, a link-only drop, spam, an inside joke, engagement bait, or a competitor ad that does not make a specific claim.",
};

export const officialHandles = new Set(["capydotai", "scrapybara"]);

export type PostKind = "activity" | "mention";

export type Runtime = {
  xBearerToken: string;
  slackWebhookUrl: string;
  gatewayApiKey: string | null;
  quietWebhookUrl: string | null;
  configPath: string;
  dedupePath: string;
};

export type PostCandidate = {
  id: string;
  text: string | null;
  username: string | null;
  retweetedId: string | null;
  kind: PostKind;
};

export type XPost = {
  id: string;
  text: string;
  username: string;
  retweetedId: string | null;
  kind: PostKind;
};

export type ClassifierConfig = {
  enabled: boolean;
  prompt: string | null;
  threshold: number;
};

export type AppConfig = {
  tracking: {
    authors: Array<string>;
    mentions: Array<string>;
  };
  classifier: ClassifierConfig;
};

export type StructuralDecision = "retweet" | "allowlist" | "classify";

class JevRejected extends Error {
  constructor(status: number) {
    super(`AI Gateway answered HTTP ${status}`);
    this.name = "JevRejected";
  }
}

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
    gatewayApiKey: optionalEnv("AI_GATEWAY_API_KEY"),
    quietWebhookUrl: optionalEnv("CAPY_TWEETS_QUIET_WEBHOOK_URL"),
    configPath,
    dedupePath: defaultDedupePath,
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

function thresholdField(classifier: Record<string, unknown>): number {
  const field = classifier.threshold;
  if (field === undefined) {
    return defaultThreshold;
  }
  if (typeof field !== "number" || !Number.isFinite(field) || field < 0 || field > 1) {
    throw new Error("classifier.threshold must be a number from 0 to 1");
  }

  return field;
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
      threshold: thresholdField(classifier),
    },
  };
}

function usernameFromUser(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }

  return stringField(value, "username");
}

export function retweetedIdFromPost(value: Record<string, unknown>): string | null {
  for (const reference of arrayField(value, "referenced_tweets")) {
    if (!isRecord(reference) || stringField(reference, "type") !== "retweeted") {
      continue;
    }

    return idField(reference, "id");
  }

  return null;
}

function candidate(
  id: string | null,
  text: string | null,
  username: string | null,
  retweetedId: string | null,
  kind: PostKind,
): PostCandidate | null {
  return id === null ? null : { id, text, username, retweetedId, kind };
}

function candidateFromPost(
  value: unknown,
  includes: Record<string, unknown> | null,
  kind: PostKind,
): PostCandidate | null {
  if (!isRecord(value)) {
    return null;
  }

  const authorId = idField(value, "author_id");
  return candidate(
    idField(value, "id"),
    stringField(value, "text"),
    stringField(value, "username") ?? usernameFromIncludes(includes, authorId),
    retweetedIdFromPost(value),
    kind,
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

  const post = candidateFromPost(data.payload, recordField(data, "includes"), "activity");
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

  const candidate = candidateFromPost(post, recordField(value, "includes"), "mention");
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
    retweetedId: candidate.retweetedId,
  };
}

function postSummary(post: XPost): Record<string, unknown> {
  return {
    postId: post.id,
    username: post.username,
    textLength: post.text.length,
    retweetedId: post.retweetedId,
  };
}

function postFromCandidate(candidate: PostCandidate): XPost | null {
  return candidate.text === null || candidate.username === null
    ? null
    : {
        id: candidate.id,
        text: candidate.text,
        username: candidate.username,
        retweetedId: candidate.retweetedId,
        kind: candidate.kind,
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

export function slackMessage(post: { id: string; username: string; text?: string }): string {
  const link = `https://x.com/${encodeURIComponent(post.username)}/status/${encodeURIComponent(post.id)}`;
  return link;
}

export function structuralDecision(
  post: { username: string; retweetedId: string | null },
  seenIds: ReadonlySet<string>,
): StructuralDecision {
  if (post.retweetedId !== null && seenIds.has(post.retweetedId)) {
    return "retweet";
  }
  if (officialHandles.has(post.username.toLowerCase())) {
    return "allowlist";
  }

  return "classify";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function keepProbabilityFromBody(body: unknown): number | null {
  if (!isRecord(body)) {
    return null;
  }
  const answers = recordField(body, "answers");
  const keep = answers === null ? null : recordField(answers, "keep");
  const probability = keep?.probability;
  return typeof probability === "number" && Number.isFinite(probability) ? probability : null;
}

async function requestKeepProbability(
  post: XPost,
  apiKey: string,
  instructions: string,
  teamAuthor: boolean,
): Promise<number> {
  const response = await fetch(gatewayUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "ai-gateway-protocol-version": "0.0.1",
      "ai-gateway-auth-method": "api-key",
      "ai-evaluation-model-specification-version": "4",
      "ai-model-id": jevModelId,
    },
    body: JSON.stringify({
      state: {
        username: post.username,
        text: post.text,
        kind: post.kind,
        team_author: teamAuthor,
        is_retweet: post.retweetedId !== null,
      },
      questions: {
        keep: {
          type: "boolean",
          instructions,
          criteria: keepCriteria,
        },
      },
    }),
    signal: AbortSignal.timeout(jevTimeoutMs),
  });

  if (response.status >= 400 && response.status < 500) {
    throw new JevRejected(response.status);
  }
  if (!response.ok) {
    throw new Error(`AI Gateway answered HTTP ${response.status}`);
  }

  const probability = keepProbabilityFromBody(await response.json());
  if (probability === null) {
    throw new Error("Jev response did not include keep.probability");
  }

  return probability;
}

async function keepProbability(
  post: XPost,
  apiKey: string,
  instructions: string,
  teamAuthor: boolean,
): Promise<number> {
  let lastError = "Jev did not respond";
  for (let attempt = 1; attempt <= jevAttempts; attempt++) {
    if (attempt > 1) {
      await delay(jevRetryMs * 2 ** (attempt - 2));
    }

    try {
      return await requestKeepProbability(post, apiKey, instructions, teamAuthor);
    } catch (error) {
      if (error instanceof JevRejected) {
        throw error;
      }
      lastError = errorMessage(error);
      console.error("Jev request failed", {
        postId: post.id,
        attempt,
        error: lastError,
      });
    }
  }

  throw new Error(lastError);
}

async function postToSlack(post: XPost, webhookUrl: string, note?: string): Promise<void> {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text: note === undefined ? slackMessage(post) : `${slackMessage(post)}\n${note}`,
      unfurl_links: true,
      unfurl_media: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`Slack webhook returned ${response.status}`);
  }
}

async function notifyQuiet(post: XPost, webhookUrl: string | null, note: string): Promise<boolean> {
  if (webhookUrl === null) {
    return false;
  }

  try {
    await postToSlack(post, webhookUrl, note);
    return true;
  } catch (error) {
    console.error("Quiet webhook failed", {
      postId: post.id,
      note,
      error: errorMessage(error),
    });
    return false;
  }
}

async function holdPost(dedupePath: string, post: XPost, error: string): Promise<void> {
  const path = join(dirname(dedupePath), "held.jsonl");
  await mkdir(dirname(path), { recursive: true });
  await appendFile(
    path,
    `${JSON.stringify({
      id: post.id,
      username: post.username,
      text: post.text,
      error: error.slice(0, 500),
    })}\n`,
  );
}

async function lookupPost(candidate: PostCandidate, runtime: Runtime): Promise<XPost | null> {
  const url = new URL(`https://api.x.com/2/tweets/${encodeURIComponent(candidate.id)}`);
  url.searchParams.set("expansions", "author_id");
  url.searchParams.set("tweet.fields", "created_at,referenced_tweets");
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
        retweetedId: candidate.retweetedId ?? retweetedIdFromPost(data),
        kind: candidate.kind,
      };
}

async function resolveRetweet(post: XPost, runtime: Runtime): Promise<XPost> {
  if (post.retweetedId !== null || !post.text.startsWith("RT @")) {
    return post;
  }

  try {
    const lookedUp = await lookupPost(
      {
        id: post.id,
        text: post.text,
        username: post.username,
        retweetedId: null,
        kind: post.kind,
      },
      runtime,
    );
    return lookedUp ?? post;
  } catch (error) {
    console.error("Retweet lookup failed", {
      postId: post.id,
      error: errorMessage(error),
    });
    return post;
  }
}

async function remember(post: XPost, dedupe: DedupeStore): Promise<void> {
  await dedupe.put(post.id);
  if (post.retweetedId !== null) {
    await dedupe.put(post.retweetedId);
  }
}

async function forwardMain(post: XPost, runtime: Runtime, dedupe: DedupeStore): Promise<void> {
  console.info("Posting X post to Slack", postSummary(post));
  await postToSlack(post, runtime.slackWebhookUrl);
  console.info("Slack webhook accepted X post", postSummary(post));
  await remember(post, dedupe);
}

async function processCandidate(
  candidate: PostCandidate,
  runtime: Runtime,
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
      post = await lookupPost(candidate, runtime);
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

  const config = await getAppConfig(runtime.configPath);
  console.info("Loaded classifier config", {
    postId: post.id,
    enabled: config.classifier.enabled,
    threshold: config.classifier.threshold,
  });

  if (!config.classifier.enabled) {
    console.info("AI classification disabled; forwarding X post", postSummary(post));
    await forwardMain(post, runtime, dedupe);
    return;
  }

  const resolved = await resolveRetweet(post, runtime);
  const seenIds = new Set<string>();
  if (resolved.retweetedId !== null && (await dedupe.isDuplicate(resolved.retweetedId))) {
    seenIds.add(resolved.retweetedId);
  }
  const decision = structuralDecision(resolved, seenIds);
  if (decision === "retweet") {
    console.info("Collapsed retweet of an already seen post", postSummary(resolved));
    await notifyQuiet(resolved, runtime.quietWebhookUrl, "retweet");
    await remember(resolved, dedupe);
    return;
  }
  if (decision === "allowlist") {
    console.info("Official account allowlist; forwarding without Jev", postSummary(resolved));
    await forwardMain(resolved, runtime, dedupe);
    return;
  }

  if (runtime.gatewayApiKey === null) {
    console.error("AI_GATEWAY_API_KEY is missing while classification is enabled; holding post", {
      postId: resolved.id,
    });
    return;
  }

  const authors = new Set(config.tracking.authors.map((handle) => handle.toLowerCase()));
  try {
    const probability = await keepProbability(
      resolved,
      runtime.gatewayApiKey,
      config.classifier.prompt ?? defaultInstructions,
      authors.has(resolved.username.toLowerCase()),
    );
    if (probability >= config.classifier.threshold) {
      console.info("Jev approved X post", { ...postSummary(resolved), probability });
      await forwardMain(resolved, runtime, dedupe);
      return;
    }

    console.info("Jev skipped X post", { ...postSummary(resolved), probability });
    await notifyQuiet(resolved, runtime.quietWebhookUrl, `skip ${probability}`);
    await remember(resolved, dedupe);
  } catch (error) {
    console.error("Jev classification failed; holding post", {
      postId: resolved.id,
      error: errorMessage(error),
    });
    await notifyQuiet(resolved, runtime.quietWebhookUrl, "unclassified");
    await holdPost(runtime.dedupePath, resolved, errorMessage(error));
  }
}

export class SerialPostProcessor {
  readonly #runtime: Runtime;
  readonly #dedupe: DedupeStore;
  #tail: Promise<void> = Promise.resolve();

  constructor(runtime: Runtime, dedupe: DedupeStore) {
    this.#runtime = runtime;
    this.#dedupe = dedupe;
  }

  process(candidate: PostCandidate): Promise<void> {
    const result = this.#tail.then(() => processCandidate(candidate, this.#runtime, this.#dedupe));
    this.#tail = result.catch(() => undefined);
    return result;
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
  processEvent: (value: unknown) => Promise<void>;
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
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      console.error(`Could not parse ${options.name} line as JSON`, {
        error: errorMessage(error),
        lineLength: line.length,
      });
      continue;
    }

    await options.processEvent(value);
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
  url.searchParams.set("tweet.fields", "author_id,created_at,entities,referenced_tweets");
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

  await Promise.all([
    runStreamLoop({
      name: "X Activity stream",
      url: activityStreamUrl,
      runtime,
      signal,
      processEvent: (value) => processActivityEvent(value, processor),
    }),
    runStreamLoop({
      name: "X mention stream",
      url: mentionStreamUrl(),
      runtime,
      signal,
      processEvent: (value) => processMentionEvent(value, mentionHandles, processor),
    }),
  ]);
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
