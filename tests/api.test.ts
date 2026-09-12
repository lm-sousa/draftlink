import { beforeAll, describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";
import { resolveAccess, update } from "../src/drafts";
import { randomHex, sha256Hex, signPayload } from "../src/util";
const migrations = Object.entries(
  import.meta.glob("../migrations/*.sql", { query: "?raw", import: "default", eager: true })
) as [string, string][];

let nextGithubId = 5000;

async function makeUser(login: string): Promise<{ id: number; github_id: number }> {
  const github_id = nextGithubId++;
  const row = await env.DB.prepare("INSERT INTO users (github_id, login, created_at) VALUES (?, ?, ?) RETURNING id")
    .bind(github_id, login, Date.now())
    .first<{ id: number }>();
  return { id: row!.id, github_id };
}

async function makeKey(userId: number): Promise<string> {
  const token = `dl_${randomHex(16)}`;
  await env.DB.prepare("INSERT INTO api_keys (user_id, key_hash, prefix, label, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(userId, await sha256Hex(token), token.slice(0, 9), "test", Date.now())
    .run();
  return token;
}

async function grant(draftId: string, githubId: number, login: string): Promise<void> {
  await env.DB.prepare("INSERT INTO draft_access (draft_id, github_id, login, created_at) VALUES (?, ?, ?, ?)")
    .bind(draftId, githubId, login, Date.now())
    .run();
}

function api(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function post(token: string, params = "", body = "<html><body>hi</body></html>"): Promise<Response> {
  return SELF.fetch(`https://x.test/api/drafts${params}`, { method: "POST", headers: api(token), body });
}

async function createId(token: string, params = "", body?: string): Promise<string> {
  const res = await post(token, params, body);
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

function sessionCookie(userId: number): Promise<string> {
  return signPayload(env.SESSION_SECRET!, { uid: userId, exp: Date.now() + 3_600_000 }).then((t) => `dl_session=${t}`);
}

beforeAll(async () => {
  const statements = migrations
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .flatMap(([, sql]) => sql.split(";").map((s) => s.trim()).filter(Boolean));
  await env.DB.batch(statements.map((sql) => env.DB.prepare(sql)));
});

describe("API key auth", () => {
  it("rejects missing and invalid keys", async () => {
    const none = await SELF.fetch("https://x.test/api/drafts", { method: "POST", body: "x" });
    expect(none.status).toBe(401);
    const bad = await SELF.fetch("https://x.test/api/drafts", {
      method: "POST",
      headers: api(`dl_${"0".repeat(32)}`),
      body: "x",
    });
    expect(bad.status).toBe(401);
  });
});

describe("draft lifecycle", () => {
  it("creates drafts and lists them with metadata", async () => {
    const u = await makeUser("alice");
    const t = await makeKey(u.id);
    const res = await post(t, "?title=Plan&project=repo&status=done");
    expect(res.status).toBe(201);
    const { id, url } = (await res.json()) as { id: string; url: string };
    expect(url).toContain(`/d/${id}`);
    const list = (await (await SELF.fetch("https://x.test/api/drafts", { headers: api(t) })).json()) as {
      mine: { id: string; title: string; status: string }[];
    };
    const row = list.mine.find((r) => r.id === id);
    expect(row?.title).toBe("Plan");
    expect(row?.status).toBe("done");
  });

  it("is private by default", async () => {
    const u = await makeUser("bob");
    const t = await makeKey(u.id);
    const id = await createId(t);
    const anon = await SELF.fetch(`https://x.test/d/${id}`);
    expect(anon.status).toBe(404);
    const raw = await SELF.fetch(`https://x.test/api/drafts/${id}/raw`, { headers: api(t) });
    expect(raw.status).toBe(200);
  });

  it("serves public drafts anonymously", async () => {
    const u = await makeUser("carol");
    const t = await makeKey(u.id);
    const id = await createId(t);
    const put = await SELF.fetch(`https://x.test/api/drafts/${id}?public=true`, { method: "PUT", headers: api(t), body: "" });
    expect(put.status).toBe(200);
    const page = await SELF.fetch(`https://x.test/d/${id}`);
    expect(page.status).toBe(200);
    const anonRaw = await SELF.fetch(`https://x.test/api/drafts/${id}/raw`);
    expect(anonRaw.status).toBe(401);
  });

  it("keeps existing HTML on empty PUT body", async () => {
    const u = await makeUser("ken");
    const t = await makeKey(u.id);
    const id = await createId(t, "", "<html>original</html>");
    await SELF.fetch(`https://x.test/api/drafts/${id}?title=renamed`, { method: "PUT", headers: api(t), body: "" });
    const raw = await SELF.fetch(`https://x.test/api/drafts/${id}/raw`, { headers: api(t) });
    expect(await raw.text()).toBe("<html>original</html>");
  });

  it("update touches only supplied fields", async () => {
    const u = await makeUser("quinn");
    const t = await makeKey(u.id);
    const id = await createId(t, "", "<html>A</html>");
    const access = await resolveAccess(env.DB, id, u);
    await env.DB.prepare("UPDATE drafts SET status = 'done' WHERE id = ?").bind(id).run();
    await update(env.DB, id, { body: "<html>B</html>" });
    const row = await env.DB.prepare("SELECT status, body FROM drafts WHERE id = ?").bind(id).first<{ status: string; body: string }>();
    expect(row!.status).toBe("done");
    expect(row!.body).toBe("<html>B</html>");
  });

  it("updates status via query param and filters by it", async () => {
    const u = await makeUser("judy");
    const t = await makeKey(u.id);
    const id = await createId(t);
    const put = await SELF.fetch(`https://x.test/api/drafts/${id}?status=archived`, { method: "PUT", headers: api(t), body: "" });
    expect(put.status).toBe(200);
    const list = (await (await SELF.fetch("https://x.test/api/drafts?filter=archived", { headers: api(t) })).json()) as {
      mine: { id: string; status: string }[];
    };
    expect(list.mine.some((r) => r.id === id && r.status === "archived")).toBe(true);
    expect(list.mine.every((r) => r.status === "archived")).toBe(true);
    const active = await createId(t, "?title=still%20active");
    const def = (await (await SELF.fetch("https://x.test/api/drafts", { headers: api(t) })).json()) as { mine: { id: string; status: string }[] };
    expect(def.mine.some((r) => r.id === active)).toBe(true);
    expect(def.mine.some((r) => r.id === id)).toBe(false);
    await SELF.fetch(`https://x.test/api/drafts/${active}?status=done`, { method: "PUT", headers: api(t), body: "" });
    for (const [filter, want] of [["active", false], ["done", true]] as const) {
      const f = (await (await SELF.fetch(`https://x.test/api/drafts?filter=${filter}`, { headers: api(t) })).json()) as { mine: { id: string }[] };
      expect(f.mine.some((r) => r.id === active)).toBe(want);
    }
  });
});

describe("sharing", () => {
  it("lets grants edit but not delete or flip visibility", async () => {
    const owner = await makeUser("frank");
    const peer = await makeUser("grace");
    const ot = await makeKey(owner.id);
    const pt = await makeKey(peer.id);
    const id = await createId(ot, "?title=Shared");
    await grant(id, peer.github_id, "grace");

    const visibility = await SELF.fetch(`https://x.test/api/drafts/${id}?public=true`, { method: "PUT", headers: api(pt), body: "" });
    expect(visibility.status).toBe(403);

    const put = await SELF.fetch(`https://x.test/api/drafts/${id}?title=Shared2`, { method: "PUT", headers: api(pt), body: "<html>v2</html>" });
    expect(put.status).toBe(200);
    const raw = await SELF.fetch(`https://x.test/api/drafts/${id}/raw`, { headers: api(pt) });
    expect(await raw.text()).toBe("<html>v2</html>");

    const del = await SELF.fetch(`https://x.test/api/drafts/${id}`, { method: "DELETE", headers: api(pt) });
    expect(del.status).toBe(404);
  });

  it("owner delete cascades grants", async () => {
    const owner = await makeUser("heidi");
    const peer = await makeUser("ivan");
    const ot = await makeKey(owner.id);
    const id = await createId(ot);
    await grant(id, peer.github_id, "ivan");

    const del = await SELF.fetch(`https://x.test/api/drafts/${id}`, { method: "DELETE", headers: api(ot) });
    expect(del.status).toBe(200);
    const raw = await SELF.fetch(`https://x.test/api/drafts/${id}/raw`, { headers: api(ot) });
    expect(raw.status).toBe(404);
    const g = await env.DB.prepare("SELECT COUNT(*) AS n FROM draft_access WHERE draft_id = ?").bind(id).first<{ n: number }>();
    expect(g!.n).toBe(0);
  });
});

describe("dashboard sessions", () => {
  it("signed session cookies authenticate the owner", async () => {
    const u = await makeUser("owen");
    const t = await makeKey(u.id);
    const id = await createId(t);
    const page = await SELF.fetch(`https://x.test/d/${id}`, { headers: { Cookie: await sessionCookie(u.id) } });
    expect(page.status).toBe(200);
    const stranger = await makeUser("petra");
    const strangerPage = await SELF.fetch(`https://x.test/d/${id}`, { headers: { Cookie: await sessionCookie(stranger.id) } });
    expect(strangerPage.status).toBe(404);
  });
});

describe("version history", () => {
  it("snapshots the previous body on every real body change", async () => {
    const u = await makeUser("vera");
    const t = await makeKey(u.id);
    const id = await createId(t, "", "<html>v1</html>");
    await SELF.fetch(`https://x.test/api/drafts/${id}`, { method: "PUT", headers: api(t), body: "<html>v2</html>" });
    await SELF.fetch(`https://x.test/api/drafts/${id}`, { method: "PUT", headers: api(t), body: "<html>v3</html>" });
    await SELF.fetch(`https://x.test/api/drafts/${id}`, { method: "PUT", headers: api(t), body: "<html>v3</html>" });
    await SELF.fetch(`https://x.test/api/drafts/${id}?status=done`, { method: "PUT", headers: api(t), body: "" });
    const rows = await env.DB.prepare("SELECT body FROM draft_versions WHERE draft_id = ? ORDER BY id").bind(id).all<{ body: string }>();
    expect(rows.results!.map((r) => r.body)).toEqual(["<html>v1</html>", "<html>v2</html>"]);
  });

  it("prunes beyond the per-draft cap", async () => {
    const u = await makeUser("walt");
    const t = await makeKey(u.id);
    const id = await createId(t, "", "<html>0</html>");
    for (let i = 1; i <= 30; i++) {
      const res = await SELF.fetch(`https://x.test/api/drafts/${id}`, { method: "PUT", headers: api(t), body: `<html>${i}</html>` });
      expect(res.status).toBe(200);
    }
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM draft_versions WHERE draft_id = ?").bind(id).first<{ n: number }>();
    expect(n!.n).toBe(25);
    const raw = await SELF.fetch(`https://x.test/api/drafts/${id}/raw`, { headers: api(t) });
    expect(await raw.text()).toBe("<html>30</html>");
  });

  it("restores a version for the owner only", async () => {
    const u = await makeUser("xena");
    const peer = await makeUser("yuri");
    const t = await makeKey(u.id);
    const id = await createId(t, "", "<html>old</html>");
    await SELF.fetch(`https://x.test/api/drafts/${id}`, { method: "PUT", headers: api(t), body: "<html>new</html>" });
    const v = await env.DB.prepare("SELECT id FROM draft_versions WHERE draft_id = ? ORDER BY id LIMIT 1").bind(id).first<{ id: number }>();
    const form = { Cookie: await sessionCookie(u.id), "Content-Type": "application/x-www-form-urlencoded" };
    const restore = await SELF.fetch(`https://x.test/drafts/${id}/restore`, { method: "POST", redirect: "manual", headers: form, body: `v=${v!.id}` });
    expect(restore.status).toBe(303);
    const raw = await SELF.fetch(`https://x.test/api/drafts/${id}/raw`, { headers: api(t) });
    expect(await raw.text()).toBe("<html>old</html>");
    await grant(id, peer.github_id, "yuri");
    const peerRestore = await SELF.fetch(`https://x.test/drafts/${id}/restore`, {
      method: "POST",
      headers: { Cookie: await sessionCookie(peer.id), "Content-Type": "application/x-www-form-urlencoded" },
      body: `v=${v!.id}`,
    });
    expect(peerRestore.status).toBe(403);
  });
});

describe("draft shell", () => {
  it("serves a sandboxed shell with live meta fragments", async () => {
    const u = await makeUser("zoe");
    const t = await makeKey(u.id);
    const id = await createId(t, "", "<html>shell</html>");
    const cookie = { Cookie: await sessionCookie(u.id) };
    const page = await SELF.fetch(`https://x.test/d/${id}`, { headers: cookie });
    expect(page.status).toBe(200);
    const pageText = await page.text();
    expect(pageText).toContain('sandbox="allow-scripts');
    expect(pageText).toContain("?embed=1");
    expect(pageText).toContain('id="dl-hdr"');

    const embed = await SELF.fetch(`https://x.test/d/${id}?embed=1`, { headers: cookie });
    const csp = embed.headers.get("Content-Security-Policy")!;
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).not.toContain("frame-ancestors 'none'");
    // Private drafts too: the embed must never be able to run same-origin.
    expect(csp).toContain("sandbox allow-scripts");
    expect(embed.headers.get("Referrer-Policy")).toBe("no-referrer");
    const embedText = await embed.text();
    expect(embedText).toContain("dl-size");
    expect(embedText).not.toContain('id="dl-hdr"');

    const meta = await SELF.fetch(`https://x.test/d/${id}?meta=1`, { headers: cookie });
    expect(meta.status).toBe(200);
    expect(await meta.text()).toContain('data-versions="0"');
  });

  it("serves a saved version in the embed", async () => {
    const u = await makeUser("abel");
    const t = await makeKey(u.id);
    const id = await createId(t, "", "<html>first</html>");
    await SELF.fetch(`https://x.test/api/drafts/${id}`, { method: "PUT", headers: api(t), body: "<html>second</html>" });
    const v = await env.DB.prepare("SELECT id FROM draft_versions WHERE draft_id = ? ORDER BY id DESC LIMIT 1").bind(id).first<{ id: number }>();
    const embed = await SELF.fetch(`https://x.test/d/${id}?embed=1&v=${v!.id}`, { headers: { Cookie: await sessionCookie(u.id) } });
    expect(await embed.text()).toContain("<html>first</html>");
  });

  it("deleting a draft removes its versions", async () => {
    const u = await makeUser("dell");
    const t = await makeKey(u.id);
    const id = await createId(t, "", "<html>gone</html>");
    await SELF.fetch(`https://x.test/api/drafts/${id}`, { method: "DELETE", headers: api(t) });
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM draft_versions WHERE draft_id = ?").bind(id).first<{ n: number }>();
    expect(n!.n).toBe(0);
  });
});

describe("account approval", () => {
  it("blocks pending and banned users at the session and API gates", async () => {
    const u = await makeUser("paul");
    const cookie = { Cookie: await sessionCookie(u.id) };
    const ok = await SELF.fetch("https://x.test/dashboard", { headers: cookie });
    expect(ok.status).toBe(200);
    await env.DB.prepare("UPDATE users SET status = 'pending' WHERE id = ?").bind(u.id).run();
    const pending = await SELF.fetch("https://x.test/dashboard", { headers: cookie, redirect: "manual" });
    expect(pending.status).toBe(303);
    await env.DB.prepare("UPDATE users SET status = 'banned' WHERE id = ?").bind(u.id).run();
    const t = await makeKey(u.id);
    const banned = await SELF.fetch("https://x.test/api/drafts", { headers: api(t) });
    expect(banned.status).toBe(401);
  });

  it("install page is gated to approved users", async () => {
    const anon = await SELF.fetch("https://x.test/install", { redirect: "manual" });
    expect(anon.status).toBe(303);
    const u = await makeUser("installee");
    const cookie = { Cookie: await sessionCookie(u.id) };
    const page = await SELF.fetch("https://x.test/install", { headers: cookie });
    expect(page.status).toBe(200);
    const text = await page.text();
    expect(text).toContain("npm install -g draftlink");
    expect(text).toContain("skills add lm-sousa/draftlink");
    await env.DB.prepare("UPDATE users SET status = 'pending' WHERE id = ?").bind(u.id).run();
    const pending = await SELF.fetch("https://x.test/install", { headers: cookie, redirect: "manual" });
    expect(pending.status).toBe(303);
    await env.DB.prepare("UPDATE users SET status = 'approved' WHERE id = ?").bind(u.id).run();
  });

  it("admin approves and bans from the admin page, non-admins see nothing", async () => {
    const admin = await makeUser("root");
    await env.DB.prepare("UPDATE users SET is_admin = 1 WHERE id = ?").bind(admin.id).run();
    const rookie = await makeUser("rookie");
    await env.DB.prepare("UPDATE users SET status = 'pending' WHERE id = ?").bind(rookie.id).run();
    const cookie = { Cookie: await sessionCookie(admin.id), "Content-Type": "application/x-www-form-urlencoded" };

    const page = await SELF.fetch("https://x.test/admin", { headers: { Cookie: cookie.Cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("@rookie");

    const approve = await SELF.fetch("https://x.test/admin/approve", { method: "POST", redirect: "manual", headers: cookie, body: `id=${rookie.id}` });
    expect(approve.status).toBe(303);
    const approved = await env.DB.prepare("SELECT status FROM users WHERE id = ?").bind(rookie.id).first<{ status: string }>();
    expect(approved!.status).toBe("approved");

    const ban = await SELF.fetch("https://x.test/admin/ban", { method: "POST", redirect: "manual", headers: cookie, body: `id=${rookie.id}` });
    expect(ban.status).toBe(303);
    const banned = await env.DB.prepare("SELECT status FROM users WHERE id = ?").bind(rookie.id).first<{ status: string }>();
    expect(banned!.status).toBe("banned");

    const selfBan = await SELF.fetch("https://x.test/admin/ban", { method: "POST", redirect: "manual", headers: cookie, body: `id=${admin.id}` });
    expect(selfBan.status).toBe(303);
    const stillAdmin = await env.DB.prepare("SELECT status FROM users WHERE id = ?").bind(admin.id).first<{ status: string }>();
    expect(stillAdmin!.status).toBe("approved");

    const outsider = await makeUser("outsider");
    const hidden = await SELF.fetch("https://x.test/admin", { headers: { Cookie: await sessionCookie(outsider.id) } });
    expect(hidden.status).toBe(404);
  });
});

describe("admin notifications", () => {
  it("shows the admin link and pending badge only to admins", async () => {
    const admin = await makeUser("root2");
    await env.DB.prepare("UPDATE users SET is_admin = 1 WHERE id = ?").bind(admin.id).run();
    const cookie = { Cookie: await sessionCookie(admin.id) };
    const plain = await (await SELF.fetch("https://x.test/dashboard", { headers: cookie })).text();
    expect(plain).toContain('href="/admin"');
    expect(plain).not.toContain("bg-amber-200");

    const rookie = await makeUser("rookie2");
    await env.DB.prepare("UPDATE users SET status = 'pending' WHERE id = ?").bind(rookie.id).run();
    const badge = await (await SELF.fetch("https://x.test/dashboard", { headers: cookie })).text();
    expect(badge).toContain('href="/admin"');
    expect(badge).toContain(">1</span>");

    const pleb = await makeUser("pleb2");
    const noLink = await (await SELF.fetch("https://x.test/dashboard", { headers: { Cookie: await sessionCookie(pleb.id) } })).text();
    expect(noLink).not.toContain('href="/admin"');
  });
  it("admins promote and demote each other, but the last admin is protected", async () => {
    await env.DB.prepare("UPDATE users SET is_admin = 0").run();
    const a1 = await makeUser("adminone");
    const a2 = await makeUser("admintwo");
    const a3 = await makeUser("admthree");
    await env.DB.prepare("UPDATE users SET is_admin = 1 WHERE id IN (?, ?)").bind(a1.id, a2.id).run();
    await env.DB.prepare("UPDATE users SET status = 'pending' WHERE id = ?").bind(a3.id).run();

    const form = (id: number, cookie: string) => ({
      method: "POST",
      redirect: "manual",
      headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: `id=${id}`,
    });

    // promote: pending user becomes approved admin
    const c1 = await sessionCookie(a1.id);
    await SELF.fetch("https://x.test/admin/make-admin", form(a3.id, c1));
    const promoted = await env.DB.prepare("SELECT is_admin, status FROM users WHERE id = ?").bind(a3.id).first<{ is_admin: number; status: string }>();
    expect(promoted!.is_admin).toBe(1);
    expect(promoted!.status).toBe("approved");

    // demote self while other admins exist
    await SELF.fetch("https://x.test/admin/remove-admin", form(a1.id, c1));
    const demoted = await env.DB.prepare("SELECT is_admin FROM users WHERE id = ?").bind(a1.id).first<{ is_admin: number }>();
    expect(demoted!.is_admin).toBe(0);

    // demote a3 too — now a2 is the last remaining admin
    const c2 = await sessionCookie(a2.id);
    await SELF.fetch("https://x.test/admin/remove-admin", form(a3.id, c2));
    const gone = await env.DB.prepare("SELECT is_admin FROM users WHERE id = ?").bind(a3.id).first<{ is_admin: number }>();
    expect(gone!.is_admin).toBe(0);

    // the last admin can't be removed — even by themselves
    await SELF.fetch("https://x.test/admin/remove-admin", form(a2.id, c2));
    const last = await env.DB.prepare("SELECT is_admin FROM users WHERE id = ?").bind(a2.id).first<{ is_admin: number }>();
    expect(last!.is_admin).toBe(1);
  });

});

describe("security hardening", () => {
  it("raw drafts download instead of executing in a browser context", async () => {
    const u = await makeUser("mallory");
    const t = await makeKey(u.id);
    const id = await createId(t, "", "<html>evil</html>");
    const raw = await SELF.fetch(`https://x.test/api/drafts/${id}/raw`, { headers: api(t) });
    expect(raw.headers.get("Content-Disposition")).toContain("attachment");
  });

  it("a banned admin loses access like anyone else", async () => {
    const admin = await makeUser("root3");
    await env.DB.prepare("UPDATE users SET is_admin = 1 WHERE id = ?").bind(admin.id).run();
    const cookie = { Cookie: await sessionCookie(admin.id) };
    expect((await SELF.fetch("https://x.test/dashboard", { headers: cookie })).status).toBe(200);
    await env.DB.prepare("UPDATE users SET status = 'banned' WHERE id = ?").bind(admin.id).run();
    const banned = await SELF.fetch("https://x.test/dashboard", { headers: cookie, redirect: "manual" });
    expect(banned.status).toBe(303);
  });
});

describe("invite links", () => {
  it("admin can create, list, and revoke invite links; non-admins get 404", async () => {
    const admin = await makeUser("inv-admin");
    await env.DB.prepare("UPDATE users SET is_admin = 1 WHERE id = ?").bind(admin.id).run();
    const cookie = { Cookie: await sessionCookie(admin.id), "Content-Type": "application/x-www-form-urlencoded" };

    const created = await SELF.fetch("https://x.test/admin/invite", { method: "POST", redirect: "manual", headers: cookie });
    expect(created.status).toBe(303);
    const location = created.headers.get("Location") ?? "";
    expect(location).toMatch(/^\/admin\?invite=[0-9a-f]{32}$/);
    const token = new URL(`https://x.test${location}`).searchParams.get("invite")!;

    const banner = await (await SELF.fetch(`https://x.test${location}`, { headers: { Cookie: cookie.Cookie } })).text();
    expect(banner).toContain(`auth/github?invite=${token}`);
    const page = await (await SELF.fetch("https://x.test/admin", { headers: { Cookie: cookie.Cookie } })).text();
    expect(page).not.toContain(token);
    expect(page).toContain("active");

    // the invite param rides into the signed OAuth state cookie
    const oauth = await SELF.fetch(`https://x.test/auth/github?invite=${token}`, { redirect: "manual" });
    expect(oauth.status).toBe(303);
    expect(oauth.headers.get("Location") ?? "").toContain("github.com/login/oauth/authorize");
    const setCookie = oauth.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toContain("dl_state=");

    const revoked = await SELF.fetch("https://x.test/admin/invite/revoke", {
      method: "POST", redirect: "manual", headers: cookie,
      body: "id=1",
    });
    expect(revoked.status).toBe(303);
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM invite_links").first<{ n: number }>();
    expect(left!.n).toBe(0);

    const pleb = await makeUser("inv-pleb");
    const denied = await SELF.fetch("https://x.test/admin/invite", {
      method: "POST", redirect: "manual",
      headers: { Cookie: await sessionCookie(pleb.id) },
    });
    expect(denied.status).toBe(404);
  });

  it("claim is one-time and respects expiry", async () => {
    const admin = await makeUser("inv-admin2");
    await env.DB.prepare("UPDATE users SET is_admin = 1 WHERE id = ?").bind(admin.id).run();
    const token = randomHex(16);
    await env.DB.prepare("INSERT INTO invite_links (token_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256Hex(token), admin.id, Date.now(), Date.now() + 7 * 24 * 3600_000)
      .run();

    const claim = async (t: string) =>
      (
        await env.DB.prepare("UPDATE invite_links SET used_at = ?, used_by = 1 WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?")
          .bind(Date.now(), await sha256Hex(t), Date.now())
          .run()
      ).meta.changes ?? 0;

    expect(await claim(token)).toBe(1);
    expect(await claim(token)).toBe(0);

    const expired = randomHex(16);
    await env.DB.prepare("INSERT INTO invite_links (token_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256Hex(expired), admin.id, Date.now(), Date.now() - 1000)
      .run();
    expect(await claim(expired)).toBe(0);
  });
});
