#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${BEARER_TOKEN:-}" || $# -lt 2 ]]; then
  echo "Usage: BEARER_TOKEN=... $0 <worker-webhook-url> <handle> [handle ...]" >&2
  exit 1
fi

for command in curl jq; do
  command -v "$command" >/dev/null || {
    echo "$command is required" >&2
    exit 1
  }
done

webhook_url=$1
shift

if [[ ! "$webhook_url" =~ ^https:// ]]; then
  echo "Worker webhook URL must use HTTPS" >&2
  exit 1
fi

handles=()
for handle in "$@"; do
  handle=${handle#@}
  if [[ ! "$handle" =~ ^[A-Za-z0-9_]{1,15}$ ]]; then
    echo "Invalid X handle: $handle" >&2
    exit 1
  fi
  handles+=("$handle")
done

rule=
for handle in "${handles[@]}"; do
  [[ -n "$rule" ]] && rule+=" OR "
  rule+="from:$handle"
done

if (( ${#rule} > 512 )); then
  echo "Filtered stream rule exceeds the 512-character limit" >&2
  exit 1
fi

api=https://api.x.com/2
auth=(-H "Authorization: Bearer $BEARER_TOKEN")
json=(-H "Content-Type: application/json")
curl_args=(--fail-with-body --silent --show-error)
rules_url="$api/tweets/search/stream/rules"

rules=$(curl "${curl_args[@]}" "${auth[@]}" "$rules_url")
delete_payload=$(jq -c '{delete: {ids: [.data[]?.id]}}' <<<"$rules")
if (( $(jq '.delete.ids | length' <<<"$delete_payload") > 0 )); then
  curl "${curl_args[@]}" "${auth[@]}" "${json[@]}" \
    -X POST "$rules_url" -d "$delete_payload" >/dev/null
fi

add_payload=$(jq -cn --arg value "$rule" \
  '{add: [{value: $value, tag: "tracked-profiles"}]}')
curl "${curl_args[@]}" "${auth[@]}" "${json[@]}" \
  -X POST "$rules_url" -d "$add_payload" >/dev/null

webhooks=$(curl "${curl_args[@]}" "${auth[@]}" "$api/webhooks")
webhook_id=$(jq -r --arg url "$webhook_url" \
  '[.data[]? | select(.url == $url)][0].id // empty' <<<"$webhooks")

if [[ -z "$webhook_id" ]]; then
  create_payload=$(jq -cn --arg url "$webhook_url" '{url: $url}')
  created=$(curl "${curl_args[@]}" "${auth[@]}" "${json[@]}" \
    -X POST "$api/webhooks" -d "$create_payload")
  webhook_id=$(jq -r '.id // .data.id // empty' <<<"$created")
  if [[ -z "$webhook_id" ]]; then
    echo "X did not return a webhook ID" >&2
    exit 1
  fi
fi

links=$(curl "${curl_args[@]}" "${auth[@]}" "$api/tweets/search/webhooks")
linked=$(jq -r --arg id "$webhook_id" \
  'any(.data.links[]?; .webhook_id == $id)' <<<"$links")
if [[ "$linked" != true ]]; then
  curl "${curl_args[@]}" "${auth[@]}" -X POST \
    "$api/tweets/search/webhooks/$webhook_id?expansions=author_id&user.fields=username,name,id&tweet.fields=created_at" \
    >/dev/null
fi

echo "Tracking ${handles[*]} via webhook $webhook_id"
