# Slack Tweet Forwarder

`X Activity API subscriptions → persistent Node stream consumer → optional Gemini classifier → Slack incoming webhook`

## Run on a VPS

```sh
pnpm install
pnpm build

X_BEARER_TOKEN=... \
SLACK_WEBHOOK_URL=... \
GOOGLE_GENERATIVE_AI_API_KEY=... \
pnpm start
```

`GOOGLE_GENERATIVE_AI_API_KEY` is needed while classification is enabled. To start without it for testing, create `data/classifier-config.json` with `enabled: false`.

## Docker

```sh
mkdir -p data
sudo chown -R 1000:1000 data
docker build -t slack-tweet-forwarder .
docker run -d --name slack-tweet-forwarder --restart unless-stopped \
  -e X_BEARER_TOKEN=... \
  -e SLACK_WEBHOOK_URL=... \
  -e GOOGLE_GENERATIVE_AI_API_KEY=... \
  -v "$PWD/data:/app/data" \
  slack-tweet-forwarder
```

Optional paths:

- `CONFIG_PATH` defaults to `/app/data/classifier-config.json` in Docker and `data/classifier-config.json` locally.
- `DEDUPE_PATH` defaults to `/app/data/dedupe.json` in Docker and `data/dedupe.json` locally.

## Track profiles

Create or replace X Activity API `post.create` subscriptions for the handles you want on the persistent stream:

```sh
BEARER_TOKEN=... ./scripts/setup.sh handle1 handle2
```

Rerunning `setup.sh` with a new handle list replaces the tracked profiles tagged `tracked-profiles`.

## Classifier config

The app creates this JSON file on first start if it is missing:

```json
{
  "enabled": true,
  "prompt": null
}
```

Use `prompt: null` for the built-in prompt, set a string to override it, or set `enabled: false` to forward without AI classification while testing:

```sh
mkdir -p data
printf '%s\n' '{"enabled":false,"prompt":null}' > data/classifier-config.json
```
