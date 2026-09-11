import {
  cookieHeader,
  getCookie,
  randomHex,
  sha256Hex,
  signPayload,
  timingSafeEqual,
  verifyPayload,
} from "./util";
import {
  canRead,
  create,
  getVersion,
  grant,
  listGrants,
  listMine,
  listProjects,
  listShared,
  listVersions,
  remove,
  resolveAccess,
  revoke,
  STATUS_ORDER,
  update,
  validStatus,
} from "./drafts";
import {
  adminPage,
  dashboardFragment,
  dashboardPage,
  draftShellHeader,
  draftShellPage,
  editPage,
  errorPage,
  injectEmbed,
  installPage,
  keysPage,
  layout,
  loginPage,
  sharePage,
} from "./ui";
import { LOGO_PNG, FAVICON_PNG } from "./assets";

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export interface Env {
  DB: D1Database;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;
  DEV_MODE?: string;
  DEV_LOGIN_SECRET?: string;
}

interface UserRow {
  id: number;
  github_id: number;
  login: string;
  status: string;
  is_admin?: number;
  admin?: boolean;
  pending?: number;
}

const SESSION_COOKIE = "dl_session";
const STATE_COOKIE = "dl_state";
const SESSION_TTL_S = 30 * 24 * 3600;
const MAX_BODY = 4 * 1024 * 1024;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
  });
}

function html(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store", "Content-Security-Policy": "frame-ancestors 'none'", ...headers },
  });
}

// Draft bodies are hostile HTML. The `sandbox` directive is not optional: an
// embed URL opened as a top-level document must never run same-origin, or the
// draft could script the viewer's session (frame /dashboard, read
// contentDocument, navigate out).
const EMBED_CSP = "default-src 'self' https: data: 'unsafe-inline' 'unsafe-eval'; connect-src 'none'; form-action 'none'; sandbox allow-scripts allow-popups; frame-ancestors 'self'; base-uri 'none'";

const THEME_JS = `(function () {
  var KEY = "dl-theme";
  var root = document.documentElement;
  function prefersDark() {
    return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  }
  function stored() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function apply() {
    var dark = stored() ? stored() === "dark" : prefersDark();
    root.classList.toggle("dark", dark);
    root.style.colorScheme = dark ? "dark" : "light";
  }
  window.dlApplyTheme = apply;
  window.dlToggleTheme = function () {
    var next = (stored() ? stored() === "dark" : prefersDark()) ? "light" : "dark";
    try { localStorage.setItem(KEY, next); } catch (e) {}
    apply();
  };
  apply();
})();`;

function redirect(location: string, extraHeaders: [string, string][] = []): Response {
  return new Response(null, { status: 303, headers: [...extraHeaders, ["Location", location]] });
}

function baseUrl(req: Request): { origin: string; secure: boolean } {
  const url = new URL(req.url);
  return { origin: `${url.protocol}//${url.host}`, secure: url.protocol === "https:" };
}

function crossSiteBlocked(req: Request, origin: string): boolean {
  const site = req.headers.get("Sec-Fetch-Site");
  if (site) return site !== "same-origin";
  const originHeader = req.headers.get("Origin");
  if (originHeader) return originHeader !== origin;
  return false;
}

function admitted(u: UserRow | null): UserRow | null {
  return u && (u.status === "approved" || (u.is_admin === 1 && u.status !== "banned")) ? u : null;
}

async function getUser(env: Env, req: Request): Promise<UserRow | null> {
  if (!env.SESSION_SECRET) return null;
  const payload = await verifyPayload(env.SESSION_SECRET, getCookie(req, SESSION_COOKIE));
  if (!payload || typeof payload.uid !== "number") return null;
  if (typeof payload.exp === "number" && payload.exp < Date.now()) return null;
  const user = admitted(await env.DB.prepare("SELECT id, github_id, login, status, is_admin FROM users WHERE id = ?").bind(payload.uid).first<UserRow>());
  if (user && user.is_admin === 1) {
    const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE status = 'pending'").first<{ n: number }>();
    user.admin = true;
    user.pending = c?.n ?? 0;
  }
  return user;
}

async function getUserByApiKey(env: Env, req: Request, ctx: ExecutionContext): Promise<UserRow | null> {
  const m = (req.headers.get("Authorization") ?? "").match(/^Bearer (dl_[0-9a-f]{32})$/);
  if (!m) return null;
  const hash = await sha256Hex(m[1]);
  const key = await env.DB.prepare("SELECT id, user_id FROM api_keys WHERE key_hash = ?").bind(hash).first<{ id: number; user_id: number }>();
  if (!key) return null;
  ctx.waitUntil(env.DB.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").bind(Date.now(), key.id).run());
  return admitted(await env.DB.prepare("SELECT id, github_id, login, status, is_admin FROM users WHERE id = ?").bind(key.user_id).first<UserRow>());
}

async function ghApi(path: string, opts: RequestInit = {}): Promise<any> {
  const res = await fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: { "User-Agent": "draftlink", Accept: "application/vnd.github+json", ...(opts.headers ?? {}) },
  });
  if (!res.ok) return null;
  return await res.json();
}

async function resolveHandle(login: string): Promise<{ github_id: number; login: string } | null> {
  const clean = login.trim().replace(/^@/, "");
  if (!/^[A-Za-z0-9-]{1,39}$/.test(clean)) return null;
  const u = await ghApi(`/users/${encodeURIComponent(clean)}`);
  if (!u || typeof u.id !== "number") return null;
  return { github_id: u.id, login: u.login };
}

function parseListQuery(url: URL): { q: string; filter: string; project: string } {
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 200);
  const filterRaw = url.searchParams.get("filter") ?? "all";
  const filter = STATUS_ORDER.includes(filterRaw as never) ? filterRaw : "all";
  const project = (url.searchParams.get("project") ?? "").trim().slice(0, 100);
  return { q, filter, project };
}

function formDraftBody(fd: FormData, fallback: string): Promise<string> {
  const file = fd.get("file");
  if (file && typeof file === "object" && "size" in file && (file as File).size > 0) return (file as File).text();
  const t = String(fd.get("body") ?? "").trim();
  return Promise.resolve(t || fallback);
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const { origin, secure } = baseUrl(req);

    if (path === "/healthz") return new Response("ok");

    if (path === "/logo.png" || path === "/favicon.png" || path === "/favicon.ico") {
      return new Response(base64ToBytes(path === "/logo.png" ? LOGO_PNG : FAVICON_PNG), {
        headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=604800" },
      });
    }

    if (path === "/theme.js" && (req.method === "GET" || req.method === "HEAD")) {
      return new Response(THEME_JS, {
        headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=300" },
      });
    }

    if (path.startsWith("/d/") && path.length > 3 && (req.method === "GET" || req.method === "HEAD")) {
      const id = path.slice(3);
      const viewer = (await getUser(env, req)) ?? (await getUserByApiKey(env, req, ctx));
      const access = await resolveAccess(env.DB, id, viewer);
      if (!access || !canRead(access)) return html(errorPage(origin, 404, "No such draft."), 404);
      const versions = await listVersions(env.DB, id);
      const params = url.searchParams;

      if (params.get("meta") === "1") {
        return html(draftShellHeader({ access, versions, versionId: null }));
      }

      const vParam = params.get("v");
      const versionId = vParam && versions.some((v) => v.id === Number(vParam)) ? Number(vParam) : null;

      if (params.get("embed") === "1") {
        const body = versionId !== null ? ((await getVersion(env.DB, id, versionId))?.body ?? access.draft.body) : access.draft.body;
        return new Response(injectEmbed(body), {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Robots-Tag": "noindex",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": EMBED_CSP,
            "Referrer-Policy": "no-referrer",
          },
        });
      }

      return html(draftShellPage({ access, versions, versionId }), 200, { "X-Robots-Tag": "noindex" });
    }

    if (path === "/login" && req.method === "GET") {
      const user = await getUser(env, req);
      if (user) return redirect("/dashboard");
      return html(loginPage(origin, { configured: !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET && env.SESSION_SECRET), error: url.searchParams.get("error") ?? undefined }));
    }

    if (path === "/auth/github" && req.method === "GET") {
      if (!env.GITHUB_CLIENT_ID || !env.SESSION_SECRET) return redirect("/login?error=Not+configured");
      const state = randomHex(16);
      const signed = await signPayload(env.SESSION_SECRET, { n: state, exp: Date.now() + 600_000 });
      const redirectUri = `${origin}/auth/callback`;
      return redirect(
        `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(env.GITHUB_CLIENT_ID)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=read:user&state=${state}`,
        [cookieHeader(STATE_COOKIE, signed, 600, secure)]
      );
    }

    if (path === "/auth/callback" && req.method === "GET") {
      if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !env.SESSION_SECRET) return redirect("/login?error=Not+configured");
      const oauthErr = url.searchParams.get("error");
      if (oauthErr) return redirect(`/login?error=${encodeURIComponent(oauthErr)}`);
      const stateParam = url.searchParams.get("state");
      const stored = await verifyPayload(env.SESSION_SECRET, getCookie(req, STATE_COOKIE));
      if (!stateParam || !stored || stored.n !== stateParam) return redirect("/login?error=Invalid+state,+try+again");
      const code = url.searchParams.get("code");
      if (!code) return redirect("/login?error=Missing+code");
      const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "draftlink" },
        body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: `${origin}/auth/callback` }),
      });
      const tokenData = (await tokenRes.json()) as { access_token?: string };
      if (!tokenData.access_token) return redirect("/login?error=Token+exchange+failed");
      const ghUser = await ghApi("/user", { headers: { Authorization: `Bearer ${tokenData.access_token}` } });
      if (!ghUser?.id) return redirect("/login?error=Could+not+read+GitHub+profile");
      const inserted = await env.DB.prepare(
        "INSERT INTO users (github_id, login, created_at, status) VALUES (?, ?, ?, 'pending') ON CONFLICT(github_id) DO UPDATE SET login = excluded.login RETURNING id, status"
      )
        .bind(ghUser.id, String(ghUser.login ?? ""), Date.now())
        .first<{ id: number; status: string }>();
      if (!inserted) return redirect("/login?error=Could+not+create+account");
      let status = inserted.status;
      if (status === "pending") {
        // Bootstrap: an instance with no admin yet promotes its first sign-in.
        // Banned users are never promoted.
        const r = await env.DB.prepare(
          "UPDATE users SET status = 'approved', is_admin = 1 WHERE id = ? AND NOT EXISTS (SELECT 1 FROM users WHERE is_admin = 1)"
        )
          .bind(inserted.id)
          .run();
        if ((r.meta.changes ?? 0) > 0) status = "approved";
      }
      if (status !== "approved") {
        const msg =
          status === "banned"
            ? "This account has been banned. Contact the admin if you think this is a mistake."
            : "Your account is pending approval. An admin will review it shortly — check back later.";
        return html(errorPage(origin, 403, msg));
      }
      const session = await signPayload(env.SESSION_SECRET, { uid: inserted.id, exp: Date.now() + SESSION_TTL_S * 1000 });
      return redirect("/dashboard", [cookieHeader(STATE_COOKIE, "", 0, secure), cookieHeader(SESSION_COOKIE, session, SESSION_TTL_S, secure)]);
    }

    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      !path.startsWith("/api/") &&
      !path.startsWith("/auth/") &&
      crossSiteBlocked(req, origin)
    ) {
      return html(errorPage(origin, 403, "Cross-site request blocked."), 403);
    }

    if (path === "/logout" && req.method === "POST") {
      return redirect("/login", [cookieHeader(SESSION_COOKIE, "", 0, secure)]);
    }

    if (env.DEV_MODE === "1" && path === "/dev/login" && req.method === "GET" && env.SESSION_SECRET) {
      const keyOk = timingSafeEqual(await sha256Hex(url.searchParams.get("key") ?? ""), await sha256Hex(env.DEV_LOGIN_SECRET ?? ""));
      if (!env.DEV_LOGIN_SECRET || !keyOk) return json({ error: "dev key required" }, 403);
      const loginName = url.searchParams.get("as") ?? "dev";
      const hash = await sha256Hex(loginName);
      const syntheticId = 900_000_000 + (Number.parseInt(hash.slice(0, 8), 16) % 100_000_000);
      const u = await env.DB.prepare(
        "INSERT INTO users (github_id, login, created_at, status) VALUES (?, ?, ?, 'approved') ON CONFLICT(github_id) DO UPDATE SET login = excluded.login RETURNING id"
      )
        .bind(syntheticId, loginName, Date.now())
        .first<{ id: number }>();
      const session = await signPayload(env.SESSION_SECRET, { uid: u!.id, exp: Date.now() + SESSION_TTL_S * 1000 });
      return redirect("/dashboard", [cookieHeader(SESSION_COOKIE, session, SESSION_TTL_S, secure)]);
    }

    if (path === "/" && req.method === "GET") {
      const user = await getUser(env, req);
      return redirect(user ? "/dashboard" : "/login");
    }

    if (path === "/api/drafts" || path.startsWith("/api/drafts/")) {
      const apiUser = await getUserByApiKey(env, req, ctx);
      if (!apiUser) return json({ error: "unauthorized: set Authorization: Bearer dl_..." }, 401);

      if (req.method === "POST" && path === "/api/drafts") {
        const len = Number(req.headers.get("Content-Length") ?? 0);
        if (len > MAX_BODY) return json({ error: "body too large (4MB max)" }, 413);
        const bodyText = await req.text();
        if (!bodyText) return json({ error: "empty body: send raw HTML as request body" }, 400);
        if (bodyText.length > MAX_BODY) return json({ error: "body too large (4MB max)" }, 413);
        const id = await create(env.DB, apiUser.id, {
          title: url.searchParams.get("title")?.trim() || undefined,
          project: url.searchParams.get("project")?.trim() || undefined,
          status: validStatus(url.searchParams.get("status")),
          body: bodyText,
        });
        return json({ id, url: `${origin}/d/${id}` }, 201);
      }

      if (req.method === "GET" && path === "/api/drafts") {
        const { q, filter, project } = parseListQuery(url);
        const [mine, shared, projects] = await Promise.all([
          listMine(env.DB, apiUser.id, q, filter, project),
          listShared(env.DB, apiUser.github_id, q, filter, project),
          listProjects(env.DB, apiUser.id, apiUser.github_id),
        ]);
        return json({ mine, shared, projects });
      }

      const apiId = path.slice("/api/drafts/".length);

      if (req.method === "GET" && apiId.endsWith("/raw")) {
        const access = await resolveAccess(env.DB, apiId.slice(0, -4), apiUser);
        if (!access || !canRead(access)) return json({ error: "not found" }, 404);
        return new Response(access.draft.body, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Disposition": `attachment; filename="${access.draft.id}.html"`,
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }

      if (req.method === "PUT" || req.method === "PATCH") {
        const access = await resolveAccess(env.DB, apiId, apiUser);
        if (!access || !access.canEdit) return json({ error: "not found" }, 404);
        const wantsVisibilityChange = url.searchParams.has("public");
        if (wantsVisibilityChange && !access.isOwner) return json({ error: "only the owner can change visibility" }, 403);
        if (Number(req.headers.get("Content-Length") ?? 0) > MAX_BODY) return json({ error: "body too large (4MB max)" }, 413);
        const newText = await req.text();
        if (newText.length > MAX_BODY) return json({ error: "body too large (4MB max)" }, 413);
        const makePublic = ["true", "1", "yes"].includes((url.searchParams.get("public") ?? "").toLowerCase());
        await update(env.DB, apiId, {
          title: url.searchParams.get("title")?.trim() || undefined,
          project: url.searchParams.get("project")?.trim() || undefined,
          status: url.searchParams.has("status") ? validStatus(url.searchParams.get("status")) : undefined,
          isPublic: wantsVisibilityChange ? (makePublic ? 1 : 0) : undefined,
          body: newText || undefined,
        });
        return json({ ok: true, url: `${origin}/d/${apiId}`, is_public: wantsVisibilityChange ? makePublic : !!access.draft.is_public });
      }

      if (req.method === "DELETE") {
        const access = await resolveAccess(env.DB, apiId, apiUser);
        if (!access || !access.isOwner) return json({ error: "not found" }, 404);
        await remove(env.DB, apiId);
        return json({ ok: true });
      }

      return json({ error: "method not allowed" }, 405);
    }

    const user = await getUser(env, req);
    if (!user) return redirect("/login");

    if (path === "/dashboard" && req.method === "GET") {
      const { q, filter, project } = parseListQuery(url);
      const [mine, shared, projects] = await Promise.all([
        listMine(env.DB, user.id, q, filter, project),
        listShared(env.DB, user.github_id, q, filter, project),
        listProjects(env.DB, user.id, user.github_id),
      ]);
      const options = { q, filter, project, projects, mine, shared };
      return url.searchParams.get("fragment") === "1" ? html(dashboardFragment(options)) : html(dashboardPage(origin, user, options));
    }

    if (path === "/drafts" && req.method === "POST") {
      const fd = await req.formData();
      const bodyText = await formDraftBody(fd, "");
      if (!bodyText) return html(errorPage(origin, 400, "Draft body was empty.", user), 400);
      if (bodyText.length > MAX_BODY) return html(errorPage(origin, 413, "Body too large (4MB max).", user), 413);
      await create(env.DB, user.id, {
        title: String(fd.get("title") ?? "").trim() || undefined,
        project: String(fd.get("project") ?? "").trim() || undefined,
        body: bodyText,
      });
      return redirect("/dashboard");
    }

    const draftId = path.match(/^\/drafts\/([A-Za-z0-9]+)(?:\/([a-z]+))?$/)?.[1];
    const action = path.match(/^\/drafts\/[A-Za-z0-9]+(?:\/([a-z]+))?$/)?.[1];
    if (draftId) {
      const access = await resolveAccess(env.DB, draftId, user);
      if (!access || (!access.isOwner && !access.canEdit)) return html(errorPage(origin, 404, "No such draft.", user), 404);

      if (req.method === "GET" && action === "edit") {
        if (!access.canEdit) return html(errorPage(origin, 403, "You don't have write access.", user), 403);
        return html(editPage(origin, user, access.draft));
      }

      if (req.method === "POST" && action === "edit") {
        if (!access.canEdit) return html(errorPage(origin, 403, "You don't have write access.", user), 403);
        const fd = await req.formData();
        const bodyText = await formDraftBody(fd, access.draft.body);
        if (bodyText.length > MAX_BODY) return html(errorPage(origin, 413, "Body too large (4MB max).", user), 413);
        await update(env.DB, draftId, {
          title: String(fd.get("title") ?? "").trim() || undefined,
          project: String(fd.get("project") ?? "").trim() || undefined,
          body: bodyText,
        });
        return redirect("/dashboard");
      }

      if (req.method === "POST" && action === "status") {
        if (!access.canEdit) return html(errorPage(origin, 403, "No write access.", user), 403);
        const fd = await req.formData();
        await update(env.DB, draftId, { status: validStatus(String(fd.get("status") ?? "")) });
        return redirect("/dashboard");
      }

      if (req.method === "GET" && action === "share") {
        if (!access.isOwner) return html(errorPage(origin, 403, "Only the owner can manage sharing.", user), 403);
        return html(sharePage(origin, user, access.draft, await listGrants(env.DB, draftId)));
      }

      if (req.method === "POST" && action === "share") {
        if (!access.isOwner) return html(errorPage(origin, 403, "Only the owner can manage sharing.", user), 403);
        const fd = await req.formData();
        const resolved = await resolveHandle(String(fd.get("login") ?? ""));
        if (!resolved) {
          return html(sharePage(origin, user, access.draft, await listGrants(env.DB, draftId), `Couldn't find GitHub user "${String(fd.get("login") ?? "")}".`), 400);
        }
        await grant(env.DB, draftId, resolved);
        return redirect(`/drafts/${draftId}/share`);
      }

      if (req.method === "POST" && action === "revoke") {
        if (!access.isOwner) return html(errorPage(origin, 403, "Only the owner can manage sharing.", user), 403);
        const fd = await req.formData();
        const gid = Number(fd.get("gid"));
        if (!Number.isInteger(gid)) return html(errorPage(origin, 400, "Missing grant id.", user), 400);
        await revoke(env.DB, draftId, gid);
        return redirect(`/drafts/${draftId}/share`);
      }

      if (req.method === "POST" && action === "visibility") {
        if (!access.isOwner) return html(errorPage(origin, 403, "Only the owner can change visibility.", user), 403);
        const fd = await req.formData();
        await update(env.DB, draftId, { isPublic: String(fd.get("value") ?? "") === "public" ? 1 : 0 });
        return redirect(`/drafts/${draftId}/share`);
      }

      if (req.method === "POST" && action === "restore") {
        if (!access.isOwner) return html(errorPage(origin, 403, "Only the owner can restore versions.", user), 403);
        const fd = await req.formData();
        const vid = Number(fd.get("v"));
        const version = Number.isInteger(vid) ? await getVersion(env.DB, draftId, vid) : null;
        if (!version) return html(errorPage(origin, 404, "That version no longer exists.", user), 404);
        await update(env.DB, draftId, { body: version.body });
        return redirect(`/d/${draftId}`);
      }

      if (req.method === "POST" && action === "delete") {
        if (!access.isOwner) return html(errorPage(origin, 403, "Only the owner can delete.", user), 403);
        await remove(env.DB, draftId);
        return redirect("/dashboard");
      }

      return html(errorPage(origin, 404, "Unknown action.", user), 404);
    }

    if (path.startsWith("/admin") && (path === "/admin" || path === "/admin/approve" || path === "/admin/ban" || path === "/admin/make-admin" || path === "/admin/remove-admin")) {
      if (!user || user.is_admin !== 1) return html(errorPage(origin, 404, "Nothing here.", user), 404);
      if (req.method === "POST") {
        const fd = await req.formData();
        const id = Number(fd.get("id"));
        if (Number.isInteger(id)) {
          if (path === "/admin/approve" || path === "/admin/ban") {
            const status = path === "/admin/approve" ? "approved" : "banned";
            await env.DB.prepare("UPDATE users SET status = ? WHERE id = ? AND id != ?").bind(status, id, user.id).run();
          } else if (path === "/admin/make-admin") {
            await env.DB.prepare("UPDATE users SET is_admin = 1, status = 'approved' WHERE id = ?").bind(id).run();
          } else {
            // Never remove the last remaining admin — lockout prevention.
            await env.DB.prepare("UPDATE users SET is_admin = 0 WHERE id = ? AND (SELECT COUNT(*) FROM users WHERE is_admin = 1) > 1").bind(id).run();
          }
        }
        return redirect("/admin");
      }
      const { results } = await env.DB.prepare("SELECT id, login, status, is_admin, created_at FROM users ORDER BY created_at DESC").all<{ id: number; login: string; status: string; is_admin: number; created_at: number }>();
      return html(adminPage(origin, user, results ?? []));
    }

    if (path === "/install" && req.method === "GET") return html(installPage(origin, user));

    if (path === "/keys" && req.method === "GET") {
      const { results } = await env.DB.prepare("SELECT id, prefix, label, created_at, last_used_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC").bind(user.id).all<{ id: number; prefix: string; label: string; created_at: number; last_used_at: number | null }>();
      return html(keysPage(origin, user, results ?? []));
    }

    if (path === "/keys" && req.method === "POST") {
      const fd = await req.formData();
      const label = String(fd.get("label") ?? "").trim().slice(0, 60) || "cli";
      const token = `dl_${randomHex(16)}`;
      const prefix = token.slice(0, 9);
      await env.DB.prepare("INSERT INTO api_keys (user_id, key_hash, prefix, label, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(user.id, await sha256Hex(token), prefix, label, Date.now())
        .run();
      const { results } = await env.DB.prepare("SELECT id, prefix, label, created_at, last_used_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC").bind(user.id).all<{ id: number; prefix: string; label: string; created_at: number; last_used_at: number | null }>();
      return html(keysPage(origin, user, results ?? [], token));
    }

    if (path === "/keys/revoke" && req.method === "POST") {
      const fd = await req.formData();
      const id = Number(fd.get("id"));
      if (Number.isInteger(id)) await env.DB.prepare("DELETE FROM api_keys WHERE id = ? AND user_id = ?").bind(id, user.id).run();
      return redirect("/keys");
    }

    return html(layout({ base: origin, user, title: "404", body: `<div class="mt-24 text-center text-zinc-500">Nothing here.</div>` }), 404);
  },
};
