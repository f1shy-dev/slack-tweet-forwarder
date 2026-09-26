# Slack Tweet Forwarder

Forwards two real-time X sources into a Slack incoming webhook:

- X Activity `post.create` events for configured authors.
- Filtered Stream posts that directly mention configured accounts.

Every stream line is appended to a SQLite store before anything else happens. A single forwarder then reads the store in order, hydrates each post from the X API, and applies the existing selection, dedupe, and Slack post, so a post matching both sources is sent to Slack once.

## Post store

The store lives at `data/posts.sqlite` (override with `STORE_PATH`) on the same volume as the dedupe file. Its three tables are append-only; SQLite triggers reject every `UPDATE` and `DELETE`.

- `events`: every raw line either stream delivered, with its source and receive time, including events the forwarder ignores and lines that are not valid JSON.
- `observations`: one row per fetch of a post, holding the full X object (`id`, `text`, `note_tweet`, `author_id`, `created_at`, `conversation_id`, `in_reply_to_user_id`, `referenced_tweets`, `entities`, `attachments.media_keys`, `public_metrics`, and more), the referenced posts, authors, and media from `includes`, and `fetched_at`. `source` is `stream` (hydrated on arrival), `backfill`, or `refetch`.
- `deliveries`: the forwarder's outcome per stored event (`posted`, `duplicate`, `ignored`, `unresolved`, `unparsed`, `failed`, or a classifier outcome). The highest delivered event is the forwarder's cursor, so events stored while the process was down are forwarded on restart.

Every 15 minutes the process re-hydrates stream posts whose first lookup failed during the last 24 hours, and re-fetches `public_metrics` once for every non-retweet post first seen at least 24 hours earlier.

SQLite was chosen over JSONL per day because the forwarder needs an ordered cursor, dedupe-by-id lookups, and a 24-hour re-fetch query, and export needs a join between first sight, re-fetch, and delivery; one WAL-mode file on the existing volume does all of that without a dependency (`node:sqlite`).

## Store commands

Run these inside the container, for example `docker exec slack-tweet-forwarder node dist/cli.js stats`:

- `backfill [--days 7] [--max-posts 2000]` pulls posts matching the stream rules (`@mention OR from:author ...`) from `GET /2/tweets/search/recent`, which only reaches the last 7 days, and stores them with source `backfill`. It never posts to Slack. It prints pages, posts returned, unique users, and a cost estimate at $0.005 per post read and $0.010 per user read.
- `refetch` runs the 24-hour `public_metrics` re-fetch once.
- `export [--posted-only] [--since ISO] [--labels user-labels.json] [--out file]` writes JSONL in the labelling app's row shape (`index`, `id`, `username`, `text`, `context_missing`, `observed_at`, `source`, `label`), newest first, with the stored X object, first fetch, Slack post time, and 24-hour metrics under `x`. `--labels` joins a labelling-app `user-labels.json` by post ID into `human_label`.
- `replay [--since ISO] [--until ISO]` prints, as JSONL, what the forwarder's selection and dedupe decide for each stored stream event. It never posts to Slack.
- `stats` prints row counts.

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

The Docker volume stores `data/dedupe.json`, whose entries expire after 24 hours, and the append-only `data/posts.sqlite`.
