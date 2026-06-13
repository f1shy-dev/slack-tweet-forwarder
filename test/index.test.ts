import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  candidatesFromActivityEvent,
  DedupeStore,
  getClassifierConfig,
  processActivityEvent,
  slackMessage,
  streamLines,
  type Env,
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

async function createEnv(path: string, config: unknown): Promise<Env> {
  const configPath = join(path, "classifier-config.json");
  await writeFile(configPath, `${JSON.stringify(config)}\n`);
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

test("extracts the captured X Activity post.create stream payload", () => {
  assert.deepEqual(candidatesFromActivityEvent(sampleEvent), [
    {
      id: "2065839641417138368",
      text: "meow",
      username: "vishyfishy2",
    },
  ]);
});

test("escapes Slack mrkdwn and blockquotes multiline post text", () => {
  assert.equal(
    slackMessage({
      id: "123",
      username: "fish&chips",
      text: "one & <two>\nthree",
    }),
    "*@fish&amp;chips* posted\n>one &amp; &lt;two&gt;\n>three\nhttps://x.com/fish%26chips/status/123",
  );
});

test("creates default classifier config when missing", async () => {
  await withTempDir(async (path) => {
    const configPath = join(path, "classifier-config.json");
    assert.deepEqual(await getClassifierConfig(configPath), { enabled: true, prompt: null });
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), {
      enabled: true,
      prompt: null,
    });
  });
});

test("forwards a captured stream post when classification is disabled and suppresses duplicates", async () => {
  await withTempDir(async (path) => {
    const env = await createEnv(path, { enabled: false, prompt: null });
    const dedupe = await loadDedupe(path);
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
        await processActivityEvent(sampleEvent, env, dedupe);
        await processActivityEvent(sampleEvent, env, dedupe);
      },
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, env.slackWebhookUrl);
    assert.deepEqual(JSON.parse(calls[0]?.body ?? ""), {
      text: "*@vishyfishy2* posted\n>meow\nhttps://x.com/vishyfishy2/status/2065839641417138368",
    });
    const dedupeFile: unknown = JSON.parse(await readFile(env.dedupePath, "utf8"));
    assert.equal(typeof dedupeFile, "object");
    assert.notEqual(dedupeFile, null);
    assert.equal(
      typeof (dedupeFile as Record<string, unknown>)["post:2065839641417138368"],
      "number",
    );
  });
});

test("does not forward unclassified posts when classification is enabled without a Google key", async () => {
  await withTempDir(async (path) => {
    const env = await createEnv(path, { enabled: true, prompt: null });
    const dedupe = await loadDedupe(path);
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
        await processActivityEvent(sampleEvent, env, dedupe);
      },
    );

    assert.deepEqual(calls, []);
  });
});

test("looks up incomplete stream events before forwarding", async () => {
  await withTempDir(async (path) => {
    const env = await createEnv(path, { enabled: false, prompt: null });
    const dedupe = await loadDedupe(path);
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
        await processActivityEvent(event, env, dedupe);
      },
    );

    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.method, "GET");
    assert.match(calls[0]?.url ?? "", /^https:\/\/api\.x\.com\/2\/tweets\/42\?/);
    assert.equal(calls[1]?.url, env.slackWebhookUrl);
    assert.deepEqual(JSON.parse(calls[1]?.body ?? ""), {
      text: "*@lookup_user* posted\n>lookup text\nhttps://x.com/lookup_user/status/42",
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
