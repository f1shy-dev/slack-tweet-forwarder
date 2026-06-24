#!/usr/bin/env bash
set -euo pipefail

config_path=${1:-config.json}

if [[ -z "${BEARER_TOKEN:-}" ]]; then
  echo "Usage: BEARER_TOKEN=... $0 [config-path]" >&2
  exit 1
fi

for command in curl jq; do
  command -v "$command" >/dev/null || {
    echo "$command is required" >&2
    exit 1
  }
done

if [[ ! -f "$config_path" ]]; then
  echo "Config file does not exist: $config_path" >&2
  exit 1
fi

author_handles=()
while IFS= read -r handle; do
  author_handles+=("$handle")
done < <(jq -er '.tracking.authors[]' "$config_path")

mention_handles=()
while IFS= read -r handle; do
  mention_handles+=("$handle")
done < <(jq -er '.tracking.mentions[]' "$config_path")

validate_handles() {
  local label=$1
  shift

  if (( $# == 0 )); then
    echo "$label must contain at least one handle" >&2
    exit 1
  fi

  local handle
  for handle in "$@"; do
    if [[ ! "$handle" =~ ^[A-Za-z0-9_]{1,15}$ ]]; then
      echo "Invalid X handle in $label: $handle" >&2
      exit 1
    fi
  done
}

validate_handles tracking.authors "${author_handles[@]}"
validate_handles tracking.mentions "${mention_handles[@]}"

api=https://api.x.com/2
auth=(-H "Authorization: Bearer $BEARER_TOKEN")
json=(-H "Content-Type: application/json")
activity_tag=tracked-profiles
activity_event_type=post.create
mention_tag=slack-tweet-forwarder:mentions
legacy_filtered_tag=tracked-profiles
rules_url="$api/tweets/search/stream/rules"

x_request() {
  local method=$1
  local url=$2
  local body=${3:-}
  local response
  local status
  local curl_status
  response=$(mktemp)

  set +e
  if [[ -n "$body" ]]; then
    status=$(curl --silent --show-error --output "$response" --write-out "%{http_code}" \
      "${auth[@]}" "${json[@]}" -X "$method" "$url" -d "$body")
    curl_status=$?
  else
    status=$(curl --silent --show-error --output "$response" --write-out "%{http_code}" \
      "${auth[@]}" -X "$method" "$url")
    curl_status=$?
  fi
  set -e

  if (( curl_status != 0 )); then
    echo "X API request failed before receiving an HTTP response: $method $url" >&2
    [[ -s "$response" ]] && cat "$response" >&2
    rm -f "$response"
    exit 1
  fi

  if (( status < 200 || status >= 300 )); then
    echo "X API request failed ($status): $method $url" >&2
    if [[ -s "$response" ]]; then
      jq . "$response" >&2 || cat "$response" >&2
    fi
    rm -f "$response"
    exit 1
  fi

  cat "$response"
  rm -f "$response"
}

user_ids=()
for handle in "${author_handles[@]}"; do
  user=$(x_request GET "$api/users/by/username/$handle")
  user_id=$(jq -r '.data.id // empty' <<<"$user")
  if [[ -z "$user_id" ]]; then
    echo "X did not return a user ID for @$handle" >&2
    exit 1
  fi
  user_ids+=("$user_id")
done

desired_ids=$(printf '%s\n' "${user_ids[@]}" | jq -R . | jq -s .)
subscriptions=$(x_request GET "$api/activity/subscriptions")

while IFS= read -r subscription_id; do
  [[ -z "$subscription_id" ]] && continue
  x_request DELETE "$api/activity/subscriptions/$subscription_id" >/dev/null
done < <(
  jq -r \
    --arg tag "$activity_tag" \
    --arg event_type "$activity_event_type" \
    --argjson desired "$desired_ids" '
    (.data // [])
    | .[]
    | select(.event_type == $event_type and .tag == $tag)
    | select(
      ((.filter.user_id // "") as $user_id | $desired | index($user_id) | not)
      or (.webhook_id? != null)
    )
    | .subscription_id
  ' <<<"$subscriptions"
)

for index in "${!author_handles[@]}"; do
  handle=${author_handles[$index]}
  user_id=${user_ids[$index]}
  subscription_id=$(jq -r \
    --arg event_type "$activity_event_type" \
    --arg user_id "$user_id" \
    --arg tag "$activity_tag" '
      (.data // [])
      | .[]
      | select(.event_type == $event_type)
      | select(.filter.user_id == $user_id)
      | select((.tag // "") == $tag)
      | select(.webhook_id? == null)
      | .subscription_id
    ' <<<"$subscriptions" | head -n 1)

  if [[ -n "$subscription_id" ]]; then
    payload=$(jq -cn --arg tag "$activity_tag" '{tag: $tag}')
    x_request PUT "$api/activity/subscriptions/$subscription_id" "$payload" >/dev/null
  else
    payload=$(jq -cn \
      --arg event_type "$activity_event_type" \
      --arg user_id "$user_id" \
      --arg tag "$activity_tag" \
      '{event_type: $event_type, filter: {user_id: $user_id}, tag: $tag}')
    x_request POST "$api/activity/subscriptions" "$payload" >/dev/null
  fi

  echo "Tracking authored posts from @$handle ($user_id)"
done

mention_rule=$(printf '@%s\n' "${mention_handles[@]}" | paste -sd'|' - | sed 's/|/ OR /g')
if (( ${#mention_rule} > 1024 )); then
  echo "Mention rule exceeds X's 1024-character limit" >&2
  exit 1
fi

rules=$(x_request GET "$rules_url")
delete_payload=$(jq -cn \
  --arg tag "$mention_tag" \
  --arg legacy_tag "$legacy_filtered_tag" \
  --arg value "$mention_rule" \
  --argjson rules "$(jq '.data // []' <<<"$rules")" '
    {delete: {ids: [
      $rules[]
      | select(
          .tag == $legacy_tag
          or (.tag == $tag and .value != $value)
        )
      | .id
    ]}}
  ')

if (( $(jq '.delete.ids | length' <<<"$delete_payload") > 0 )); then
  x_request POST "$rules_url" "$delete_payload" >/dev/null
fi

has_mention_rule=$(jq -r \
  --arg tag "$mention_tag" \
  --arg value "$mention_rule" \
  'any(.data[]?; .tag == $tag and .value == $value)' <<<"$rules")
if [[ "$has_mention_rule" != true ]]; then
  add_payload=$(jq -cn \
    --arg tag "$mention_tag" \
    --arg value "$mention_rule" \
    '{add: [{value: $value, tag: $tag}]}')
  x_request POST "$rules_url" "$add_payload" >/dev/null
fi

for handle in "${mention_handles[@]}"; do
  echo "Tracking direct mentions of @$handle"
done
