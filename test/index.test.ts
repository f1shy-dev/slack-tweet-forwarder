import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
  StoreForwarder,
  streamLines,
  type Runtime,
} from "../src/index.js";
import { refetchMetrics } from "../src/ingest.js";
import { PostStore } from "../src/store.js";

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
    googleApiKey: null,
    configPath,
    dedupePath: join(path, "dedupe.json"),
    storePath: join(path, "posts.sqlite"),
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
    },
  ]);
});

test("extracts direct mentions from the tagged Filtered Stream rule", () => {
  assert.deepEqual(candidatesFromMentionEvent(sampleMentionEvent, new Set(["capydotai"])), [
    {
      id: "2067000000000000000",
      text: "hello @capydotai",
      username: "mentioner",
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
      classifier: { enabled: false, prompt: null },
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

test("does not forward unclassified posts when classification is enabled without a Google key", async () => {
  await withTempDir(async (path) => {
    const { processor } = await createProcessor(path, { enabled: true, prompt: null });
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

const hydratedPost = {
  id: "2065839641417138368",
  text: "meow",
  author_id: "1232338424381759488",
  created_at: "2026-06-13T16:52:06.000Z",
  conversation_id: "2065839641417138368",
  referenced_tweets: [{ type: "quoted", id: "2065000000000000000" }],
  entities: { urls: [{ url: "https://t.co/x", expanded_url: "https://capy.ai" }] },
  attachments: { media_keys: ["3_1"] },
  public_metrics: { retweet_count: 1, reply_count: 2, like_count: 3, quote_count: 0 },
};

const hydratedIncludes = {
  users: [
    { id: "1232338424381759488", username: "vishyfishy2", name: "f1shy-dev" },
    { id: "5", username: "unrelated", name: "Unrelated" },
  ],
  tweets: [{ id: "2065000000000000000", text: "quoted", author_id: "1232338424381759488" }],
  media: [{ media_key: "3_1", type: "photo", url: "https://pbs.twimg.com/media/x.jpg" }],
};

function xLookupResponse(url: string): Response | null {
  if (!url.startsWith("https://api.x.com/2/tweets?")) {
    return null;
  }

  const ids = new URL(url).searchParams.get("ids")?.split(",") ?? [];
  return Response.json({
    data: ids.map((id) => ({ ...hydratedPost, id })),
    includes: hydratedIncludes,
  });
}

async function withStoreForwarder<T>(
  path: string,
  callback: (context: {
    runtime: Runtime;
    store: PostStore;
    forwarder: StoreForwarder;
    calls: Array<FetchCall>;
  }) => Promise<T>,
): Promise<T> {
  const { runtime, processor } = await createProcessor(path, { enabled: false, prompt: null });
  const store = new PostStore(runtime.storePath);
  const forwarder = new StoreForwarder(runtime, store, processor, new Set(["capydotai"]));
  const calls: Array<FetchCall> = [];
  try {
    return await withMockFetch(
      async (input, init) => {
        const url = String(input);
        calls.push({
          url,
          method: init?.method ?? "GET",
          body: typeof init?.body === "string" ? init.body : null,
        });
        return xLookupResponse(url) ?? new Response("ok", { status: 200 });
      },
      () => callback({ runtime, store, forwarder, calls }),
    );
  } finally {
    store.close();
  }
}

test("stores the raw event and the full hydrated X object before forwarding", async () => {
  await withTempDir(async (path) => {
    await withStoreForwarder(path, async ({ runtime, store, forwarder, calls }) => {
      await forwarder.ingest("activity", JSON.stringify(sampleEvent));
      await forwarder.ingest("activity", JSON.stringify(sampleEvent));

      const lookup = new URL(calls[0]?.url ?? "");
      assert.equal(lookup.pathname, "/2/tweets");
      assert.match(lookup.searchParams.get("tweet.fields") ?? "", /referenced_tweets/);
      assert.match(lookup.searchParams.get("tweet.fields") ?? "", /public_metrics/);
      assert.match(lookup.searchParams.get("expansions") ?? "", /attachments\.media_keys/);
      assert.equal(calls.filter((call) => call.url === runtime.slackWebhookUrl).length, 1);

      const observations = store.observations(hydratedPost.id);
      assert.equal(observations.length, 2);
      assert.deepEqual(observations[0]?.post, hydratedPost);
      assert.equal(observations[0]?.eventSeq, 1);
      assert.match(observations[0]?.fetchedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
      assert.deepEqual(
        ((observations[0]?.includes?.users ?? []) as Array<{ id: string }>).map((user) => user.id),
        ["1232338424381759488"],
      );
      assert.deepEqual(store.counts(), {
        events: 2,
        observations: 2,
        posts: 1,
        deliveries: 2,
        posted: 1,
      });
    });
  });
});

test("stores and hydrates stream events the forwarder does not select", async () => {
  await withTempDir(async (path) => {
    await withStoreForwarder(path, async ({ runtime, store, forwarder, calls }) => {
      const indirect = {
        ...sampleMentionEvent,
        data: { ...sampleMentionEvent.data, id: "77", entities: {} },
      };
      await forwarder.ingest("mentions", JSON.stringify(indirect));
      await forwarder.ingest("mentions", "{not json");

      assert.equal(calls.filter((call) => call.url === runtime.slackWebhookUrl).length, 0);
      assert.equal(store.observations("77").length, 1);
      assert.deepEqual(store.counts(), {
        events: 2,
        observations: 1,
        posts: 1,
        deliveries: 2,
        posted: 0,
      });
    });
  });
});

test("forwards stored events that were never delivered after a restart", async () => {
  await withTempDir(async (path) => {
    const storePath = join(path, "posts.sqlite");
    const offline = new PostStore(storePath);
    offline.appendEvent("activity", JSON.stringify(sampleEvent));
    offline.close();

    await withStoreForwarder(path, async ({ runtime, store, forwarder, calls }) => {
      await forwarder.drain();
      assert.equal(calls.filter((call) => call.url === runtime.slackWebhookUrl).length, 1);
      assert.equal(store.forwardedThrough(), 1);
      await forwarder.drain();
      assert.equal(calls.filter((call) => call.url === runtime.slackWebhookUrl).length, 1);
    });
  });
});

test("rejects updates and deletes on the append-only store", async () => {
  await withTempDir(async (path) => {
    const storePath = join(path, "posts.sqlite");
    const store = new PostStore(storePath);
    store.appendEvent("activity", "{}");
    store.close();
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(storePath);
    assert.throws(() => db.exec("UPDATE events SET line = 'x'"), /append-only/);
    assert.throws(() => db.exec("DELETE FROM events"), /append-only/);
    db.close();
  });
});

test("re-fetches public_metrics once for non-retweet posts older than 24 hours", async () => {
  await withTempDir(async (path) => {
    const store = new PostStore(join(path, "posts.sqlite"));
    const old = "2026-09-01T00:00:00.000Z";
    store.appendObservation("1", "stream", { id: "1", text: "original" }, null, null, old);
    store.appendObservation(
      "2",
      "backfill",
      { id: "2", text: "RT", referenced_tweets: [{ type: "retweeted", id: "1" }] },
      null,
      null,
      old,
    );
    store.appendObservation("3", "stream", { id: "3", text: "fresh" }, null);
    store.appendObservation("4", "backfill", { id: "4", text: "deleted later" }, null, null, old);
    const urls: Array<string> = [];

    await withMockFetch(
      async (input) => {
        urls.push(String(input));
        return Response.json({
          data: [{ id: "1", text: "original", public_metrics: { like_count: 9 } }],
          errors: [{ resource_id: "4", title: "Not Found Error" }],
        });
      },
      async () => {
        assert.equal(await refetchMetrics(store, "x-token", Date.parse("2026-09-03T00:00:00Z")), 2);
        assert.equal(await refetchMetrics(store, "x-token", Date.parse("2026-09-03T00:00:00Z")), 0);
      },
    );

    assert.equal(urls.length, 1);
    assert.deepEqual(new URL(urls[0] ?? "").searchParams.get("ids")?.split(","), ["1", "4"]);
    assert.equal(new URL(urls[0] ?? "").searchParams.get("expansions"), null);
    assert.deepEqual(store.observations("1").at(-1)?.post.public_metrics, { like_count: 9 });
    assert.equal(store.observations("4").at(-1)?.post.unavailable, true);
    assert.equal(store.observations("2").length, 1);
    store.close();
  });
});
