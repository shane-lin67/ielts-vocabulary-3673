/** Lightweight Cloudflare Worker for static assets and progress sync. */

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
}

interface WordProgress {
  dots: number;
  seenCount: number;
  knownStreak: number;
  lastResult: "known" | "unknown" | null;
  updatedAt: number;
}

interface ViewState {
  selectedChapter: string;
  filterMode: "ALL" | "HARD";
  testDirection: "EN_TO_CN" | "CN_TO_EN";
  autoSpeak: boolean;
  currentWordId: number | null;
  updatedAt: number;
}

interface SyncState {
  progress: Record<string, WordProgress>;
  view: ViewState | null;
  resetAt: number;
}

interface SyncRow {
  progress_json: string;
  view_json: string;
  reset_at: number;
  revision: number;
}

const SYNC_PATH = "/api/v1/sync-progress";
const MAX_SYNC_BODY_BYTES = 900_000;
const MAX_WORD_ID = 4_000;
const ALLOWED_SYNC_ORIGINS = new Set([
  "null",
  "https://ielts-vocab-3673.urnotlinxia.workers.dev",
]);

function corsHeaders(request: Request): HeadersInit {
  const origin = request.headers.get("Origin");
  if (!origin || !ALLOWED_SYNC_ORIGINS.has(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "PUT, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function jsonResponse(request: Request, body: unknown, status = 200): Response {
  const requestId = crypto.randomUUID();
  return Response.json(body, {
    status,
    headers: {
      ...corsHeaders(request),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Request-Id": requestId,
    },
  });
}

function syncResponse(
  request: Request,
  progressJson: string,
  viewJson: string,
  resetAt: number,
  revision: number,
  syncedAt: number,
): Response {
  const requestId = crypto.randomUUID();
  const body = `{"data":{"progress":${progressJson},"view":${viewJson},"resetAt":${resetAt},"revision":${revision},"syncedAt":${syncedAt}}}`;
  return new Response(body, {
    status: 200,
    headers: {
      ...corsHeaders(request),
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "X-Request-Id": requestId,
    },
  });
}

function problem(request: Request, status: number, title: string, detail: string): Response {
  return jsonResponse(request, {
    type: `https://ielts-vocab-3673.urnotlinxia.workers.dev/problems/${status}`,
    title,
    status,
    detail,
  }, status);
}

function normalizeSyncCode(value: string): string {
  return value.toUpperCase().replace(/[\s-]/g, "");
}

function getSyncCode(request: Request): string | null {
  const authorization = request.headers.get("Authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const code = normalizeSyncCode(match[1]);
  return /^[A-HJ-NP-Z2-9]{16}$/.test(code) ? code : null;
}

async function hashSyncCode(code: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function safeJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function clampInteger(value: unknown, min: number, max: number): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return min;
  return Math.min(max, Math.max(min, Math.trunc(numberValue)));
}

function sanitizeProgress(value: unknown): Record<string, WordProgress> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const sanitized: Record<string, WordProgress> = {};
  for (const [rawId, rawProgress] of Object.entries(value)) {
    const id = Number(rawId);
    if (!Number.isInteger(id) || id < 1 || id > MAX_WORD_ID) continue;
    if (!rawProgress || typeof rawProgress !== "object" || Array.isArray(rawProgress)) continue;
    const progress = rawProgress as Record<string, unknown>;
    const lastResult = progress.lastResult === "known" || progress.lastResult === "unknown"
      ? progress.lastResult
      : null;
    sanitized[String(id)] = {
      dots: clampInteger(progress.dots, 0, 10_000),
      seenCount: clampInteger(progress.seenCount, 0, 100_000),
      knownStreak: clampInteger(progress.knownStreak, 0, 100_000),
      lastResult,
      updatedAt: clampInteger(progress.updatedAt, 0, Number.MAX_SAFE_INTEGER),
    };
  }
  return sanitized;
}

function sanitizeView(value: unknown): ViewState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const view = value as Record<string, unknown>;
  const selectedChapter = String(view.selectedChapter ?? "ALL");
  if (selectedChapter !== "ALL" && !/^([1-9]|1[0-9]|2[0-2])$/.test(selectedChapter)) return null;
  return {
    selectedChapter,
    filterMode: view.filterMode === "HARD" ? "HARD" : "ALL",
    testDirection: view.testDirection === "CN_TO_EN" ? "CN_TO_EN" : "EN_TO_CN",
    autoSpeak: view.autoSpeak !== false,
    currentWordId: view.currentWordId !== null && view.currentWordId !== undefined && Number.isInteger(Number(view.currentWordId))
      ? clampInteger(view.currentWordId, 1, MAX_WORD_ID)
      : null,
    updatedAt: clampInteger(view.updatedAt, 0, Number.MAX_SAFE_INTEGER),
  };
}

function parseStoredState(row: SyncRow | null): SyncState {
  return {
    // Stored progress has already passed sanitizeProgress before it reaches D1.
    // Avoid walking thousands of entries a second time on every sync request.
    progress: (row ? safeJsonObject(row.progress_json) : {}) as Record<string, WordProgress>,
    view: sanitizeView(row ? safeJsonObject(row.view_json) : null),
    resetAt: clampInteger(row?.reset_at, 0, Number.MAX_SAFE_INTEGER),
  };
}

function mergeSyncState(remote: SyncState, incoming: SyncState): SyncState {
  const resetAt = Math.max(remote.resetAt, incoming.resetAt);
  const mergedProgress: Record<string, WordProgress> = { ...remote.progress };

  if (resetAt > 0) {
    for (const [id, word] of Object.entries(mergedProgress)) {
      if (word.updatedAt <= resetAt) delete mergedProgress[id];
    }
  }

  for (const [id, incomingWord] of Object.entries(incoming.progress)) {
    if (resetAt > 0 && incomingWord.updatedAt <= resetAt) continue;
    const remoteWord = mergedProgress[id];
    if (!remoteWord) {
      if (incomingWord.seenCount !== 0 || incomingWord.dots !== 0 || incomingWord.knownStreak !== 0) {
        mergedProgress[id] = incomingWord;
      }
      continue;
    }

    const latest = incomingWord.updatedAt >= remoteWord.updatedAt ? incomingWord : remoteWord;
    const dots = Math.max(remoteWord.dots, incomingWord.dots);
    const seenCount = Math.max(remoteWord.seenCount, incomingWord.seenCount);
    const updatedAt = Math.max(remoteWord.updatedAt, incomingWord.updatedAt);
    if (seenCount === 0 && dots === 0 && latest.knownStreak === 0) {
      delete mergedProgress[id];
      continue;
    }
    if (
      latest !== remoteWord
      || dots !== remoteWord.dots
      || seenCount !== remoteWord.seenCount
      || updatedAt !== remoteWord.updatedAt
    ) {
      mergedProgress[id] = { ...latest, dots, seenCount, updatedAt };
    }
  }

  const remoteViewAt = remote.view?.updatedAt ?? 0;
  const incomingViewAt = incoming.view?.updatedAt ?? 0;
  return {
    progress: mergedProgress,
    view: !remote.view || incomingViewAt > remoteViewAt ? incoming.view : remote.view,
    resetAt,
  };
}

async function handleSync(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  if (request.method !== "PUT") {
    return problem(request, 405, "Method Not Allowed", "This endpoint only accepts PUT requests.");
  }
  if (!env.DB) {
    return problem(request, 503, "Sync Unavailable", "The progress database is not configured.");
  }

  const code = getSyncCode(request);
  if (!code) {
    return problem(request, 401, "Invalid Sync Code", "Provide a valid 16-character sync code.");
  }
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > MAX_SYNC_BODY_BYTES) {
    return problem(request, 413, "Payload Too Large", "The progress payload is too large.");
  }

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid body");
    body = parsed as Record<string, unknown>;
  } catch {
    return problem(request, 400, "Invalid JSON", "The request body must be a JSON object.");
  }

  const incoming: SyncState = {
    progress: sanitizeProgress(body.progress),
    view: sanitizeView(body.view),
    resetAt: clampInteger(body.resetAt, 0, Number.MAX_SAFE_INTEGER),
  };
  const syncId = await hashSyncCode(code);
  const now = Date.now();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const row = await env.DB.prepare(
      "SELECT progress_json, view_json, reset_at, revision FROM sync_profiles WHERE sync_id = ?"
    ).bind(syncId).first<SyncRow>();

    if (!row) {
      const progressJson = JSON.stringify(incoming.progress);
      const viewJson = JSON.stringify(incoming.view ?? {});
      if (progressJson.length + viewJson.length > MAX_SYNC_BODY_BYTES) {
        return problem(request, 413, "Payload Too Large", "The merged progress payload is too large.");
      }
      const result = await env.DB.prepare(
        "INSERT OR IGNORE INTO sync_profiles (sync_id, progress_json, view_json, reset_at, revision, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)"
      ).bind(syncId, progressJson, viewJson, incoming.resetAt, now, now).run();
      if ((result.meta.changes ?? 0) === 1) {
        return syncResponse(request, progressJson, viewJson, incoming.resetAt, 1, now);
      }
      continue;
    }

    const merged = mergeSyncState(parseStoredState(row), incoming);
    const progressJson = JSON.stringify(merged.progress);
    const viewJson = JSON.stringify(merged.view ?? {});
    if (progressJson.length + viewJson.length > MAX_SYNC_BODY_BYTES) {
      return problem(request, 413, "Payload Too Large", "The merged progress payload is too large.");
    }

    if (
      row
      && progressJson === row.progress_json
      && viewJson === row.view_json
      && merged.resetAt === row.reset_at
    ) {
      return syncResponse(request, progressJson, viewJson, merged.resetAt, row.revision, now);
    }

    const nextRevision = row.revision + 1;
    const result = await env.DB.prepare(
      "UPDATE sync_profiles SET progress_json = ?, view_json = ?, reset_at = ?, revision = ?, updated_at = ? WHERE sync_id = ? AND revision = ?"
    ).bind(progressJson, viewJson, merged.resetAt, nextRevision, now, syncId, row.revision).run();
    if ((result.meta.changes ?? 0) === 1) {
      return syncResponse(request, progressJson, viewJson, merged.resetAt, nextRevision, now);
    }
  }

  return problem(request, 409, "Sync Conflict", "Progress changed concurrently. Please retry.");
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === SYNC_PATH) {
      return handleSync(request, env);
    }

    // Keep the proven mobile layout: a tiny static shell hosts the standalone
    // vocabulary document in an iframe. This avoids the Vinext SSR runtime while
    // preserving the iOS/iPadOS browsing context used before the lightweight deploy.
    if (url.pathname === "/") url.pathname = "/index.html";
    return env.ASSETS.fetch(new Request(url, request));
  },
};

export default worker;
