import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { AppError, db } from "./server";
import { canManage, sessionWorkspace, tokenWorkspace, type Scope } from "./workspace";

let ready: Promise<unknown> | undefined;
// RLS without policies keeps Supabase's public Data API out; the owning role used here bypasses it.
export function initPapers() {
  ready ??= db
    .query(
      `
    CREATE TABLE IF NOT EXISTS papers (id SERIAL PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE, title TEXT NOT NULL, authors JSONB NOT NULL DEFAULT '[]'::jsonb, year INTEGER, abstract TEXT, doi TEXT, arxiv_id TEXT, openalex_id TEXT, url TEXT, pdf_url TEXT, source TEXT NOT NULL DEFAULT 'manual', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS paper_notes (id SERIAL PRIMARY KEY, paper_id INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE, owner_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE, body TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS api_tokens (id SERIAL PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE, name VARCHAR(100) NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_used_at TIMESTAMPTZ);
    CREATE TABLE IF NOT EXISTS api_usage (id BIGSERIAL PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE, kind TEXT NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE INDEX IF NOT EXISTS api_usage_idx ON api_usage(owner_id, kind, at DESC);
    ALTER TABLE papers ADD COLUMN IF NOT EXISTS venue TEXT;
    ALTER TABLE papers ADD COLUMN IF NOT EXISTS venue_type TEXT;
    ALTER TABLE papers ADD COLUMN IF NOT EXISTS read_status TEXT NOT NULL DEFAULT 'to_read';
    ALTER TABLE papers ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';
    ALTER TABLE papers ADD COLUMN IF NOT EXISTS cited_by_count INTEGER;
    ALTER TABLE papers ADD COLUMN IF NOT EXISTS work_type TEXT;
    ALTER TABLE papers ADD COLUMN IF NOT EXISTS metadata_refreshed_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS papers_tags_idx ON papers USING GIN (tags);
    -- Workspaces: papers (and their notes) are shared per workspace; owner_id is the member who added the row.
    ALTER TABLE papers ADD COLUMN IF NOT EXISTS workspace_id TEXT REFERENCES organization(id) ON DELETE CASCADE;
    ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS workspace_id TEXT REFERENCES organization(id) ON DELETE CASCADE;
    DROP INDEX IF EXISTS papers_owner_doi_idx; DROP INDEX IF EXISTS papers_owner_arxiv_idx; DROP INDEX IF EXISTS papers_owner_openalex_idx;
    CREATE UNIQUE INDEX IF NOT EXISTS papers_ws_doi_idx ON papers(workspace_id, lower(doi)) WHERE doi IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS papers_ws_arxiv_idx ON papers(workspace_id, lower(arxiv_id)) WHERE arxiv_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS papers_ws_openalex_idx ON papers(workspace_id, openalex_id) WHERE openalex_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS papers_ws_idx ON papers(workspace_id, created_at DESC);
    -- Read status is per member. No row = to_read. papers.read_status is legacy: its values are copied to the creator once, then reset.
    CREATE TABLE IF NOT EXISTS paper_reads (paper_id INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE, status TEXT NOT NULL CHECK (status IN ('reading','read')), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (paper_id, user_id));
    CREATE INDEX IF NOT EXISTS paper_reads_user_idx ON paper_reads(user_id);
    WITH old AS (SELECT id, owner_id, read_status FROM papers WHERE read_status IN ('reading','read') FOR UPDATE), moved AS (UPDATE papers SET read_status='to_read' FROM old WHERE papers.id=old.id RETURNING papers.id) INSERT INTO paper_reads (paper_id, user_id, status) SELECT old.id, old.owner_id, old.read_status FROM old JOIN moved ON moved.id=old.id ON CONFLICT DO NOTHING;
    ALTER TABLE paper_reads ENABLE ROW LEVEL SECURITY;
    ALTER TABLE papers ENABLE ROW LEVEL SECURITY; ALTER TABLE paper_notes ENABLE ROW LEVEL SECURITY; ALTER TABLE api_tokens ENABLE ROW LEVEL SECURITY; ALTER TABLE api_usage ENABLE ROW LEVEL SECURITY`,
    )
    .catch((err) => {
      ready = undefined;
      throw err;
    });
  return ready;
}

export function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}
export function fail(error: unknown) {
  if (error instanceof AppError) return json({ detail: error.message }, error.status);
  console.error("papers error:", error instanceof Error ? error.message : "unknown");
  return json({ detail: "Không thể xử lý yêu cầu. Kiểm tra cấu hình server." }, 500);
}
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
export function newToken() {
  return "ros_" + randomBytes(32).toString("base64url");
}

/**
 * Acting user + workspace, from a browser session or a personal API token (MCP). Tokens act in the workspace they were
 * created in. `ownerId` is kept as an alias of `userId` for rate limits and creator columns.
 */
export async function owner(
  req: Request,
  opts: { allowToken?: boolean; tokenOnly?: boolean } = {},
): Promise<Scope & { ownerId: string; viaToken: boolean }> {
  await initPapers();
  const bearer = req.headers.get("authorization")?.match(/^Bearer (ros_[A-Za-z0-9_-]{20,})$/)?.[1];
  if (bearer && opts.allowToken) {
    const row = (
      await db.query("UPDATE api_tokens SET last_used_at=NOW() WHERE token_hash=$1 RETURNING owner_id, workspace_id", [
        hashToken(bearer),
      ])
    ).rows[0];
    if (!row) throw new AppError(401, "Token không hợp lệ.");
    const scope = await tokenWorkspace(row.owner_id, row.workspace_id);
    return { ...scope, ownerId: scope.userId, viaToken: true };
  }
  if (opts.tokenOnly) throw new AppError(401, "Cần Bearer token cá nhân.");
  const origin = req.headers.get("origin");
  if (
    req.method !== "GET" &&
    origin &&
    origin !== new URL(process.env.BETTER_AUTH_URL || "http://localhost:3000").origin
  )
    throw new AppError(403, "Nguồn yêu cầu không hợp lệ.");
  const scope = await sessionWorkspace(req);
  return { ...scope, ownerId: scope.userId, viaToken: false };
}

/** MAX_PAPERS is per workspace. */
export const MAX_PAPERS = 5000,
  MAX_NOTES_PER_PAPER = 200;
/** Windowed limit backed by Postgres so it holds across serverless instances. */
export async function rateLimit(ownerId: string, kind: string, max: number, windowSec: number) {
  await initPapers();
  const n = Number(
    (
      await db.query(
        "SELECT COUNT(*) FROM api_usage WHERE owner_id=$1 AND kind=$2 AND at > NOW() - make_interval(secs => $3)",
        [ownerId, kind, windowSec],
      )
    ).rows[0].count,
  );
  if (n >= max)
    throw new AppError(
      429,
      `Quá nhiều yêu cầu. Hãy thử lại sau ${windowSec >= 60 ? Math.ceil(windowSec / 60) + " phút" : windowSec + " giây"}.`,
    );
  await db.query("INSERT INTO api_usage (owner_id, kind) VALUES ($1,$2)", [ownerId, kind]);
  if (Math.random() < 0.02) await db.query("DELETE FROM api_usage WHERE at < NOW() - INTERVAL '1 day'");
}

export type PaperInput = {
  title: string;
  authors: string[];
  year: number | null;
  abstract: string | null;
  doi: string | null;
  arxiv_id: string | null;
  openalex_id: string | null;
  url: string | null;
  pdf_url: string | null;
  venue: string | null;
  venue_type: "journal" | "conference" | null;
  cited_by_count: number | null;
  work_type: string | null;
};
const clip = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const httpUrl = (v: unknown) => {
  const s = clip(v, 2000);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
};
export function parsePaper(raw: unknown): PaperInput {
  if (!raw || typeof raw !== "object") throw new AppError(422, "Dữ liệu paper không hợp lệ.");
  const r = raw as Record<string, unknown>,
    title = clip(r.title, 1000);
  if (!title) throw new AppError(422, "Tiêu đề paper là bắt buộc.");
  const authors = Array.isArray(r.authors)
    ? r.authors
        .flatMap((a) => {
          const s = clip(a, 200);
          return s ? [s] : [];
        })
        .slice(0, 100)
    : [];
  const year = typeof r.year === "number" && Number.isInteger(r.year) && r.year > 1500 && r.year < 2200 ? r.year : null;
  const doi = clip(r.doi, 200)?.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "") ?? null;
  const arxiv =
    clip(r.arxiv_id, 50)
      ?.replace(/^arxiv:/i, "")
      .replace(/v\d+$/, "") ?? null;
  const openalex = clip(r.openalex_id, 100)?.replace(/^https?:\/\/openalex\.org\//, "") ?? null;
  return {
    title,
    authors,
    year,
    abstract: clip(r.abstract, 20000),
    doi,
    arxiv_id: arxiv,
    openalex_id: openalex,
    url: httpUrl(r.url),
    pdf_url: httpUrl(r.pdf_url),
    venue: clip(r.venue, 300),
    venue_type: r.venue_type === "journal" || r.venue_type === "conference" ? r.venue_type : null,
    cited_by_count:
      typeof r.cited_by_count === "number" && Number.isInteger(r.cited_by_count) && r.cited_by_count >= 0
        ? r.cited_by_count
        : null,
    work_type: typeof r.work_type === "string" && /^[a-z-]{2,40}$/.test(r.work_type) ? r.work_type : null,
  };
}

export const normTitle = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
/** Saves into the workspace library; owner_id records which member added it. */
export async function savePaper(s: Scope, p: PaperInput, source: "manual" | "mcp") {
  // Duplicates match on any shared identifier, or on the same normalised title and year (covers papers without ids); the existing row is returned.
  const findDup = async () =>
    (
      await db.query(
        `SELECT * FROM papers WHERE workspace_id=$1 AND (($2::text IS NOT NULL AND lower(doi)=lower($2)) OR ($3::text IS NOT NULL AND lower(arxiv_id)=lower($3)) OR ($4::text IS NOT NULL AND openalex_id=$4)
       OR (length($5) >= 12 AND trim(regexp_replace(lower(title), '[^a-z0-9]+', ' ', 'g'))=$5 AND year IS NOT DISTINCT FROM $6::int)) LIMIT 1`,
        [s.workspaceId, p.doi, p.arxiv_id, p.openalex_id, normTitle(p.title), p.year],
      )
    ).rows[0];
  const dup = await findDup();
  if (dup) return { paper: dup, created: false };
  if (
    Number((await db.query("SELECT COUNT(*) FROM papers WHERE workspace_id=$1", [s.workspaceId])).rows[0].count) >=
    MAX_PAPERS
  )
    throw new AppError(422, `Workspace đã đạt giới hạn ${MAX_PAPERS} paper. Hãy xóa bớt paper không dùng.`);
  try {
    const row = (
      await db.query(
        "INSERT INTO papers (owner_id,workspace_id,title,authors,year,abstract,doi,arxiv_id,openalex_id,url,pdf_url,source,venue,venue_type,cited_by_count,work_type,metadata_refreshed_at) VALUES ($1,$16,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,CASE WHEN $8::text IS NULL THEN NULL ELSE NOW() END) RETURNING *",
        [
          s.userId,
          p.title,
          JSON.stringify(p.authors),
          p.year,
          p.abstract,
          p.doi,
          p.arxiv_id,
          p.openalex_id,
          p.url,
          p.pdf_url,
          source,
          p.venue,
          p.venue_type,
          p.cited_by_count,
          p.work_type,
          s.workspaceId,
        ],
      )
    ).rows[0];
    return { paper: row, created: true };
  } catch (e) {
    // Another member saved the same paper at the same moment: return their row.
    if ((e as { code?: string }).code === "23505") {
      const again = await findDup();
      if (again) return { paper: again, created: false };
    }
    throw e;
  }
}

// ---- Search: OpenAlex + arXiv ----
/** Adds OpenAlex credentials: OPENALEX_API_KEY (free key; anonymous search is rate-limited on shared IPs such as Vercel) and optional OPENALEX_MAILTO. */
function oaAuth(url: URL) {
  if (process.env.OPENALEX_API_KEY) url.searchParams.set("api_key", process.env.OPENALEX_API_KEY);
  if (process.env.OPENALEX_MAILTO) url.searchParams.set("mailto", process.env.OPENALEX_MAILTO);
}
async function getJson(url: string) {
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<Record<string, unknown>>;
}
function abstractFrom(index: unknown) {
  if (!index || typeof index !== "object") return null;
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index as Record<string, unknown>))
    if (Array.isArray(positions)) for (const p of positions) if (typeof p === "number" && p < 5000) words[p] = word;
  const text = words.filter(Boolean).join(" ");
  return text || null;
}
function mapWork(w: Record<string, any>): PaperInput | null {
  try {
    const loc = w.best_oa_location ?? w.primary_location ?? {};
    const src = w.primary_location?.source,
      vt = src?.type === "journal" || src?.type === "conference" ? src.type : null;
    const arxiv = typeof w.doi === "string" ? (w.doi.match(/arxiv\.(\d{4}\.\d{4,5})/i)?.[1] ?? null) : null;
    return parsePaper({
      title: w.title,
      authors: (w.authorships ?? []).map((a: any) => a?.author?.display_name),
      year: w.publication_year,
      abstract: abstractFrom(w.abstract_inverted_index),
      doi: w.doi,
      arxiv_id: arxiv,
      openalex_id: w.id,
      url: loc.landing_page_url ?? w.doi ?? w.id,
      pdf_url: loc.pdf_url,
      venue: vt ? src.display_name : null,
      venue_type: vt,
      cited_by_count: w.cited_by_count,
      work_type: w.type,
    });
  } catch {
    return null;
  }
}
export type SearchOpts = { page?: number; yearFrom?: number | null; yearTo?: number | null };
async function searchOpenAlex(q: string, limit: number, o: SearchOpts): Promise<PaperInput[]> {
  const url = new URL("https://api.openalex.org/works");
  url.searchParams.set("search", q);
  url.searchParams.set("per-page", String(limit));
  url.searchParams.set("page", String(o.page ?? 1));
  const f = [
    o.yearFrom && `from_publication_date:${o.yearFrom}-01-01`,
    o.yearTo && `to_publication_date:${o.yearTo}-12-31`,
  ].filter(Boolean);
  if (f.length) url.searchParams.set("filter", f.join(","));
  oaAuth(url);
  const data = await getJson(url.toString());
  const works = Array.isArray(data.results) ? (data.results as Record<string, any>[]) : [];
  return works.flatMap((w) => {
    const p = mapWork(w);
    return p ? [p] : [];
  });
}
const decodeXml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
async function searchArxiv(q: string, limit: number, o: SearchOpts): Promise<PaperInput[]> {
  const url = new URL("https://export.arxiv.org/api/query");
  const words = q
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}-]/gu, ""))
    .filter(Boolean)
    .slice(0, 10);
  let query = words.map((w) => `all:${w}`).join(" AND ");
  if (o.yearFrom || o.yearTo)
    query += ` AND submittedDate:[${o.yearFrom ?? 1990}01010000 TO ${o.yearTo ?? 2100}12312359]`;
  url.searchParams.set("search_query", query);
  url.searchParams.set("start", String(((o.page ?? 1) - 1) * limit));
  url.searchParams.set("max_results", String(limit));
  url.searchParams.set("sortBy", "relevance");
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseArxiv(await res.text());
}
function parseArxiv(xml: string): PaperInput[] {
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].flatMap((m) => {
    try {
      const e = m[1],
        tag = (n: string) => e.match(new RegExp(`<${n}[^>]*>([\\s\\S]*?)</${n}>`))?.[1];
      const id = tag("id")?.match(/abs\/(.+?)(?:v\d+)?$/)?.[1];
      return [
        parsePaper({
          title: decodeXml(tag("title") ?? ""),
          authors: [...e.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map((a) => decodeXml(a[1])),
          year: Number((tag("published") ?? "").slice(0, 4)) || null,
          abstract: decodeXml(tag("summary") ?? ""),
          arxiv_id: id,
          url: id ? `https://arxiv.org/abs/${id}` : null,
          pdf_url: id ? `https://arxiv.org/pdf/${id}` : null,
          work_type: "preprint",
        }),
      ];
    } catch {
      return [];
    }
  });
}
export async function searchPapers(query: string, limit = 10, opts: SearchOpts = {}) {
  const q = query.trim().slice(0, 300);
  if (q.length < 2) throw new AppError(422, "Từ khóa tìm kiếm quá ngắn.");
  const yr = (v: unknown) => {
    const n = Number(v);
    return Number.isInteger(n) && n > 1500 && n < 2200 ? n : null;
  };
  const o: SearchOpts = {
    page: Math.min(Math.max(Math.floor(Number(opts.page)) || 1, 1), 10),
    yearFrom: yr(opts.yearFrom),
    yearTo: yr(opts.yearTo),
  };
  if (o.yearFrom && o.yearTo && o.yearFrom > o.yearTo)
    throw new AppError(422, "Năm bắt đầu phải nhỏ hơn hoặc bằng năm kết thúc.");
  const n = Math.min(Math.max(Math.floor(limit) || 10, 1), 25),
    errors: string[] = [];
  const [oa, ax] = await Promise.all([
    searchOpenAlex(q, n, o).catch((e: unknown) => {
      errors.push(
        e instanceof Error && e.message.includes("429")
          ? "OpenAlex đang giới hạn tìm kiếm ẩn danh nên chỉ có kết quả từ arXiv. Quản trị viên có thể đặt OPENALEX_API_KEY (miễn phí) để khắc phục."
          : "OpenAlex không phản hồi.",
      );
      return [] as PaperInput[];
    }),
    searchArxiv(q, n, o).catch(() => {
      errors.push("arXiv không phản hồi.");
      return [] as PaperInput[];
    }),
  ]);
  const seen = new Set<string>(),
    out: PaperInput[] = [];
  for (const p of [...oa, ...ax]) {
    const keys = [
      p.doi && `doi:${p.doi.toLowerCase()}`,
      p.arxiv_id && `ax:${p.arxiv_id.toLowerCase()}`,
      `t:${p.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim()}`,
    ].filter(Boolean) as string[];
    if (keys.some((k) => seen.has(k))) continue;
    keys.forEach((k) => seen.add(k));
    out.push(p);
  }
  // arXiv has no year field in OpenAlex terms, so its results are filtered again by published year.
  const inRange = (p: PaperInput) =>
    !p.year || ((!o.yearFrom || p.year >= o.yearFrom) && (!o.yearTo || p.year <= o.yearTo));
  return { results: out.filter(inRange), errors, page: o.page };
}

// ---- Import by DOI / arXiv id ----
export function parseIdentifier(raw: string): { arxiv?: string; doi?: string } {
  const s = (raw || "").trim().slice(0, 300);
  const ax = s.match(
    /^(?:arxiv:|https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/)?(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Za-z]{2})?\/\d{7})(?:v\d+)?(?:\.pdf)?$/i,
  );
  if (ax) return { arxiv: ax[1] };
  const doi = s.match(/^(?:doi:|https?:\/\/(?:dx\.)?doi\.org\/)?(10\.\d{4,9}\/[^\s]+)$/i);
  if (doi) {
    const viaArxiv = doi[1].match(/^10\.48550\/arxiv\.(.+)$/i);
    return viaArxiv ? { arxiv: viaArxiv[1] } : { doi: doi[1] };
  }
  throw new AppError(422, "Không nhận dạng được DOI hoặc arXiv ID. Ví dụ: 10.1145/3695994 hoặc 2110.02027.");
}
export async function importPaper(raw: string): Promise<PaperInput> {
  const id = parseIdentifier(raw);
  try {
    if (id.arxiv) {
      const url = new URL("https://export.arxiv.org/api/query");
      url.searchParams.set("id_list", id.arxiv);
      url.searchParams.set("max_results", "1");
      const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const hit = parseArxiv(await res.text()).find((p) => p.arxiv_id);
      if (!hit) throw new AppError(404, "Không tìm thấy paper với arXiv ID này.");
      return hit;
    }
    const url = new URL(`https://api.openalex.org/works/doi:${encodeURI(id.doi!)}`);
    oaAuth(url);
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 404) throw new AppError(404, "Không tìm thấy paper với DOI này.");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const paper = mapWork((await res.json()) as Record<string, any>);
    if (!paper) throw new AppError(502, "OpenAlex trả dữ liệu không đầy đủ cho DOI này.");
    return paper;
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(502, "Không kết nối được nguồn dữ liệu. Hãy thử lại sau.");
  }
}

// ---- Library queries ----
const like = (q: string) =>
  q
    .trim()
    .slice(0, 200)
    .replace(/[\\%_]/g, "\\$&");
export const READ_STATUSES = ["to_read", "reading", "read"] as const;
export type ListOpts = {
  q?: string;
  sort?: string;
  source?: string;
  status?: string;
  readers?: string;
  tag?: string;
  ids?: number[];
  limit?: number;
  offset?: number;
};
/** WHERE clause over `papers p` for the workspace library; always uses exactly $1..$7 ($7 = the caller, for per-member read status). */
function listWhere(s: Scope, o: ListOpts) {
  const source = o.source === "manual" || o.source === "mcp" ? o.source : null,
    status = (READ_STATUSES as readonly string[]).includes(o.status || "") ? o.status! : null;
  const tag = typeof o.tag === "string" && o.tag.trim() ? o.tag.trim().slice(0, 40) : null,
    ids = Array.isArray(o.ids) ? o.ids.filter((n) => Number.isInteger(n) && n > 0).slice(0, 2000) : null;
  // 'none' = nobody has read it; 'others' = someone else has read it and the caller has not (whitelisted, never user input in SQL).
  const readersClause =
    o.readers === "none"
      ? " AND NOT EXISTS (SELECT 1 FROM paper_reads r WHERE r.paper_id=p.id AND r.status='read')"
      : o.readers === "others"
        ? " AND NOT EXISTS (SELECT 1 FROM paper_reads r WHERE r.paper_id=p.id AND r.user_id=$7 AND r.status='read') AND EXISTS (SELECT 1 FROM paper_reads r JOIN member m ON m.\"userId\"=r.user_id AND m.\"organizationId\"=$1 WHERE r.paper_id=p.id AND r.status='read' AND r.user_id<>$7)"
        : "";
  return {
    where:
      "p.workspace_id=$1 AND ($2='' OR p.title ILIKE '%'||$2||'%' OR p.abstract ILIKE '%'||$2||'%' OR p.authors::text ILIKE '%'||$2||'%') AND ($3::text IS NULL OR p.source=$3) AND ($4::text IS NULL OR COALESCE((SELECT r.status FROM paper_reads r WHERE r.paper_id=p.id AND r.user_id=$7), 'to_read')=$4) AND ($5::text IS NULL OR $5=ANY(p.tags)) AND ($6::int[] IS NULL OR p.id=ANY($6::int[]))" +
      readersClause,
    params: [s.workspaceId, like(o.q || ""), source, status, tag, ids, s.userId] as unknown[],
  };
}
/** Adds who added the paper and whether the caller may delete it. Expects rows with owner_id and added_by. */
const withRights = <T extends { owner_id: unknown }>(s: Scope, rows: T[]) =>
  rows.map((r) => ({ ...r, can_delete: canManage(s, r.owner_id) }));
/** Overrides read_status with the caller's own and adds who read it: read_count, reading_count, member_count, readers (current members only). */
async function withReads<T extends { id: number }>(s: Scope, rows: T[]) {
  const ids = rows.map((r) => r.id);
  const [reads, members] = ids.length
    ? await Promise.all([
        db.query(
          'SELECT r.paper_id, r.user_id, r.status, r.updated_at, u.name FROM paper_reads r JOIN member m ON m."userId"=r.user_id AND m."organizationId"=$2 LEFT JOIN "user" u ON u.id=r.user_id WHERE r.paper_id=ANY($1::int[]) ORDER BY r.updated_at',
          [ids, s.workspaceId],
        ),
        db.query('SELECT COUNT(*)::int AS n FROM member WHERE "organizationId"=$1', [s.workspaceId]),
      ])
    : [{ rows: [] }, { rows: [{ n: 0 }] }];
  const by = new Map<number, { user_id: string; status: string; updated_at: string; name: string | null }[]>();
  for (const r of reads.rows) by.set(r.paper_id, [...(by.get(r.paper_id) ?? []), r]);
  return rows.map((r) => {
    const rs = by.get(r.id) ?? [];
    return {
      ...r,
      read_status: rs.find((x) => x.user_id === s.userId)?.status ?? "to_read",
      read_count: rs.filter((x) => x.status === "read").length,
      reading_count: rs.filter((x) => x.status === "reading").length,
      member_count: members.rows[0].n as number,
      readers: rs.map((x) => ({
        name: x.name,
        status: x.status,
        updated_at: x.updated_at,
        mine: x.user_id === s.userId,
      })),
    };
  });
}
/** Sets the caller's own read status on papers of the workspace (to_read removes the row). Returns how many papers changed. */
async function setMyStatus(s: Scope, ids: number[], status: string) {
  if (status === "to_read")
    return (
      (
        await db.query(
          "DELETE FROM paper_reads WHERE user_id=$1 AND paper_id IN (SELECT id FROM papers WHERE workspace_id=$2 AND id=ANY($3::int[]))",
          [s.userId, s.workspaceId, ids],
        )
      ).rowCount ?? 0
    );
  return (
    (
      await db.query(
        "INSERT INTO paper_reads (paper_id, user_id, status) SELECT id, $1, $4::text FROM papers WHERE workspace_id=$2 AND id=ANY($3::int[]) ON CONFLICT (paper_id, user_id) DO UPDATE SET status=EXCLUDED.status, updated_at=NOW()",
        [s.userId, s.workspaceId, ids, status],
      )
    ).rowCount ?? 0
  );
}
export async function listPapers(s: Scope, o: ListOpts) {
  const limit = Math.min(Math.max(Math.floor(o.limit || 50), 1), 100),
    offset = Math.max(0, Math.floor(o.offset || 0));
  const orders: Record<string, string> = {
    newest: "p.created_at DESC, p.id DESC",
    year: "p.year DESC NULLS LAST, p.id DESC",
    title: "lower(p.title) ASC, p.id ASC",
    cited: "p.cited_by_count DESC NULLS LAST, p.id DESC",
  };
  const order = orders[o.sort || "newest"] ?? orders.newest,
    { where, params } = listWhere(s, o);
  const total = Number((await db.query(`SELECT COUNT(*) FROM papers p WHERE ${where}`, params)).rows[0].count);
  const items = (
    await db.query(
      `SELECT p.*, u.name AS added_by, (SELECT COUNT(*)::int FROM paper_notes n WHERE n.paper_id=p.id) AS note_count FROM papers p LEFT JOIN "user" u ON u.id=p.owner_id WHERE ${where} ORDER BY ${order} LIMIT $8 OFFSET $9`,
      [...params, limit, offset],
    )
  ).rows;
  return { items: await withReads(s, withRights(s, items)), total, limit, offset };
}
/** One paper of the workspace with added_by and can_delete, or 404. */
export async function getPaper(s: Scope, idRaw: unknown) {
  const row = (
    await db.query(
      'SELECT p.*, u.name AS added_by FROM papers p LEFT JOIN "user" u ON u.id=p.owner_id WHERE p.id=$1 AND p.workspace_id=$2',
      [toId(idRaw, "paper"), s.workspaceId],
    )
  ).rows[0];
  if (!row) throw new AppError(404, "Không tìm thấy paper.");
  return (await withReads(s, withRights(s, [row])))[0];
}
export async function listTags(s: Scope) {
  return (
    await db.query(
      "SELECT tag, COUNT(*)::int AS count FROM papers, unnest(tags) AS tag WHERE workspace_id=$1 GROUP BY tag ORDER BY count DESC, lower(tag) LIMIT 200",
      [s.workspaceId],
    )
  ).rows as { tag: string; count: number }[];
}
export function parseTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new AppError(422, "Tag phải là danh sách.");
  const out: string[] = [];
  for (const t of raw) {
    const v = typeof t === "string" ? t.trim().replace(/\s+/g, " ").slice(0, 40) : "";
    if (v && !out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v);
  }
  if (out.length > 20) throw new AppError(422, "Mỗi paper tối đa 20 tag.");
  return out;
}
const oneTag = (v: unknown) => {
  const t = typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, 40) : "";
  if (!t) throw new AppError(422, "Tag không hợp lệ.");
  return t;
};
const oneStatus = (v: unknown) => {
  if (!(READ_STATUSES as readonly unknown[]).includes(v)) throw new AppError(422, "Trạng thái đọc không hợp lệ.");
  return v as string;
};
/**
 * Applies one action to many papers of the workspace; ids outside it are silently ignored. Delete only removes papers the
 * caller may manage (their own, or any for owner/admin) and reports the others as `skipped`.
 */
export async function bulkPapers(
  s: Scope,
  idsRaw: unknown,
  action: unknown,
  value: unknown,
): Promise<{ affected: number; skipped: number }> {
  const ids = Array.isArray(idsRaw)
    ? [...new Set(idsRaw.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 500)
    : [];
  if (!ids.length) throw new AppError(422, "Chưa chọn paper nào.");
  const q = (sql: string, extra: unknown[] = []) =>
    db.query(sql, [s.workspaceId, ids, ...extra]).then((r) => ({ affected: r.rowCount ?? 0, skipped: 0 }));
  switch (action) {
    case "delete": {
      const r = (
        await db.query(
          `WITH t AS (SELECT id, (owner_id=$3 OR $4::boolean) AS ok FROM papers WHERE workspace_id=$1 AND id=ANY($2::int[])), d AS (DELETE FROM papers p USING t WHERE p.id=t.id AND t.ok RETURNING p.id)
        SELECT (SELECT COUNT(*)::int FROM d) AS affected, (SELECT COUNT(*)::int FROM t WHERE NOT ok) AS skipped`,
          [s.workspaceId, ids, s.userId, s.admin],
        )
      ).rows[0];
      return { affected: r.affected, skipped: r.skipped };
    }
    case "status":
      return { affected: await setMyStatus(s, ids, oneStatus(value)), skipped: 0 };
    case "add_tag":
      return q(
        "UPDATE papers SET tags=array_append(tags, $3) WHERE workspace_id=$1 AND id=ANY($2::int[]) AND cardinality(tags) < 20 AND NOT EXISTS (SELECT 1 FROM unnest(tags) t WHERE lower(t)=lower($3))",
        [oneTag(value)],
      );
    case "remove_tag":
      return q(
        "UPDATE papers SET tags=ARRAY(SELECT t FROM unnest(tags) t WHERE lower(t)<>lower($3)) WHERE workspace_id=$1 AND id=ANY($2::int[])",
        [oneTag(value)],
      );
    default:
      throw new AppError(422, "Thao tác không hợp lệ.");
  }
}
export async function searchLibrary(s: Scope, query: string, limit = 10) {
  const words = query
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean)
    .slice(0, 8);
  if (!words.length) throw new AppError(422, "Từ khóa tìm kiếm không hợp lệ.");
  const n = Math.min(Math.max(Math.floor(limit) || 10, 1), 50);
  return (
    await db.query(
      `SELECT id, title, authors, year, doi, arxiv_id, url, source, ts_rank(setweight(to_tsvector('simple', title), 'A') || setweight(to_tsvector('simple', coalesce(abstract,'')), 'B'), to_tsquery('simple', $2)) AS score
     FROM papers WHERE workspace_id=$1 AND (setweight(to_tsvector('simple', title), 'A') || setweight(to_tsvector('simple', coalesce(abstract,'')), 'B')) @@ to_tsquery('simple', $2)
     ORDER BY score DESC, created_at DESC LIMIT $3`,
      [s.workspaceId, words.join(" | "), n],
    )
  ).rows;
}
const toId = (v: unknown, what: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new AppError(404, `Không tìm thấy ${what}.`);
  return n;
};
export async function updatePaper(s: Scope, idRaw: unknown, fields: Record<string, unknown>) {
  const id = toId(idRaw, "paper"),
    cur = (await db.query("SELECT * FROM papers WHERE id=$1 AND workspace_id=$2", [id, s.workspaceId])).rows[0];
  if (!cur) throw new AppError(404, "Không tìm thấy paper.");
  const allowed = ["title", "authors", "year", "abstract", "doi", "arxiv_id", "url", "pdf_url", "venue", "venue_type"],
    patch: Record<string, unknown> = {};
  for (const k of allowed) if (k in fields) patch[k] = fields[k];
  if (!Object.keys(patch).length && !("tags" in fields) && !("read_status" in fields))
    throw new AppError(422, "Không có trường nào để cập nhật.");
  const m = parsePaper({ ...cur, ...patch }),
    tags = "tags" in fields ? parseTags(fields.tags) : cur.tags,
    status = "read_status" in fields ? oneStatus(fields.read_status) : null;
  try {
    const row = (
      await db.query(
        'UPDATE papers SET title=$3, authors=$4, year=$5, abstract=$6, doi=$7, arxiv_id=$8, url=$9, pdf_url=$10, venue=$11, venue_type=$12, tags=$13 WHERE id=$1 AND workspace_id=$2 RETURNING *, (SELECT name FROM "user" WHERE id=papers.owner_id) AS added_by',
        [
          id,
          s.workspaceId,
          m.title,
          JSON.stringify(m.authors),
          m.year,
          m.abstract,
          m.doi,
          m.arxiv_id,
          m.url,
          m.pdf_url,
          m.venue,
          m.venue_type,
          tags,
        ],
      )
    ).rows[0];
    if (!row) throw new AppError(404, "Không tìm thấy paper.");
    if (status) await setMyStatus(s, [id], status);
    return (await withReads(s, withRights(s, [row])))[0];
  } catch (e) {
    if ((e as { code?: string }).code === "23505")
      throw new AppError(409, "DOI hoặc arXiv ID trùng với paper khác trong thư viện.");
    throw e;
  }
}
/** Only the member who added the paper, or a workspace owner/admin, may delete it. */
export async function deletePaper(s: Scope, idRaw: unknown) {
  const id = toId(idRaw, "paper"),
    cur = (await db.query("SELECT owner_id FROM papers WHERE id=$1 AND workspace_id=$2", [id, s.workspaceId])).rows[0];
  if (!cur) throw new AppError(404, "Không tìm thấy paper.");
  if (!canManage(s, cur.owner_id))
    throw new AppError(403, "Chỉ người thêm paper hoặc quản trị workspace mới được xóa.");
  if (!(await db.query("DELETE FROM papers WHERE id=$1 AND workspace_id=$2", [id, s.workspaceId])).rowCount)
    throw new AppError(404, "Không tìm thấy paper.");
}

// ---- Notes ----
const noteBody = (v: unknown) => {
  const t = typeof v === "string" ? v.trim() : "";
  if (!t || t.length > 20000) throw new AppError(422, "Nội dung ghi chú không hợp lệ.");
  return t;
};
const paperInWorkspace = async (s: Scope, id: number) => {
  if (!(await db.query("SELECT 1 FROM papers WHERE id=$1 AND workspace_id=$2", [id, s.workspaceId])).rowCount)
    throw new AppError(404, "Không tìm thấy paper.");
};
export type NoteRow = {
  id: number;
  body: string;
  created_at: string;
  author: string | null;
  mine: boolean;
  can_delete: boolean;
};
/** Notes come back with the author's display name; `mine` gates editing, `can_delete` adds workspace owner/admin. */
const noteSql = (from: string) =>
  `SELECT n.id, n.body, n.created_at, u.name AS author, n.owner_id FROM ${from} LEFT JOIN "user" u ON u.id=n.owner_id`;
const noteOut = (
  s: Scope,
  rows: { id: number; body: string; created_at: string; author: string | null; owner_id: string }[],
): NoteRow[] =>
  rows.map(({ owner_id, ...n }) => ({ ...n, mine: owner_id === s.userId, can_delete: canManage(s, owner_id) }));
/** All notes of a workspace paper, from every member. */
export async function listNotes(s: Scope, paperId: unknown) {
  const id = toId(paperId, "paper");
  await paperInWorkspace(s, id);
  return noteOut(
    s,
    (await db.query(`${noteSql("paper_notes n")} WHERE n.paper_id=$1 ORDER BY n.created_at DESC`, [id])).rows,
  );
}
export async function addNote(s: Scope, paperId: unknown, body: unknown) {
  const id = toId(paperId, "paper"),
    text = noteBody(body);
  await paperInWorkspace(s, id);
  if (
    Number((await db.query("SELECT COUNT(*) FROM paper_notes WHERE paper_id=$1", [id])).rows[0].count) >=
    MAX_NOTES_PER_PAPER
  )
    throw new AppError(422, `Mỗi paper tối đa ${MAX_NOTES_PER_PAPER} ghi chú.`);
  return noteOut(
    s,
    (
      await db.query(
        `WITH n AS (INSERT INTO paper_notes (paper_id, owner_id, body) VALUES ($1,$2,$3) RETURNING *) ${noteSql("n")}`,
        [id, s.userId, text],
      )
    ).rows,
  )[0];
}
/** Note of a paper in the caller's workspace, with its author id; 404 when either is missing. */
async function noteOf(s: Scope, paperId: unknown, noteId: unknown) {
  const nid = toId(noteId, "ghi chú"),
    pid = toId(paperId, "paper");
  const row = (
    await db.query(
      "SELECT n.id, n.owner_id FROM paper_notes n JOIN papers p ON p.id=n.paper_id WHERE n.id=$1 AND n.paper_id=$2 AND p.workspace_id=$3",
      [nid, pid, s.workspaceId],
    )
  ).rows[0];
  if (!row) throw new AppError(404, "Không tìm thấy ghi chú.");
  return row as { id: number; owner_id: string };
}
/** Only the note's author may edit it. */
export async function updateNote(s: Scope, paperId: unknown, noteId: unknown, body: unknown) {
  const note = await noteOf(s, paperId, noteId),
    text = noteBody(body);
  if (note.owner_id !== s.userId) throw new AppError(403, "Chỉ người viết mới sửa được ghi chú này.");
  return noteOut(
    s,
    (
      await db.query(`WITH n AS (UPDATE paper_notes SET body=$2 WHERE id=$1 RETURNING *) ${noteSql("n")}`, [
        note.id,
        text,
      ])
    ).rows,
  )[0];
}
/** The author, or a workspace owner/admin, may delete a note. */
export async function deleteNote(s: Scope, paperId: unknown, noteId: unknown) {
  const note = await noteOf(s, paperId, noteId);
  if (!canManage(s, note.owner_id))
    throw new AppError(403, "Chỉ người viết hoặc quản trị workspace mới xóa được ghi chú này.");
  await db.query("DELETE FROM paper_notes WHERE id=$1", [note.id]);
}

/** Tags search results that are already in the workspace library with saved_id, so the UI can offer "view" instead of "save". */
export async function markSaved<T extends PaperInput>(
  s: Scope,
  results: T[],
): Promise<(T & { saved_id: number | null })[]> {
  if (!results.length) return [];
  const dois = results.flatMap((p) => (p.doi ? [p.doi.toLowerCase()] : [])),
    axs = results.flatMap((p) => (p.arxiv_id ? [p.arxiv_id.toLowerCase()] : [])),
    oas = results.flatMap((p) => (p.openalex_id ? [p.openalex_id] : []));
  const rows = (
    await db.query(
      "SELECT id, lower(doi) AS doi, lower(arxiv_id) AS arxiv_id, openalex_id FROM papers WHERE workspace_id=$1 AND (lower(doi)=ANY($2::text[]) OR lower(arxiv_id)=ANY($3::text[]) OR openalex_id=ANY($4::text[]))",
      [s.workspaceId, dois, axs, oas],
    )
  ).rows;
  return results.map((p) => ({
    ...p,
    saved_id:
      rows.find(
        (r) =>
          (p.doi && r.doi === p.doi.toLowerCase()) ||
          (p.arxiv_id && r.arxiv_id === p.arxiv_id.toLowerCase()) ||
          (p.openalex_id && r.openalex_id === p.openalex_id),
      )?.id ?? null,
  }));
}

// ---- BibTeX ----
const BIB_ESC: Record<string, string> = {
  "\\": "\\textbackslash{}",
  "{": "\\{",
  "}": "\\}",
  "&": "\\&",
  "%": "\\%",
  $: "\\$",
  "#": "\\#",
  _: "\\_",
  "~": "\\textasciitilde{}",
  "^": "\\textasciicircum{}",
};
const bib = (s: string) =>
  s
    .replace(/[\\{}&%$#_~^]/g, (c) => BIB_ESC[c])
    .replace(/\s+/g, " ")
    .trim();
const ascii = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
const PARTICLES = new Set([
  "van",
  "von",
  "der",
  "den",
  "de",
  "del",
  "della",
  "da",
  "di",
  "du",
  "la",
  "le",
  "dos",
  "das",
  "ter",
  "ten",
]);
/** "Aaron van den Oord" -> "van den Oord, Aaron"; names that already contain a comma are kept. */
function bibName(n: string) {
  if (n.includes(",")) return n;
  const parts = n.trim().split(/\s+/);
  if (parts.length < 2) return n;
  let i = parts.length - 1;
  while (i > 1 && PARTICLES.has(parts[i - 1].toLowerCase())) i--;
  return `${parts.slice(i).join(" ")}, ${parts.slice(0, i).join(" ")}`;
}
const STOP = new Set([
  "a",
  "an",
  "the",
  "on",
  "of",
  "for",
  "in",
  "to",
  "and",
  "with",
  "via",
  "towards",
  "toward",
  "is",
  "are",
]);
type BibPaper = {
  title: string;
  authors: string[];
  year: number | null;
  doi: string | null;
  arxiv_id: string | null;
  url: string | null;
  venue: string | null;
  venue_type: string | null;
};
export function toBibtex(papers: BibPaper[]) {
  const used = new Map<string, number>();
  return (
    papers
      .map((p) => {
        const lastName = bibName(p.authors[0] ?? "anon")
            .split(",")[0]
            .split(" "),
          last = ascii(lastName[lastName.length - 1]) || "anon";
        const word =
          p.title
            .split(/\s+/)
            .map(ascii)
            .find((w) => w && !STOP.has(w)) ?? "paper";
        let key = `${last}${p.year ?? "nd"}${word}`;
        const n = used.get(key) ?? 0;
        used.set(key, n + 1);
        if (n) key += String.fromCharCode(96 + n + 1);
        // A venue set by the user wins over the arXiv preprint; arXiv's own DOI (10.48550) is left out because eprint already covers it.
        const arxivDoi = !!p.doi && /^10\.48550\//i.test(p.doi);
        const type = p.venue_type === "conference" ? "inproceedings" : p.venue_type === "journal" ? "article" : "misc";
        const f: [string, string][] = [["title", `{${bib(p.title)}}`]];
        if (p.authors.length) f.push(["author", p.authors.map((a) => bib(bibName(a))).join(" and ")]);
        if (p.year) f.push(["year", String(p.year)]);
        if (type === "article" && p.venue) f.push(["journal", bib(p.venue)]);
        if (type === "inproceedings" && p.venue) f.push(["booktitle", bib(p.venue)]);
        if (p.doi && !arxivDoi) f.push(["doi", bib(p.doi)]);
        if (p.arxiv_id) {
          f.push(["eprint", bib(p.arxiv_id)]);
          f.push(["archiveprefix", "arXiv"]);
        }
        if (p.url) f.push(["url", bib(p.url)]);
        return `@${type}{${key},\n${f.map(([k, v]) => `  ${k} = {${v}}`).join(",\n")}\n}`;
      })
      .join("\n\n") + "\n"
  );
}
export async function exportBibtex(s: Scope, o: ListOpts) {
  const { where, params } = listWhere(s, o);
  const rows = (
    await db.query(
      `SELECT title, authors, year, doi, arxiv_id, url, venue, venue_type FROM papers p WHERE ${where} ORDER BY p.year NULLS LAST, lower(p.title) LIMIT 2000`,
      params,
    )
  ).rows;
  return { count: rows.length, bibtex: rows.length ? toBibtex(rows) : "" };
}

// ---- Metadata refresh (OpenAlex, batched) ----
const asIds = (raw: unknown, max: number) => {
  const ids = Array.isArray(raw) ? [...new Set(raw.map(Number).filter((n) => Number.isInteger(n) && n > 0))] : [];
  if (!ids.length) throw new AppError(422, "Chưa chọn paper nào.");
  if (ids.length > max) throw new AppError(422, `Tối đa ${max} paper mỗi lần.`);
  return ids;
};
async function openAlexBatch(filterKey: "openalex" | "doi", values: string[]) {
  const out: Record<string, any>[] = [];
  for (let i = 0; i < values.length; i += 50) {
    const url = new URL("https://api.openalex.org/works");
    url.searchParams.set("filter", `${filterKey}:${values.slice(i, i + 50).join("|")}`);
    url.searchParams.set("per-page", "50");
    oaAuth(url);
    const data = await getJson(url.toString());
    if (Array.isArray(data.results)) out.push(...(data.results as Record<string, any>[]));
  }
  return out;
}
const shortOa = (v: unknown) => (typeof v === "string" ? v.replace(/^https?:\/\/openalex\.org\//, "") : null);
const bareDoi = (v: unknown) =>
  typeof v === "string" ? v.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").toLowerCase() : null;
/**
 * Re-reads up to 100 papers from OpenAlex in a few batched calls. Citation count and work type are always updated;
 * other fields are only filled when empty, so manual edits are kept. Returns which fields changed per paper.
 */
export async function refreshMetadata(s: Scope, idsRaw: unknown) {
  const ids = asIds(idsRaw, 100);
  const rows = (
    await db.query("SELECT * FROM papers WHERE workspace_id=$1 AND id=ANY($2::int[])", [s.workspaceId, ids])
  ).rows;
  if (!rows.length) throw new AppError(404, "Không tìm thấy paper.");
  const doiOf = (p: any) =>
    p.doi ? p.doi.toLowerCase() : p.arxiv_id ? `10.48550/arxiv.${p.arxiv_id.toLowerCase()}` : null;
  let works: Record<string, any>[];
  try {
    works = [
      ...(await openAlexBatch(
        "openalex",
        rows.filter((p) => p.openalex_id).map((p) => p.openalex_id),
      )),
      ...(await openAlexBatch(
        "doi",
        rows.filter((p) => !p.openalex_id && doiOf(p)).map((p) => doiOf(p)!),
      )),
    ];
  } catch {
    throw new AppError(502, "Không kết nối được OpenAlex. Hãy thử lại sau.");
  }
  const results: { id: number; title: string; changed: string[] }[] = [],
    missing: { id: number; title: string }[] = [];
  const byId = (p: any) =>
    works.find(
      (x) =>
        (p.openalex_id && shortOa(x.id) === p.openalex_id) ||
        (!p.openalex_id && doiOf(p) && bareDoi(x.doi) === doiOf(p)),
    );
  // Fallback for papers OpenAlex does not know by id (e.g. some arXiv DOIs): search by title and accept only an exact
  // normalised-title match within one year, so a different paper is never attached. Capped to keep the call count low.
  for (const p of rows.filter((p) => !byId(p) && normTitle(p.title).length >= 12).slice(0, 10)) {
    try {
      const url = new URL("https://api.openalex.org/works");
      url.searchParams.set("filter", `title.search:${p.title.replace(/[,|:]/g, " ")}`);
      url.searchParams.set("per-page", "5");
      oaAuth(url);
      const data = await getJson(url.toString()),
        cands = Array.isArray(data.results) ? (data.results as Record<string, any>[]) : [];
      const hit = cands
        .filter(
          (w) =>
            typeof w.title === "string" &&
            normTitle(w.title) === normTitle(p.title) &&
            (!p.year || !w.publication_year || Math.abs(w.publication_year - p.year) <= 1),
        )
        .sort((x, y) => (y.cited_by_count ?? 0) - (x.cited_by_count ?? 0))[0];
      if (hit) works.push({ ...hit, __for: p.id });
    } catch {
      /* treated as missing */
    }
  }
  for (const p of rows) {
    const w = byId(p) ?? works.find((x) => x.__for === p.id);
    const m = w ? mapWork(w) : null;
    if (!m) {
      missing.push({ id: p.id, title: p.title });
      continue;
    }
    const set: Record<string, unknown> = {};
    if (m.cited_by_count !== null && m.cited_by_count !== p.cited_by_count) set.cited_by_count = m.cited_by_count;
    if (m.work_type && m.work_type !== p.work_type) set.work_type = m.work_type;
    for (const k of ["venue", "venue_type", "abstract", "pdf_url", "year"] as const)
      if ((p[k] === null || p[k] === "") && m[k] !== null) set[k] = m[k];
    if (!p.authors?.length && m.authors.length) set.authors = JSON.stringify(m.authors);
    // Identifiers are only filled when no other paper of this workspace already uses them (unique per workspace).
    if (
      !p.openalex_id &&
      m.openalex_id &&
      !(await db.query("SELECT 1 FROM papers WHERE workspace_id=$1 AND openalex_id=$2", [s.workspaceId, m.openalex_id]))
        .rowCount
    )
      set.openalex_id = m.openalex_id;
    if (
      !p.doi &&
      m.doi &&
      !/^10\.48550\//i.test(m.doi) &&
      !(await db.query("SELECT 1 FROM papers WHERE workspace_id=$1 AND lower(doi)=lower($2)", [s.workspaceId, m.doi]))
        .rowCount
    )
      set.doi = m.doi;
    const keys = Object.keys(set);
    await db.query(
      `UPDATE papers SET ${[...keys.map((k, i) => `${k}=$${i + 3}`), "metadata_refreshed_at=NOW()"].join(", ")} WHERE id=$1 AND workspace_id=$2`,
      [p.id, s.workspaceId, ...keys.map((k) => set[k])],
    );
    results.push({ id: p.id, title: p.title, changed: keys });
  }
  return { refreshed: results.length, results, missing };
}

// ---- Duplicates and merge ----
/** Groups of workspace papers that share a normalised title (e.g. preprint + journal version), DOI or arXiv id. */
export async function findDuplicates(s: Scope) {
  const rows = (
    await db.query(
      `WITH k AS (SELECT id, unnest(ARRAY[ 't:' || trim(regexp_replace(lower(title), '[^a-z0-9]+', ' ', 'g')), CASE WHEN doi IS NOT NULL THEN 'd:' || lower(doi) END, CASE WHEN arxiv_id IS NOT NULL THEN 'a:' || lower(arxiv_id) END]) AS key FROM papers WHERE workspace_id=$1)
     SELECT key, array_agg(id ORDER BY id) AS ids FROM k WHERE key IS NOT NULL AND (key NOT LIKE 't:%' OR length(key) > 14) GROUP BY key HAVING COUNT(*) > 1 LIMIT 100`,
      [s.workspaceId],
    )
  ).rows as { key: string; ids: number[] }[];
  const groups: number[][] = [];
  for (const r of rows) {
    const g = groups.find((x) => r.ids.some((i) => x.includes(i)));
    if (g) r.ids.forEach((i) => !g.includes(i) && g.push(i));
    else groups.push([...r.ids]);
  }
  if (!groups.length) return [];
  const papers = await withReads(
    s,
    withRights(
      s,
      (
        await db.query(
          'SELECT p.id, p.title, p.authors, p.year, p.doi, p.arxiv_id, p.venue, p.venue_type, p.work_type, p.cited_by_count, p.read_status, p.tags, p.created_at, p.owner_id, u.name AS added_by, (SELECT COUNT(*)::int FROM paper_notes n WHERE n.paper_id=p.id) AS note_count FROM papers p LEFT JOIN "user" u ON u.id=p.owner_id WHERE p.workspace_id=$1 AND p.id=ANY($2::int[])',
          [s.workspaceId, groups.flat()],
        )
      ).rows,
    ),
  );
  return groups.map((g) => g.map((id) => papers.find((p) => p.id === id)).filter(Boolean));
}
const STATUS_RANK: Record<string, number> = { to_read: 0, reading: 1, read: 2 };
/**
 * Merges papers into keepId inside one transaction: notes move over, tags are unioned, the most advanced read status wins,
 * empty fields of the kept paper are filled from the others, then the others are deleted. Because those get deleted, the
 * caller must be allowed to delete each of them (their own papers, or any as workspace owner/admin).
 */
export async function mergePapers(s: Scope, keepRaw: unknown, mergeRaw: unknown) {
  const keepId = toId(keepRaw, "paper"),
    mergeIds = asIds(mergeRaw, 20).filter((id) => id !== keepId);
  if (!mergeIds.length) throw new AppError(422, "Cần ít nhất một paper khác để gộp.");
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    const rows = (
      await c.query("SELECT * FROM papers WHERE workspace_id=$1 AND id=ANY($2::int[]) FOR UPDATE", [
        s.workspaceId,
        [keepId, ...mergeIds],
      ])
    ).rows;
    const keep = rows.find((p) => p.id === keepId),
      others = rows.filter((p) => p.id !== keepId);
    if (!keep || others.length !== mergeIds.length) throw new AppError(404, "Không tìm thấy paper.");
    const blocked = others.filter((p) => !canManage(s, p.owner_id));
    if (blocked.length)
      throw new AppError(
        403,
        `Gộp sẽ xóa các bản còn lại, nhưng chỉ người thêm paper hoặc quản trị workspace mới được xóa: “${blocked[0].title}”${blocked.length > 1 ? ` và ${blocked.length - 1} paper khác` : ""}. Hãy chọn bản đó làm bản giữ lại hoặc nhờ người thêm gộp.`,
      );
    const pick = <K extends string>(k: K) =>
      keep[k] ?? others.map((o) => o[k]).find((v) => v !== null && v !== "") ?? null;
    const tags: string[] = [];
    for (const t of [keep, ...others].flatMap((p) => p.tags as string[]))
      if (!tags.some((x) => x.toLowerCase() === t.toLowerCase()) && tags.length < 20) tags.push(t);
    const best = new Map<string, string>();
    for (const r of (
      await c.query("SELECT user_id, status FROM paper_reads WHERE paper_id=ANY($1::int[])", [[keepId, ...mergeIds]])
    ).rows)
      if (!best.has(r.user_id) || STATUS_RANK[r.status] > STATUS_RANK[best.get(r.user_id)!])
        best.set(r.user_id, r.status);
    const cited = Math.max(...[keep, ...others].map((p) => p.cited_by_count ?? -1)),
      authors = keep.authors?.length ? keep.authors : (others.find((o) => o.authors?.length)?.authors ?? []);
    const filled = {
      doi: pick("doi"),
      arxiv_id: pick("arxiv_id"),
      openalex_id: pick("openalex_id"),
      venue: pick("venue"),
      venue_type: pick("venue_type"),
      abstract: pick("abstract"),
      url: pick("url"),
      pdf_url: pick("pdf_url"),
      year: pick("year"),
      work_type: pick("work_type"),
    };
    // Notes from every member move to the kept paper.
    const moved =
      (await c.query("UPDATE paper_notes SET paper_id=$1 WHERE paper_id=ANY($2::int[])", [keepId, mergeIds]))
        .rowCount ?? 0;
    // Experiment runs (lib/experiments.ts) reference papers with ON DELETE SET NULL; re-point the workspace's runs so merging keeps the links.
    let runsMoved = 0;
    if (
      (
        await c.query(
          "SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='experiment_runs' AND column_name='workspace_id'",
        )
      ).rowCount
    )
      runsMoved =
        (await c.query("UPDATE experiment_runs SET paper_id=$1 WHERE paper_id=ANY($2::int[])", [keepId, mergeIds]))
          .rowCount ?? 0;
    // Document links (lib/documents.ts) cascade on paper delete; copy them to the kept paper first.
    if ((await c.query("SELECT to_regclass('document_papers') AS t")).rows[0].t)
      await c.query(
        "INSERT INTO document_papers (document_id, paper_id) SELECT DISTINCT document_id, $1::int FROM document_papers WHERE paper_id=ANY($2::int[]) ON CONFLICT DO NOTHING",
        [keepId, mergeIds],
      );
    await c.query("DELETE FROM papers WHERE workspace_id=$1 AND id=ANY($2::int[])", [s.workspaceId, mergeIds]);
    const paper = (
      await c.query(
        "UPDATE papers SET doi=$3, arxiv_id=$4, openalex_id=$5, venue=$6, venue_type=$7, abstract=$8, url=$9, pdf_url=$10, year=$11, work_type=$12, authors=$13, tags=$14, cited_by_count=$15 WHERE id=$1 AND workspace_id=$2 RETURNING *",
        [
          keepId,
          s.workspaceId,
          filled.doi,
          filled.arxiv_id,
          filled.openalex_id,
          filled.venue,
          filled.venue_type,
          filled.abstract,
          filled.url,
          filled.pdf_url,
          filled.year,
          filled.work_type,
          JSON.stringify(authors),
          tags,
          cited < 0 ? null : cited,
        ],
      )
    ).rows[0];
    if (best.size)
      await c.query(
        "INSERT INTO paper_reads (paper_id, user_id, status) SELECT $1, u, st FROM unnest($2::text[], $3::text[]) AS t(u, st) ON CONFLICT (paper_id, user_id) DO UPDATE SET status=EXCLUDED.status, updated_at=NOW()",
        [keepId, [...best.keys()], [...best.values()]],
      );
    await c.query("COMMIT");
    return {
      paper: (await withReads(s, [paper]))[0],
      merged: mergeIds.length,
      notes_moved: moved,
      runs_moved: runsMoved,
    };
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
