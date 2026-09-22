# Slack Tweet Forwarder

Forwards two real-time X sources into a Slack incoming webhook:

- X Activity `post.create` events for configured authors.
- Filtered Stream posts that directly mention configured accounts.

Both persistent streams feed one serialized processor, so a post matching both sources is classified, deduplicated, and sent to Slack once.

## Configuration

Non-secret settings live in [`config.json`](./config.json):

```json
{
  "tracking": {
    "authors": ["vishyfishy2"],
    "mentions": ["capydotai"]
  },
  "classifier": {
    "enabled": true,
    "prompt": null,
    "threshold": 0.7
  }
}
```

- `tracking.authors` controls X Activity `post.create` subscriptions.
- `tracking.mentions` controls the Filtered Stream `@handle` rule and runtime validation.
- `classifier.enabled` runs two checks before any model call, then Jev. A retweet whose original was forwarded or skipped in the last 24 hours is dropped. Posts from `capydotai` and `scrapybara` are forwarded without a model call. Everything else is kept when Jev's `keep` probability is at least `classifier.threshold` (default 0.7).
- `classifier.prompt: null` uses the built-in Jev question. A string replaces that question's instructions.

The process only reads secrets from environment variables:

- `X_BEARER_TOKEN`
- `SLACK_WEBHOOK_URL`
- `AI_GATEWAY_API_KEY` when classification is enabled. This is the Vercel AI Gateway key. The model id is `typesafe-ai/jev`.
- `CAPY_TWEETS_QUIET_WEBHOOK_URL` optional. Dropped and unclassified posts go here instead of the main channel. Unset means those posts are not sent to Slack.

## Configure X

Reconcile X Activity subscriptions and the owned Filtered Stream mention rule from `config.json`:

```sh
BEARER_TOKEN=... ./scripts/setup.sh
```

The script removes the repository's legacy `tracked-profiles` Filtered Stream rule, preserves unrelated rules, and manages the mention rule under the `slack-tweet-forwarder:mentions` tag.

## Run on a VPS

```sh
pnpm install
pnpm build

X_BEARER_TOKEN=... \
SLACK_WEBHOOK_URL=... \
AI_GATEWAY_API_KEY=... \
CAPY_TWEETS_QUIET_WEBHOOK_URL=... \
pnpm start
```

## Docker

```sh
docker build -t slack-tweet-forwarder .
docker run -d --name slack-tweet-forwarder --restart unless-stopped \
  -e X_BEARER_TOKEN=... \
  -e SLACK_WEBHOOK_URL=... \
  -e AI_GATEWAY_API_KEY=... \
  -e CAPY_TWEETS_QUIET_WEBHOOK_URL=... \
  -v slack-tweet-forwarder-data:/app/data \
  slack-tweet-forwarder
```

The Docker volume stores `data/dedupe.json`, whose entries expire after 24 hours, and `data/held.jsonl` for posts held because Jev was down. A held post is not forwarded and is not deduped, so a later delivery of the same id is classified again. Set `AI_GATEWAY_API_KEY` before starting the container. Without it, only official-account posts are forwarded.
