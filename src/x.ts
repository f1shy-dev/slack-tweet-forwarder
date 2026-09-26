export const xApiBaseUrl = "https://api.x.com/2";

export const tweetFields = [
  "id",
  "text",
  "author_id",
  "created_at",
  "conversation_id",
  "in_reply_to_user_id",
  "referenced_tweets",
  "entities",
  "attachments",
  "public_metrics",
  "note_tweet",
  "lang",
  "possibly_sensitive",
  "reply_settings",
  "edit_history_tweet_ids",
].join(",");

export const expansions = [
  "author_id",
  "referenced_tweets.id",
  "referenced_tweets.id.author_id",
  "attachments.media_keys",
  "in_reply_to_user_id",
].join(",");

export const mediaFields = [
  "media_key",
  "type",
  "url",
  "preview_image_url",
  "alt_text",
  "width",
  "height",
  "duration_ms",
  "variants",
].join(",");

export const userFields = [
  "id",
  "name",
  "username",
  "verified",
  "verified_type",
  "description",
  "created_at",
  "profile_image_url",
  "public_metrics",
].join(",");

export type XPage = {
  posts: Array<Record<string, unknown>>;
  includes: Record<string, unknown> | null;
  nextToken: string | null;
  errors: Array<unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function setFields(url: URL, withExpansions: boolean): void {
  url.searchParams.set("tweet.fields", tweetFields);
  if (withExpansions) {
    url.searchParams.set("expansions", expansions);
    url.searchParams.set("media.fields", mediaFields);
    url.searchParams.set("user.fields", userFields);
  }
}

async function getPage(url: URL, bearerToken: string): Promise<XPage> {
  const response = await fetch(url, { headers: { authorization: `Bearer ${bearerToken}` } });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`X ${url.pathname} returned ${response.status}: ${text.slice(0, 500)}`);
  }

  const body: unknown = await response.json();
  if (!isRecord(body)) {
    return { posts: [], includes: null, nextToken: null, errors: [] };
  }

  const meta = isRecord(body.meta) ? body.meta : null;
  return {
    posts: Array.isArray(body.data) ? body.data.filter(isRecord) : [],
    includes: isRecord(body.includes) ? body.includes : null,
    nextToken: meta !== null && typeof meta.next_token === "string" ? meta.next_token : null,
    errors: Array.isArray(body.errors) ? body.errors : [],
  };
}

export async function lookupPosts(
  ids: ReadonlyArray<string>,
  bearerToken: string,
  withExpansions = true,
  baseUrl = xApiBaseUrl,
): Promise<XPage> {
  const url = new URL(`${baseUrl}/tweets`);
  url.searchParams.set("ids", ids.join(","));
  setFields(url, withExpansions);
  return getPage(url, bearerToken);
}

export async function searchRecent(
  query: string,
  startTime: string,
  nextToken: string | null,
  bearerToken: string,
  baseUrl = xApiBaseUrl,
): Promise<XPage> {
  const url = new URL(`${baseUrl}/tweets/search/recent`);
  url.searchParams.set("query", query);
  url.searchParams.set("start_time", startTime);
  url.searchParams.set("max_results", "100");
  setFields(url, true);
  if (nextToken !== null) {
    url.searchParams.set("next_token", nextToken);
  }
  return getPage(url, bearerToken);
}

export function includesFor(
  post: Record<string, unknown>,
  includes: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (includes === null) {
    return null;
  }

  const referencedIds = new Set(
    (Array.isArray(post.referenced_tweets) ? post.referenced_tweets : [])
      .map((ref) => (isRecord(ref) && typeof ref.id === "string" ? ref.id : null))
      .filter((id): id is string => id !== null),
  );
  const tweets = (Array.isArray(includes.tweets) ? includes.tweets : []).filter(
    (tweet) => isRecord(tweet) && typeof tweet.id === "string" && referencedIds.has(tweet.id),
  );
  const tweetList = [post, ...tweets.filter(isRecord)];
  const userIds = new Set(
    tweetList
      .flatMap((tweet) => [tweet.author_id, tweet.in_reply_to_user_id])
      .filter((id): id is string => typeof id === "string"),
  );
  const mediaKeys = new Set(
    tweetList.flatMap((tweet) =>
      isRecord(tweet.attachments) && Array.isArray(tweet.attachments.media_keys)
        ? tweet.attachments.media_keys.filter((key): key is string => typeof key === "string")
        : [],
    ),
  );
  return {
    users: (Array.isArray(includes.users) ? includes.users : []).filter(
      (user) => isRecord(user) && typeof user.id === "string" && userIds.has(user.id),
    ),
    tweets,
    media: (Array.isArray(includes.media) ? includes.media : []).filter(
      (media) =>
        isRecord(media) && typeof media.media_key === "string" && mediaKeys.has(media.media_key),
    ),
  };
}

export function authorUsername(
  post: Record<string, unknown>,
  includes: Record<string, unknown> | null,
): string | null {
  const users = includes !== null && Array.isArray(includes.users) ? includes.users : [];
  const author = users.find((user) => isRecord(user) && user.id === post.author_id);
  return isRecord(author) && typeof author.username === "string" ? author.username : null;
}

export function fullText(post: Record<string, unknown>): string | null {
  const note = isRecord(post.note_tweet) ? post.note_tweet.text : null;
  if (typeof note === "string" && note.length > 0) {
    return note;
  }

  return typeof post.text === "string" ? post.text : null;
}
