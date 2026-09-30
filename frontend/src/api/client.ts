import type {
  Catalog, MemberView, Overlap, Preview, Profile, Row, Segment, SegmentDefinition, Template,
} from "./types";

export class ApiError extends Error {
  constructor(public status: number, message: string, public path?: string) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    let detail = res.statusText;
    let path: string | undefined;
    try {
      const data = await res.json();
      path = data.path;
      detail = typeof data.detail === "string" ? data.detail
        : Array.isArray(data.detail) ? data.detail.map((d: { msg: string }) => d.msg).join("; ")
        : detail;
    } catch { /* not json */ }
    throw new ApiError(res.status, detail, path);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export interface SegmentInput {
  name: string;
  description: string;
  tags: string[];
  definition: SegmentDefinition;
}

export const api = {
  catalog: () => request<Catalog>("GET", "/api/catalog"),
  values: (field: string, prefix = "") =>
    request<{ values: string[] }>("GET",
      `/api/catalog/values?field=${encodeURIComponent(field)}&prefix=${encodeURIComponent(prefix)}`),
  templates: () => request<Template[]>("GET", "/api/templates"),

  compile: (definition: SegmentDefinition, signal?: AbortSignal) =>
    request<{ cypher: string; params: Record<string, unknown> }>("POST", "/api/segments/compile", definition, signal),
  preview: (definition: SegmentDefinition, sample_size = 25, signal?: AbortSignal) =>
    request<Preview>("POST", "/api/segments/preview", { definition, sample_size }, signal),

  segments: () => request<Segment[]>("GET", "/api/segments"),
  segment: (id: string) => request<Segment>("GET", `/api/segments/${id}`),
  createSegment: (body: SegmentInput) => request<Segment>("POST", "/api/segments", body),
  updateSegment: (id: string, body: SegmentInput) => request<Segment>("PUT", `/api/segments/${id}`, body),
  deleteSegment: (id: string) => request<void>("DELETE", `/api/segments/${id}`),
  materialize: (id: string) => request<Segment>("POST", `/api/segments/${id}/materialize`),
  members: (id: string, limit = 50, skip = 0) =>
    request<{ fields: string[]; rows: Row[]; source: string }>("GET",
      `/api/segments/${id}/members?limit=${limit}&skip=${skip}`),
  exportUrl: (id: string) => `/api/segments/${id}/export.csv`,

  profile: (body: { definition?: SegmentDefinition; segment_id?: string; dimensions?: string[] }, signal?: AbortSignal) =>
    request<Profile>("POST", "/api/insights/profile", body, signal),
  overlap: (segment_ids: string[]) => request<Overlap>("POST", "/api/insights/overlap", { segment_ids }),
  member: (anchor: string, key: string) =>
    request<MemberView>("GET", `/api/members/${anchor}/${encodeURIComponent(key)}`),
  seed: (customers: number) =>
    request<Record<string, number | string>>("POST", "/api/admin/seed", { customers }),
};
