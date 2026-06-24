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
    googleApiKey: null,
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
