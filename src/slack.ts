import type { XPost } from "./index.js";
import type { Hydrated } from "./ingest.js";
import { fullText } from "./x.js";

type Block = Record<string, unknown>;

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> => typeof item === "object" && item !== null,
      )
    : [];
}

function escape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function imageUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && value.length <= 3000 ? value : undefined;
  } catch {
    return undefined;
  }
}

export function slackPayload(post: XPost, hydrated?: Hydrated) {
  const url = `https://x.com/${encodeURIComponent(post.username)}/status/${encodeURIComponent(post.id)}`;
  const users = records(hydrated?.includes?.users);
  const tweets = records(hydrated?.includes?.tweets);
  const repost = records(hydrated?.post.referenced_tweets).find((ref) => ref.type === "retweeted");
  const original = tweets.find((tweet) => tweet.id === repost?.id);
  const data = original ?? hydrated?.post;
  const author = users.find((user) => user.id === data?.author_id);
  const username = typeof author?.username === "string" ? author.username : post.username;
  const name = typeof author?.name === "string" ? author.name : username;
  const full = (data ? fullText(data) : null) ?? post.text;
  const chars = Array.from(full);
  const clipped = chars.length > 320;
  const preview = clipped ? chars.slice(0, 319).join("").trimEnd() + "…" : full;
  const children: Block[] = [
    { type: "section", text: { type: "plain_text", text: preview || "Media post" } },
  ];
  const context = (text: string): Block => ({
    type: "context",
    elements: [{ type: "mrkdwn", text, verbatim: true }],
  });
  if (repost) children.push(context(`Reposted by @${escape(post.username)}`));
  const refs = records(data?.referenced_tweets);
  for (const ref of refs
    .filter((ref) => ref.type === "replied_to" || ref.type === "quoted")
    .slice(0, 2)) {
    if (typeof ref.id !== "string") continue;
    const referenced = tweets.find((tweet) => tweet.id === ref.id);
    const user = users.find((user) => user.id === referenced?.author_id);
    const label = typeof user?.username === "string" ? `@${escape(user.username)}` : "post";
    children.push(
      context(
        `${ref.type === "quoted" ? "Quoted" : "Replying to"} <https://x.com/i/status/${encodeURIComponent(ref.id)}|${label} · View post>`,
      ),
    );
  }
  const attachments = data?.attachments;
  const keys =
    typeof attachments === "object" &&
    attachments !== null &&
    "media_keys" in attachments &&
    Array.isArray(attachments.media_keys)
      ? attachments.media_keys
      : [];
  const media = records(hydrated?.includes?.media).filter((item) => keys.includes(item.media_key));
  if (data?.possibly_sensitive === true) {
    children.push(context(`<${url}|View sensitive media on X>`));
  } else {
    for (const item of media.slice(0, 4)) {
      const video = item.type === "video" || item.type === "animated_gif";
      const image = imageUrl(video ? item.preview_image_url : item.url);
      if (image)
        children.push({
          type: "image",
          image_url: image,
          alt_text:
            typeof item.alt_text === "string" && item.alt_text
              ? Array.from(item.alt_text).slice(0, 2000).join("")
              : `${video ? "Video preview" : "Photo"} from @${username}`,
        });
    }
    if (media.some((item) => item.type === "video" || item.type === "animated_gif"))
      children.push(context(`<${url}|Watch video on X>`));
  }
  const metrics = data?.public_metrics;
  const counts =
    typeof metrics === "object" && metrics !== null ? (metrics as Record<string, unknown>) : {};
  const stats = [
    typeof counts.like_count === "number" ? `${counts.like_count} likes` : null,
    typeof counts.retweet_count === "number" ? `${counts.retweet_count} reposts` : null,
  ].filter(Boolean);
  children.push(
    context([`<${url}|${clipped ? "Read full post on X" : "View on X"}>`, ...stats].join(" · ")),
  );
  const avatar = imageUrl(author?.profile_image_url);
  return {
    text: `${name} (@${username}): ${preview}\n${url}`,
    blocks: [
      {
        type: "container",
        title: { type: "plain_text", text: Array.from(name).slice(0, 150).join("") || username },
        subtitle: { type: "plain_text", text: `@${username}`.slice(0, 150) },
        icon: avatar
          ? { type: "image", image_url: avatar, alt_text: name.slice(0, 2000) || username }
          : undefined,
        width: "standard",
        has_header_divider: true,
        child_blocks: children,
      },
    ],
    unfurl_links: false,
    unfurl_media: false,
  };
}
