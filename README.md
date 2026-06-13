# Slack Tweet Forwarder

`X Activity API post.create subscriptions → Cloudflare Worker → configurable Gemini classifier → Slack incoming webhook`

## Deploy

```sh
pnpm install
pnpm wrangler kv namespace create DEDUPE_KV
pnpm wrangler secret put X_CONSUMER_SECRET
pnpm wrangler secret put X_BEARER_TOKEN
pnpm wrangler secret put SLACK_WEBHOOK_URL
pnpm wrangler secret put GOOGLE_GENERATIVE_AI_API_KEY
pnpm deploy
```

Copy the KV namespace `id` from `wrangler kv namespace create` into `wrangler.jsonc`.
`X_CONSUMER_SECRET` is the X app consumer secret (API secret key), not its bearer token.
`X_BEARER_TOKEN` is the app-only bearer token used only as a fallback when an activity event does not include full post data.
`GOOGLE_GENERATIVE_AI_API_KEY` is configured as a required secret; classification can still be turned off in KV while testing.

## Track profiles

The Worker must be deployed before registering a webhook because X immediately sends a CRC request. Pass the webhook ID from the X dashboard, or pass the Worker webhook URL and the script will reuse/register it if your app can call the Webhooks API.

```sh
BEARER_TOKEN=... ./scripts/setup.sh \
  2065826940074729473 \
  handle1 handle2
```

Rerunning `setup.sh` with a new handle list replaces the tracked profiles.

## Classifier config

The Worker creates `config:classifier` in `DEDUPE_KV` if it is missing:

```json
{
  "enabled": true,
  "prompt": null
}
```

Use `prompt: null` for the built-in prompt, set a string to override it, or set `enabled: false` to forward without classification while testing:

```sh
pnpm wrangler kv key put config:classifier '{"enabled":false,"prompt":null}' \
  --binding DEDUPE_KV --remote
```
