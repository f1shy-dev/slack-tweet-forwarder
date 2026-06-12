const encoder = new TextEncoder();

type XEvent = {
  data: {
    id: string;
    text: string;
    author_id: string;
  };
  includes: {
    users: Array<{
      id: string;
      name: string;
      username: string;
    }>;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isXEvent(value: unknown): value is XEvent {
  if (!isRecord(value) || !isRecord(value.data) || !isRecord(value.includes)) {
    return false;
  }

  const { data, includes } = value;
  return (
    typeof data.id === "string" &&
    typeof data.text === "string" &&
    typeof data.author_id === "string" &&
    Array.isArray(includes.users) &&
    includes.users.every(
      (user) =>
        isRecord(user) &&
        typeof user.id === "string" &&
        typeof user.name === "string" &&
        typeof user.username === "string",
    )
  );
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

function slackMessage(event: XEvent, username: string): string {
  const text = escapeMrkdwn(event.data.text).replaceAll("\n", "\n>");
  const link = `https://x.com/${encodeURIComponent(username)}/status/${encodeURIComponent(event.data.id)}`;
  return `*@${escapeMrkdwn(username)}* posted\n>${text}\n${link}`;
}

async function forwardToSlack(
  event: XEvent,
  username: string,
  webhookUrl: string,
  requestUrl: string,
): Promise<void> {
  const cacheKey = new Request(
    new URL(`/webhook/dedupe/${encodeURIComponent(event.data.id)}`, requestUrl),
  );

  try {
    if (await caches.default.match(cacheKey)) {
      return;
    }
  } catch {
    // Cache API deduplication is best-effort.
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: slackMessage(event, username) }),
  });

  if (!response.ok) {
    throw new Error(`Slack webhook returned ${response.status}`);
  }

  try {
    await caches.default.put(
      cacheKey,
      new Response(null, {
        headers: { "cache-control": "max-age=86400" },
      }),
    );
  } catch {
    // Cache API deduplication is best-effort.
  }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/webhook") {
      return new Response("Not found", { status: 404 });
    }

    if (request.method === "GET") {
      const token = url.searchParams.get("crc_token");
      return token === null
        ? new Response("Missing crc_token", { status: 400 })
        : crcResponse(token, env.X_CONSUMER_SECRET);
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
      event = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    if (!isXEvent(event)) {
      return new Response("Invalid event", { status: 400 });
    }

    const user = event.includes.users.find(({ id }) => id === event.data.author_id);
    if (user !== undefined) {
      ctx.waitUntil(forwardToSlack(event, user.username, env.SLACK_WEBHOOK_URL, request.url));
    }

    return new Response("OK");
  },
} satisfies ExportedHandler<Env>;
