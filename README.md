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
    "enabled": false,
    "prompt": null
  }
}
```

- `tracking.authors` controls X Activity `post.create` subscriptions.
- `tracking.mentions` controls the Filtered Stream `@handle` rule and runtime validation.
- `classifier.prompt: null` uses the built-in prompt when classification is enabled.

The process only reads secrets from environment variables:

- `X_BEARER_TOKEN`
- `SLACK_WEBHOOK_URL`
- `GOOGLE_GENERATIVE_AI_API_KEY` when classification is enabled

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
GOOGLE_GENERATIVE_AI_API_KEY=... \
pnpm start
```

## Docker

```sh
docker build -t slack-tweet-forwarder .
docker run -d --name slack-tweet-forwarder --restart unless-stopped \
  -e X_BEARER_TOKEN=... \
  -e SLACK_WEBHOOK_URL=... \
  -e GOOGLE_GENERATIVE_AI_API_KEY=... \
  -v slack-tweet-forwarder-data:/app/data \
  slack-tweet-forwarder
```

The Docker volume only stores `data/dedupe.json`, whose entries expire after 24 hours.
