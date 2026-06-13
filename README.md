# Slack Tweet Forwarder

`X Filtered Stream rules → Filtered Stream Webhooks → Cloudflare Worker → Gemini classifier → Slack incoming webhook`

## Deploy

```sh
pnpm install
pnpm wrangler kv namespace create DEDUPE_KV
pnpm wrangler secret put X_CONSUMER_SECRET
pnpm wrangler secret put SLACK_WEBHOOK_URL
pnpm wrangler secret put GOOGLE_GENERATIVE_AI_API_KEY
pnpm deploy
```

Copy the KV namespace `id` from `wrangler kv namespace create` into `wrangler.jsonc`.
`X_CONSUMER_SECRET` is the X app consumer secret (API secret key), not its bearer token.
`GOOGLE_GENERATIVE_AI_API_KEY` is required; every post is classified before Slack delivery.

## Track profiles

The Worker must be deployed before setup because X immediately sends a CRC request when registering the webhook.

```sh
BEARER_TOKEN=... ./scripts/setup.sh \
  https://slack-tweet-forwarder.example.workers.dev/webhook \
  handle1 handle2
```

Rerunning `setup.sh` with a new handle list replaces the tracked profiles.
