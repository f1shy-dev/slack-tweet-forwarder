import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText, Output } from "ai";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const modelId = "gemini-3.1-flash-lite";
const dedupeTtlSeconds = 60 * 60 * 24;
const classifierConfigKey = "config:classifier";
const defaultClassifierPrompt = [
  "Decide whether this X post should be forwarded into the Slack channel.",
  "Choose send for substantive, high-signal posts: product/company updates, launches, incidents, security items, technical analysis, research, release notes, hiring/funding/business news, or other posts likely useful to the team.",
  "Choose skip for low-signal posts: memes, jokes, personal chatter, engagement bait, giveaways, repost prompts, vague replies without context, spam, or anything that does not stand alone.",
  "When uncertain, choose skip.",
].join("\n");

type PostCandidate = {
  id: string;
  text: string | null;
  username: string | null;
};

type XPost = {
  id: string;
  text: string;
  username: string;
};

type ClassifierConfig = {
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

function candidateFromFilteredStream(value: unknown): PostCandidate | null {
  if (!isRecord(value)) {
    return null;
  }

  const data = recordField(value, "data");
  if (data === null) {
    return null;
  }

  const id = idField(data, "id");
  const text = stringField(data, "text");
  const authorId = idField(data, "author_id");
  const includes = recordField(value, "includes");
  const users = includes === null ? [] : arrayField(includes, "users");
  const user = users.find(
    (item) => isRecord(item) && authorId !== null && idField(item, "id") === authorId,
  );
  const username =
    usernameFromUser(user) ??
    usernameFromUser(recordField(data, "user")) ??
    usernameFromUser(recordField(data, "author"));

  return candidate(id, text, username);
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

function candidatesFromAccountActivity(value: unknown): Array<PostCandidate> {
  if (!isRecord(value)) {
    return [];
  }

  const subscribedUserId = idField(value, "for_user_id");
  return mergeCandidates(
    arrayField(value, "tweet_create_events").map((event) =>
      candidateFromTweetObject(event, subscribedUserId),
    ),
  );
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

  const candidates: Array<PostCandidate | null> = [
    candidateFromFilteredStream(payload),
    candidateFromTweetObject(payload),
  ];

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

function candidateFromActivityData(data: Record<string, unknown>): PostCandidate | null {
  const payload = recordField(data, "payload");
  if (payload === null) {
    return null;
  }

  const post = candidateFromTweetObject(payload);
  const authorId = idField(payload, "author_id");
  const includes = recordField(data, "includes");
  const users = includes === null ? [] : arrayField(includes, "users");
  const user = users.find(
    (item) => isRecord(item) && authorId !== null && idField(item, "id") === authorId,
  );

  return post === null
    ? null
    : {
        id: post.id,
        text: post.text,
        username: post.username ?? usernameFromUser(user),
      };
}

function isPostCreateEventType(value: string | null): boolean {
  return value === "post.create" || value === "PostCreate" || value === "tweet.create";
}

function candidatesFromActivityEvent(value: unknown): Array<PostCandidate> {
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

function candidatesFromWebhookEvent(value: unknown): Array<PostCandidate> {
  return mergeCandidates([
    candidateFromFilteredStream(value),
    ...candidatesFromAccountActivity(value),
    ...candidatesFromActivityEvent(value),
  ]);
}

function describeEvent(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return { type: typeof value };
  }

  const data = recordField(value, "data");
  return {
    keys: Object.keys(value).slice(0, 12),
    dataKeys: data === null ? [] : Object.keys(data).slice(0, 12),
    eventType:
      stringField(value, "event_type") ?? (data === null ? null : stringField(data, "event_type")),
    hasTweetCreateEvents: Array.isArray(value.tweet_create_events),
    hasMatchingRules: Array.isArray(value.matching_rules),
  };
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function encodeBase64(value: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(value)));
}

function decodeSignature(value: string | null): Uint8Array | null {
  if (!value?.startsWith("sha256=")) {
    return null;
  }

  try {
    return Uint8Array.from(atob(value.slice(7)), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function crcResponse(token: string, secret: string): Promise<Response> {
  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(token));

  return Response.json({
    response_token: `sha256=${encodeBase64(signature)}`,
  });
}

async function hasValidSignature(
  body: ArrayBuffer,
  signatureHeader: string | null,
  secret: string,
): Promise<boolean> {
  const signature = decodeSignature(signatureHeader);
  if (signature === null) {
    return false;
  }

  const key = await importHmacKey(secret);
  return crypto.subtle.verify("HMAC", key, signature, body);
}

function escapeMrkdwn(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function slackMessage(post: XPost): string {
  const text = escapeMrkdwn(post.text).replaceAll("\n", "\n>");
  const link = `https://x.com/${encodeURIComponent(post.username)}/status/${encodeURIComponent(post.id)}`;
  return `*@${escapeMrkdwn(post.username)}* posted\n>${text}\n${link}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function dedupeKey(postId: string): string {
  return `post:${postId}`;
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

async function fetchPost(postId: string, bearerToken: string): Promise<PostCandidate | null> {
  const url = new URL(`https://api.x.com/2/tweets/${encodeURIComponent(postId)}`);
  url.searchParams.set("expansions", "author_id");
  url.searchParams.set("tweet.fields", "author_id,created_at");
  url.searchParams.set("user.fields", "id,name,username");

  const response = await fetch(url, {
    headers: { authorization: `Bearer ${bearerToken}` },
  });
  if (!response.ok) {
    throw new Error(`X post lookup returned ${response.status}`);
  }

  const body: unknown = await response.json();
  return candidatesFromActivityPayload(body)[0] ?? null;
}

async function resolvePost(candidate: PostCandidate, bearerToken: string): Promise<XPost | null> {
  const complete = postFromCandidate(candidate);
  if (complete !== null) {
    return complete;
  }

  const fetched = await fetchPost(candidate.id, bearerToken);
  if (fetched === null) {
    return null;
  }

  return postFromCandidate({
    id: candidate.id,
    text: candidate.text ?? fetched.text,
    username: candidate.username ?? fetched.username,
  });
}

function classificationPrompt(post: XPost): string {
  return [`Author: @${post.username}`, "Post text:", post.text].join("\n");
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

async function getClassifierConfig(kv: KVNamespace): Promise<ClassifierConfig> {
  let raw: string | null;
  try {
    raw = await kv.get(classifierConfigKey);
  } catch (error) {
    console.error("KV classifier config read failed; using default config", {
      error: errorMessage(error),
    });
    return defaultClassifierConfig;
  }

  if (raw === null) {
    try {
      await kv.put(classifierConfigKey, JSON.stringify(defaultClassifierConfig, null, 2));
    } catch (error) {
      console.error("KV classifier config creation failed; using default config", {
        error: errorMessage(error),
      });
    }
    return defaultClassifierConfig;
  }

  try {
    return normalizeClassifierConfig(JSON.parse(raw));
  } catch (error) {
    console.error("KV classifier config is invalid JSON; using default config", {
      error: errorMessage(error),
    });
    return defaultClassifierConfig;
  }
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

async function isDuplicate(dedupeKv: KVNamespace, postId: string): Promise<boolean> {
  try {
    return (await dedupeKv.get(dedupeKey(postId))) !== null;
  } catch (error) {
    console.error("KV dedupe read failed; treating post as new", {
      postId,
      error: errorMessage(error),
    });
    return false;
  }
}

async function putDedupe(dedupeKv: KVNamespace, postId: string): Promise<void> {
  try {
    await dedupeKv.put(dedupeKey(postId), "1", {
      expirationTtl: dedupeTtlSeconds,
    });
  } catch (error) {
    console.error("KV dedupe write failed", {
      postId,
      error: errorMessage(error),
    });
  }
}

async function forwardToSlack(candidate: PostCandidate, env: Env): Promise<void> {
  if (await isDuplicate(env.DEDUPE_KV, candidate.id)) {
    return;
  }

  let post: XPost | null;
  try {
    post = await resolvePost(candidate, env.X_BEARER_TOKEN);
  } catch (error) {
    console.error("X post lookup failed; skipping incomplete event", {
      postId: candidate.id,
      error: errorMessage(error),
    });
    return;
  }

  if (post === null) {
    console.error("X event did not include enough post data", {
      postId: candidate.id,
    });
    return;
  }

  const config = await getClassifierConfig(env.DEDUPE_KV);
  if (config.enabled) {
    try {
      const shouldForward = await shouldForwardToSlack(
        post,
        env.GOOGLE_GENERATIVE_AI_API_KEY,
        config.prompt ?? defaultClassifierPrompt,
      );
      if (!shouldForward) {
        await putDedupe(env.DEDUPE_KV, post.id);
        return;
      }
    } catch (error) {
      console.error("AI classification failed; forwarding post", {
        postId: post.id,
        username: post.username,
        error: errorMessage(error),
      });
    }
  }

  const response = await fetch(env.SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: slackMessage(post) }),
  });

  if (!response.ok) {
    throw new Error(`Slack webhook returned ${response.status}`);
  }

  await putDedupe(env.DEDUPE_KV, post.id);
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/webhook") {
      return new Response("Not found", { status: 404 });
    }

    if (request.method === "GET") {
      const token = url.searchParams.get("crc_token");
      if (token === null) {
        return new Response("Missing crc_token", { status: 400 });
      }

      ctx.waitUntil(getClassifierConfig(env.DEDUPE_KV));
      return crcResponse(token, env.X_CONSUMER_SECRET);
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { allow: "GET, POST" },
      });
    }

    const body = await request.arrayBuffer();
    if (
      !(await hasValidSignature(
        body,
        request.headers.get("x-twitter-webhooks-signature"),
        env.X_CONSUMER_SECRET,
      ))
    ) {
      return new Response("Unauthorized", { status: 401 });
    }

    let event: unknown;
    try {
      event = JSON.parse(decoder.decode(body));
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    const candidates = candidatesFromWebhookEvent(event);
    if (candidates.length === 0) {
      console.warn("Signed X webhook event did not contain a supported post payload", {
        event: describeEvent(event),
      });
    }

    for (const next of candidates) {
      ctx.waitUntil(forwardToSlack(next, env));
    }

    return new Response("OK");
  },
} satisfies ExportedHandler<Env>;
