import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  candidatesFromActivityEvent,
  candidatesFromMentionEvent,
  DedupeStore,
  getAppConfig,
  processActivityEvent,
  processMentionEvent,
  run,
  SerialPostProcessor,
  slackMessage,
  structuralDecision,
  streamLines,
  type Runtime,
} from "../src/index.js";

const sampleEvent = {
  data: {
    event_uuid: "2065839641417138368",
    filter: { user_id: "1232338424381759488" },
    event_type: "post.create",
    tag: "tracked-profiles",
    payload: {
      conversation_id: "2065839641417138368",
      created_at: "2026-06-13T16:52:06.000Z",
      author_id: "1232338424381759488",
      text: "meow",
      id: "2065839641417138368",
    },
    includes: {
      users: [
        {
          username: "vishyfishy2",
          name: "f1shy-dev",
          id: "1232338424381759488",
        },
      ],
      tweets: [
        {
          author_id: "1232338424381759488",
          text: "meow",
          id: "2065839641417138368",
        },
      ],
    },
  },
};

const sampleMentionEvent = {
  data: {
    id: "2067000000000000000",
    text: "hello @capydotai",
    author_id: "99",
    entities: {
      mentions: [{ start: 6, end: 16, username: "capydotai", id: "88" }],
    },
  },
  includes: {
    users: [{ id: "99", username: "mentioner", name: "Mentioner" }],
  },
  matching_rules: [{ id: "1", tag: "slack-tweet-forwarder:mentions" }],
};

type FetchCall = {
  url: string;
  method: string;
  body: string | null;
};

async function withTempDir<T>(callback: (path: string) => Promise<T>): Promise<T> {
  const path = await mkdtemp(join(tmpdir(), "slack-tweet-forwarder-"));
  try {
    return await callback(path);
  } finally {
    await rm(path, { force: true, recursive: true });
  }
}

async function createRuntime(path: string, classifier: unknown): Promise<Runtime> {
  const configPath = join(path, "config.json");
  await writeFile(
    configPath,
    `${JSON.stringify({
      tracking: { authors: ["tracked_author"], mentions: ["capydotai"] },
      classifier,
    })}\n`,
  );
  return {
    xBearerToken: "x-token",
    slackWebhookUrl: "https://hooks.slack.test/services/example",
    gatewayApiKey: null,
    quietWebhookUrl: null,
    configPath,
    dedupePath: join(path, "dedupe.json"),
  };
}

async function withMockFetch<T>(
  handler: (input: string | URL | Request, init: RequestInit | undefined) => Promise<Response>,
  callback: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function loadDedupe(path: string): Promise<DedupeStore> {
  const dedupe = new DedupeStore(join(path, "dedupe.json"));
  await dedupe.load();
  return dedupe;
}

async function createProcessor(
  path: string,
  classifier: unknown,
): Promise<{ runtime: Runtime; dedupe: DedupeStore; processor: SerialPostProcessor }> {
  const runtime = await createRuntime(path, classifier);
  const dedupe = await loadDedupe(path);
  return { runtime, dedupe, processor: new SerialPostProcessor(runtime, dedupe) };
}

async function withEnv<T>(values: Record<string, string>, callback: () => Promise<T>): Promise<T> {
  const original = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    original.set(key, process.env[key]);
    process.env[key] = value;
  }

  try {
    return await callback();
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function withWorkingDirectory<T>(path: string, callback: () => Promise<T>): Promise<T> {
  const original = process.cwd();
  process.chdir(path);
  try {
    return await callback();
  } finally {
    process.chdir(original);
  }
}

test("extracts the captured X Activity post.create stream payload", () => {
  assert.deepEqual(candidatesFromActivityEvent(sampleEvent), [
    {
      id: "2065839641417138368",
      text: "meow",
      username: "vishyfishy2",
      retweetedId: null,
      kind: "activity",
    },
  ]);
});

test("extracts direct mentions from the tagged Filtered Stream rule", () => {
  assert.deepEqual(candidatesFromMentionEvent(sampleMentionEvent, new Set(["capydotai"])), [
    {
      id: "2067000000000000000",
      text: "hello @capydotai",
      username: "mentioner",
      retweetedId: null,
      kind: "mention",
    },
  ]);
});

test("ignores unowned rules and quoted-content false positives", () => {
  assert.deepEqual(
    candidatesFromMentionEvent(
      { ...sampleMentionEvent, matching_rules: [{ id: "2", tag: "someone-else" }] },
      new Set(["capydotai"]),
    ),
    [],
  );
  assert.deepEqual(
    candidatesFromMentionEvent(
      {
        ...sampleMentionEvent,
        data: { ...sampleMentionEvent.data, entities: {} },
        includes: {
          ...sampleMentionEvent.includes,
          tweets: [sampleMentionEvent.data],
        },
      },
      new Set(["capydotai"]),
    ),
    [],
  );
});

test("formats Slack messages as a bare X status URL for unfurling", () => {
  assert.equal(
    slackMessage({
      id: "123",
      username: "fish&chips",
      text: "one & <two>\nthree",
    }),
    "https://x.com/fish%26chips/status/123",
  );
});

test("loads and validates the application config", async () => {
  await withTempDir(async (path) => {
    const runtime = await createRuntime(path, { enabled: false, prompt: "" });
    assert.deepEqual(await getAppConfig(runtime.configPath), {
      tracking: { authors: ["tracked_author"], mentions: ["capydotai"] },
      classifier: { enabled: false, prompt: null, threshold: 0.7 },
    });
  });
});

test("resets invalid dedupe JSON instead of failing startup", async () => {
  await withTempDir(async (path) => {
    const dedupePath = join(path, "dedupe.json");
    await writeFile(dedupePath, "{not json");
    const dedupe = new DedupeStore(dedupePath);

    await dedupe.load();

    assert.equal(await dedupe.isDuplicate("123"), false);
    assert.deepEqual(JSON.parse(await readFile(dedupePath, "utf8")), {});
  });
});

test("forwards a captured stream post when classification is disabled and suppresses duplicates", async () => {
  await withTempDir(async (path) => {
    const { runtime, processor } = await createProcessor(path, {
      enabled: false,
      prompt: null,
    });
    const calls: Array<FetchCall> = [];

    await withMockFetch(
      async (input, init) => {
        calls.push({
          url: String(input),
          method: init?.method ?? "GET",
          body: typeof init?.body === "string" ? init.body : null,
        });
        return new Response("ok", { status: 200 });
      },
      async () => {
        await processActivityEvent(sampleEvent, processor);
        await processActivityEvent(sampleEvent, processor);
      },
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, runtime.slackWebhookUrl);
    assert.deepEqual(JSON.parse(calls[0]?.body ?? ""), {
      text: "https://x.com/vishyfishy2/status/2065839641417138368",
      unfurl_links: true,
      unfurl_media: true,
    });
    const dedupeFile: unknown = JSON.parse(await readFile(runtime.dedupePath, "utf8"));
    assert.equal(typeof dedupeFile, "object");
    assert.notEqual(dedupeFile, null);
    assert.equal(
      typeof (dedupeFile as Record<string, unknown>)["post:2065839641417138368"],
      "number",
    );
  });
});

test("serializes both streams so overlapping posts are forwarded once", async () => {
  await withTempDir(async (path) => {
    const { runtime, processor } = await createProcessor(path, {
      enabled: false,
      prompt: null,
    });
    const overlappingMention = {
      ...sampleMentionEvent,
      data: {
        ...sampleMentionEvent.data,
        id: sampleEvent.data.payload.id,
        author_id: sampleEvent.data.payload.author_id,
      },
      includes: sampleEvent.data.includes,
    };
    const calls: Array<FetchCall> = [];

    await withMockFetch(
      async (input, init) => {
        calls.push({
          url: String(input),
          method: init?.method ?? "GET",
          body: typeof init?.body === "string" ? init.body : null,
        });
        return new Response("ok", { status: 200 });
      },
      async () => {
        await Promise.all([
          processActivityEvent(sampleEvent, processor),
          processMentionEvent(overlappingMention, new Set(["capydotai"]), processor),
        ]);
      },
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, runtime.slackWebhookUrl);
  });
});

test("does not reject the stream loop when one Slack post fails", async () => {
  await withTempDir(async (path) => {
    const { processor } = await createProcessor(path, { enabled: false, prompt: null });

    await withMockFetch(
      async () => new Response("Slack exploded", { status: 500 }),
      async () => {
        await processActivityEvent(sampleEvent, processor);
      },
    );
  });
});

test("does not forward unclassified posts when classification is enabled without a gateway key", async () => {
  await withTempDir(async (path) => {
    const { dedupe, processor } = await createProcessor(path, { enabled: true, prompt: null });
    const calls: Array<FetchCall> = [];

    await withMockFetch(
      async (input, init) => {
        calls.push({
          url: String(input),
          method: init?.method ?? "GET",
          body: typeof init?.body === "string" ? init.body : null,
        });
        return new Response("ok", { status: 200 });
      },
      async () => {
        await processActivityEvent(sampleEvent, processor);
      },
    );

    assert.deepEqual(calls, []);
    assert.equal(await dedupe.isDuplicate(sampleEvent.data.payload.id), false);
  });
});

test("shuts down cleanly while waiting to reconnect", async () => {
  await withTempDir(async (path) => {
    await writeFile(
      join(path, "config.json"),
      '{"tracking":{"authors":["author"],"mentions":["capydotai"]},"classifier":{"enabled":false,"prompt":null}}\n',
    );
    await withWorkingDirectory(path, async () => {
      await withEnv(
        {
          X_BEARER_TOKEN: "invalid",
          SLACK_WEBHOOK_URL: "https://hooks.slack.test/services/example",
        },
        async () => {
          const controller = new AbortController();
          const promise = withMockFetch(
            async () =>
              Response.json(
                {
                  title: "Unauthorized",
                  status: 401,
                },
                { status: 401 },
              ),
            async () => run(controller.signal),
          );

          setTimeout(() => controller.abort(), 10);
          await promise;
        },
      );
    });
  });
});

test("looks up incomplete stream events before forwarding", async () => {
  await withTempDir(async (path) => {
    const { runtime, processor } = await createProcessor(path, {
      enabled: false,
      prompt: null,
    });
    const event = {
      data: {
        event_type: "post.create",
        payload: { id: "42" },
      },
    };
    const calls: Array<FetchCall> = [];

    await withMockFetch(
      async (input, init) => {
        const url = String(input);
        calls.push({
          url,
          method: init?.method ?? "GET",
          body: typeof init?.body === "string" ? init.body : null,
        });

        if (url.startsWith("https://api.x.com/2/tweets/42")) {
          return Response.json({
            data: {
              id: "42",
              text: "lookup text",
              author_id: "7",
            },
            includes: {
              users: [{ id: "7", username: "lookup_user" }],
            },
          });
        }

        return new Response("ok", { status: 200 });
      },
      async () => {
        await processActivityEvent(event, processor);
      },
    );

    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.method, "GET");
    assert.match(calls[0]?.url ?? "", /^https:\/\/api\.x\.com\/2\/tweets\/42\?/);
    assert.equal(calls[1]?.url, runtime.slackWebhookUrl);
    assert.deepEqual(JSON.parse(calls[1]?.body ?? ""), {
      text: "https://x.com/lookup_user/status/42",
      unfurl_links: true,
      unfurl_media: true,
    });
  });
});

test("parses newline-delimited stream chunks", async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(' {"a":1}\n\n{"b"'));
      controller.enqueue(encoder.encode(':2}\n{"c":3}'));
      controller.close();
    },
  });

  const lines: Array<string> = [];
  for await (const line of streamLines(body)) {
    lines.push(line);
  }

  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}']);
});

const gatewayUrl = "https://ai-gateway.vercel.sh/v4/ai/evaluation-model";

function activityEvent(overrides: {
  id?: string;
  username?: string;
  text?: string;
  retweetedId?: string | null;
}) {
  const id = overrides.id ?? "2065839641417138368";
  const username = overrides.username ?? "vishyfishy2";
  const text = overrides.text ?? "meow";
  return {
    data: {
      event_type: "post.create",
      payload: {
        id,
        text,
        author_id: "7",
        ...(overrides.retweetedId
          ? { referenced_tweets: [{ type: "retweeted", id: overrides.retweetedId }] }
          : {}),
      },
      includes: {
        users: [{ id: "7", username, name: username }],
      },
    },
  };
}

function jevResponse(probability: number): Response {
  return Response.json({ answers: { keep: { probability } } });
}

test("reads a retweeted id from the activity payload", () => {
  const [candidate] = candidatesFromActivityEvent(
    activityEvent({ retweetedId: "99", text: "RT @someone: hi" }),
  );
  assert.equal(candidate?.retweetedId, "99");
  assert.equal(candidate?.kind, "activity");
});

test("forwards an official account without calling Jev", async () => {
  await withTempDir(async (path) => {
    const { runtime, processor } = await createProcessor(path, {
      enabled: true,
      prompt: null,
      threshold: 0.7,
    });
    const calls: Array<FetchCall> = [];

    await withMockFetch(
      async (input, init) => {
        calls.push({
          url: String(input),
          method: init?.method ?? "GET",
          body: typeof init?.body === "string" ? init.body : null,
        });
        return new Response("ok", { status: 200 });
      },
      async () => {
        await processActivityEvent(
          activityEvent({ id: "official-1", username: "capydotai", text: "shipping notes" }),
          processor,
        );
      },
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, runtime.slackWebhookUrl);
    assert.equal(
      calls.some((call) => call.url === gatewayUrl),
      false,
    );
  });
});

test("drops a retweet of an already seen post before Jev", async () => {
  await withTempDir(async (path) => {
    const { runtime, dedupe, processor } = await createProcessor(path, {
      enabled: true,
      prompt: null,
    });
    runtime.quietWebhookUrl = "https://hooks.slack.test/quiet";
    await dedupe.put("original-1");
    const calls: Array<FetchCall> = [];

    await withMockFetch(
      async (input, init) => {
        calls.push({
          url: String(input),
          method: init?.method ?? "GET",
          body: typeof init?.body === "string" ? init.body : null,
        });
        return new Response("ok", { status: 200 });
      },
      async () => {
        await processActivityEvent(
          activityEvent({
            id: "rt-1",
            username: "lordspline",
            text: "RT @someone: already posted",
            retweetedId: "original-1",
          }),
          processor,
        );
      },
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, runtime.quietWebhookUrl);
    assert.match(calls[0]?.body ?? "", /retweet/);
    assert.equal(
      calls.some((call) => call.url === runtime.slackWebhookUrl),
      false,
    );
    assert.equal(
      calls.some((call) => call.url === gatewayUrl),
      false,
    );
    assert.equal(await dedupe.isDuplicate("rt-1"), true);
  });
});

test("forwards when Jev keep probability is at least the threshold", async () => {
  await withTempDir(async (path) => {
    const { runtime, processor } = await createProcessor(path, {
      enabled: true,
      prompt: null,
      threshold: 0.7,
    });
    runtime.gatewayApiKey = "gateway-key";
    runtime.quietWebhookUrl = "https://hooks.slack.test/quiet";
    const calls: Array<FetchCall> = [];

    await withMockFetch(
      async (input, init) => {
        calls.push({
          url: String(input),
          method: init?.method ?? "GET",
          body: typeof init?.body === "string" ? init.body : null,
        });
        return String(input) === gatewayUrl
          ? jevResponse(0.91)
          : new Response("ok", { status: 200 });
      },
      async () => {
        await processActivityEvent(
          activityEvent({ id: "keep-1", text: "a real question" }),
          processor,
        );
      },
    );

    assert.equal(calls.filter((call) => call.url === gatewayUrl).length, 1);
    assert.equal(
      calls.some((call) => call.url === runtime.slackWebhookUrl),
      true,
    );
    assert.equal(
      calls.some((call) => call.url === runtime.quietWebhookUrl),
      false,
    );
  });
});

test("sends a Jev skip to the quiet webhook and not the main channel", async () => {
  await withTempDir(async (path) => {
    const { runtime, dedupe, processor } = await createProcessor(path, {
      enabled: true,
      prompt: null,
      threshold: 0.7,
    });
    runtime.gatewayApiKey = "gateway-key";
    runtime.quietWebhookUrl = "https://hooks.slack.test/quiet";
    const calls: Array<FetchCall> = [];

    await withMockFetch(
      async (input, init) => {
        calls.push({
          url: String(input),
          method: init?.method ?? "GET",
          body: typeof init?.body === "string" ? init.body : null,
        });
        return String(input) === gatewayUrl
          ? jevResponse(0.2)
          : new Response("ok", { status: 200 });
      },
      async () => {
        await processActivityEvent(activityEvent({ id: "skip-1", text: "yes!" }), processor);
      },
    );

    assert.equal(
      calls.some((call) => call.url === runtime.slackWebhookUrl),
      false,
    );
    const quiet = calls.find((call) => call.url === runtime.quietWebhookUrl);
    assert.match(quiet?.body ?? "", /skip 0\.2/);
    assert.equal(await dedupe.isDuplicate("skip-1"), true);
  });
});

test("holds a post when Jev is down instead of forwarding it", async () => {
  await withTempDir(async (path) => {
    const { runtime, dedupe, processor } = await createProcessor(path, {
      enabled: true,
      prompt: null,
    });
    runtime.gatewayApiKey = "gateway-key";
    runtime.quietWebhookUrl = "https://hooks.slack.test/quiet";
    const calls: Array<FetchCall> = [];

    await withMockFetch(
      async (input, init) => {
        calls.push({
          url: String(input),
          method: init?.method ?? "GET",
          body: typeof init?.body === "string" ? init.body : null,
        });
        if (String(input) === gatewayUrl) {
          return new Response("unavailable", { status: 503 });
        }
        return new Response("ok", { status: 200 });
      },
      async () => {
        await processActivityEvent(
          activityEvent({ id: "held-1", text: "maybe useful" }),
          processor,
        );
      },
    );

    assert.equal(calls.filter((call) => call.url === gatewayUrl).length, 3);
    assert.equal(
      calls.some((call) => call.url === runtime.slackWebhookUrl),
      false,
    );
    const quiet = calls.find((call) => call.url === runtime.quietWebhookUrl);
    assert.match(quiet?.body ?? "", /unclassified/);
    assert.equal(await dedupe.isDuplicate("held-1"), false);
    const held = await readFile(join(path, "held.jsonl"), "utf8");
    assert.match(held, /"id":"held-1"/);
  });
});

test("hand scores record 22 junk and 8 keep, and collapse beats the official allowlist", () => {
  const rows = JSON.parse(
    readFileSync(new URL("./fixtures/hand-scores.json", import.meta.url), "utf8"),
  ) as Array<{
    id: string;
    username: string;
    verdict: "keep" | "junk";
    borderline: boolean;
    retweetedId: string | null;
  }>;
  assert.equal(rows.length, 30);
  assert.equal(rows.filter((row) => row.verdict === "junk").length, 22);
  assert.equal(rows.filter((row) => row.verdict === "keep").length, 8);
  assert.deepEqual(
    rows.filter((row) => row.borderline).map((row) => row.id),
    ["2102134401651851300", "2102134490797572511", "2102136401479471273"],
  );

  const seen = new Set<string>();
  let collapsed = 0;
  for (const row of rows) {
    const decision = structuralDecision(row, seen);
    if (row.retweetedId !== null && seen.has(row.retweetedId)) {
      assert.equal(decision, "retweet");
      collapsed += 1;
    }
    if (decision === "allowlist") {
      assert.equal(row.verdict, "keep");
    }
    seen.add(row.id);
    if (row.retweetedId !== null) {
      seen.add(row.retweetedId);
    }
  }

  assert.equal(collapsed, 7);
  assert.equal(
    structuralDecision(
      { username: "capydotai", retweetedId: "2102128216551165979" },
      new Set(["2102128216551165979"]),
    ),
    "retweet",
  );
  assert.equal(
    structuralDecision({ username: "scrapybara", retweetedId: null }, new Set()),
    "allowlist",
  );
});
