import type { ObservationSource, PostStore } from "./store.js";
import { includesFor, lookupPosts, xApiBaseUrl } from "./x.js";

export const refetchAgeMs = 24 * 60 * 60 * 1000;
const lookupBatchSize = 100;

export type Hydrated = {
  post: Record<string, unknown>;
  includes: Record<string, unknown> | null;
};

function chunks<T>(values: ReadonlyArray<T>, size: number): Array<Array<T>> {
  return Array.from({ length: Math.ceil(values.length / size) }, (_, index) =>
    values.slice(index * size, index * size + size),
  );
}

export async function hydratePosts(
  store: PostStore,
  ids: ReadonlyArray<string>,
  source: ObservationSource,
  eventSeq: number | null,
  bearerToken: string,
  baseUrl = xApiBaseUrl,
): Promise<Map<string, Hydrated>> {
  const hydrated = new Map<string, Hydrated>();
  for (const batch of chunks([...new Set(ids)], lookupBatchSize)) {
    const page = await lookupPosts(batch, bearerToken, true, baseUrl);
    for (const post of page.posts) {
      if (typeof post.id !== "string") {
        continue;
      }
      const includes = includesFor(post, page.includes);
      store.appendObservation(post.id, source, post, includes, eventSeq);
      hydrated.set(post.id, { post, includes });
    }
  }

  return hydrated;
}

export async function rehydrateEvents(
  store: PostStore,
  bearerToken: string,
  baseUrl = xApiBaseUrl,
): Promise<number> {
  const pending = store.unhydratedEventPosts(
    new Date(Date.now() - refetchAgeMs).toISOString(),
    lookupBatchSize,
  );
  let count = 0;
  for (const { postId, eventSeq } of pending) {
    const hydrated = await hydratePosts(store, [postId], "stream", eventSeq, bearerToken, baseUrl);
    count += hydrated.size;
  }

  return count;
}

export async function refetchMetrics(
  store: PostStore,
  bearerToken: string,
  now = Date.now(),
  baseUrl = xApiBaseUrl,
): Promise<number> {
  const cutoff = new Date(now - refetchAgeMs).toISOString();
  let count = 0;
  for (;;) {
    const ids = store.refetchDue(cutoff, lookupBatchSize);
    if (ids.length === 0) {
      return count;
    }

    const page = await lookupPosts(ids, bearerToken, false, baseUrl);
    const returned = new Set<string>();
    for (const post of page.posts) {
      if (typeof post.id === "string") {
        store.appendObservation(post.id, "refetch", post, null);
        returned.add(post.id);
      }
    }
    for (const id of ids.filter((id) => !returned.has(id))) {
      const errors = page.errors.filter(
        (error) =>
          typeof error === "object" &&
          error !== null &&
          "resource_id" in error &&
          error.resource_id === id,
      );
      store.appendObservation(id, "refetch", { id, unavailable: true, errors }, null);
    }
    count += ids.length;
  }
}
