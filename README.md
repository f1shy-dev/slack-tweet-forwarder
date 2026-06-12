# Slack Tweet Forwarder

`X Filtered Stream rules → Filtered Stream Webhooks → Cloudflare Worker → Slack incoming webhook`

## Deploy

```sh
pnpm install
pnpm wrangler secret put X_CONSUMER_SECRET
pnpm wrangler secret put SLACK_WEBHOOK_URL
pnpm deploy
```

`X_CONSUMER_SECRET` is the X app consumer secret (API secret key), not its bearer token.

## Track profiles

The Worker must be deployed before setup because X immediately sends a CRC request when registering the webhook.

```sh
BEARER_TOKEN=... ./scripts/setup.sh \
  https://slack-tweet-forwarder.example.workers.dev/webhook \
  handle1 handle2
```

Rerunning `setup.sh` with a new handle list replaces the tracked profiles.
