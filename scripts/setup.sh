#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${BEARER_TOKEN:-}" || $# -lt 2 ]]; then
  echo "Usage: BEARER_TOKEN=... $0 <webhook-id-or-worker-webhook-url> <handle> [handle ...]" >&2
  exit 1
fi

for command in curl jq; do
  command -v "$command" >/dev/null || {
    echo "$command is required" >&2
    exit 1
  }
done

webhook_ref=$1
shift

handles=()
for handle in "$@"; do
  handle=${handle#@}
  if [[ ! "$handle" =~ ^[A-Za-z0-9_]{1,15}$ ]]; then
    echo "Invalid X handle: $handle" >&2
    exit 1
  fi
  handles+=("$handle")
done

api=https://api.x.com/2
auth=(-H "Authorization: Bearer $BEARER_TOKEN")
json=(-H "Content-Type: application/json")
curl_args=(--fail-with-body --silent --show-error)
tag=tracked-profiles
event_type=post.create

if [[ "$webhook_ref" =~ ^[0-9]{1,19}$ ]]; then
  webhook_id=$webhook_ref
elif [[ "$webhook_ref" =~ ^https:// ]]; then
  webhooks=$(curl "${curl_args[@]}" "${auth[@]}" "$api/webhooks")
  webhook_id=$(jq -r --arg url "$webhook_ref" \
    '[.data[]? | select(.url == $url)][0].id // empty' <<<"$webhooks")

  if [[ -z "$webhook_id" ]]; then
    create_payload=$(jq -cn --arg url "$webhook_ref" '{url: $url}')
    created=$(curl "${curl_args[@]}" "${auth[@]}" "${json[@]}" \
      -X POST "$api/webhooks" -d "$create_payload")
    webhook_id=$(jq -r '.id // .data.id // empty' <<<"$created")
  fi

  if [[ -z "$webhook_id" ]]; then
    echo "X did not return a webhook ID" >&2
    exit 1
  fi
else
  echo "Webhook must be an X webhook ID or HTTPS Worker webhook URL" >&2
  exit 1
fi

user_ids=()
for handle in "${handles[@]}"; do
  user=$(curl "${curl_args[@]}" "${auth[@]}" "$api/users/by/username/$handle")
  user_id=$(jq -r '.data.id // empty' <<<"$user")
  if [[ -z "$user_id" ]]; then
    echo "X did not return a user ID for @$handle" >&2
    exit 1
  fi
  user_ids+=("$user_id")
done

desired_ids=$(printf '%s\n' "${user_ids[@]}" | jq -R . | jq -s .)
subscriptions=$(curl "${curl_args[@]}" "${auth[@]}" "$api/activity/subscriptions")

while IFS= read -r subscription_id; do
  [[ -z "$subscription_id" ]] && continue
  curl "${curl_args[@]}" "${auth[@]}" -X DELETE \
    "$api/activity/subscriptions/$subscription_id" >/dev/null
done < <(
  jq -r \
    --arg tag "$tag" \
    --arg event_type "$event_type" \
    --arg webhook_id "$webhook_id" \
    --argjson desired "$desired_ids" '
    (.data // [])
    | .[]
    | select(.event_type == $event_type and .tag == $tag)
    | select(
      (.filter.user_id // "") as $user_id
      | ($desired | index($user_id) | not) or ((.webhook_id // "") != $webhook_id)
    )
    | .subscription_id
  ' <<<"$subscriptions"
)

for index in "${!handles[@]}"; do
  handle=${handles[$index]}
  user_id=${user_ids[$index]}
  subscription_id=$(jq -r \
    --arg event_type "$event_type" \
    --arg user_id "$user_id" \
    --arg webhook_id "$webhook_id" '
      (.data // [])
      | .[]
      | select(.event_type == $event_type)
      | select(.filter.user_id == $user_id)
      | select((.webhook_id // "") == $webhook_id)
      | .subscription_id
    ' <<<"$subscriptions" | head -n 1)

  payload=$(jq -cn \
    --arg event_type "$event_type" \
    --arg user_id "$user_id" \
    --arg tag "$tag" \
    --arg webhook_id "$webhook_id" \
    '{
      event_type: $event_type,
      filter: {user_id: $user_id},
      tag: $tag,
      webhook_id: $webhook_id
    }')

  if [[ -n "$subscription_id" ]]; then
    update_payload=$(jq -cn --arg tag "$tag" --arg webhook_id "$webhook_id" \
      '{tag: $tag, webhook_id: $webhook_id}')
    curl "${curl_args[@]}" "${auth[@]}" "${json[@]}" \
      -X PUT "$api/activity/subscriptions/$subscription_id" \
      -d "$update_payload" >/dev/null
  else
    curl "${curl_args[@]}" "${auth[@]}" "${json[@]}" \
      -X POST "$api/activity/subscriptions" \
      -d "$payload" >/dev/null
  fi

  echo "Tracking @$handle ($user_id) via webhook $webhook_id"
done
