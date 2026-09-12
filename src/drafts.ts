import { randomId } from "./util";

export const STATUS_ORDER = ["active", "done", "archived"] as const;
// The round toggle only cycles between these; archived is set via the archive action.
export const TOGGLE_ORDER = ["active", "done"] as const;
export type Status = (typeof STATUS_ORDER)[number];

// Keep the last 25 versions per draft; raise if agent churn overflows this.
const VERSIONS_KEPT = 25;

export interface VersionRow {
  id: number;
  created_at: number;
}

export interface DraftRow {
  id: string;
  title: string;
  project: string;
  status: string;
  is_public: number;
  created_at: number;
  updated_at: number;
  owner_login?: string;
}

export interface DraftFullRow extends DraftRow {
  owner_user_id: number;
  body: string;
}

export type Access = { draft: DraftFullRow; isOwner: boolean; canEdit: boolean };

export type Viewer = { id: number; github_id: number } | null;

export function validStatus(s: string | null | undefined): Status {
  return STATUS_ORDER.includes(s as Status) ? (s as Status) : "active";
}

function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

export async function resolveAccess(db: D1Database, id: string, viewer: Viewer): Promise<Access | null> {
  const draft = await db
    .prepare("SELECT d.*, u.login AS owner_login FROM drafts d JOIN users u ON u.id = d.owner_user_id WHERE d.id = ?")
    .bind(id)
    .first<DraftFullRow & { owner_login: string }>();
  if (!draft) return null;
  const isOwner = !!viewer && viewer.id === draft.owner_user_id;
  let canEdit = isOwner;
  if (!canEdit && viewer) {
    const g = await db.prepare("SELECT 1 AS x FROM draft_access WHERE draft_id = ? AND github_id = ?").bind(id, viewer.github_id).first();
    canEdit = !!g;
  }
  return { draft, isOwner, canEdit };
}

export function canRead(a: Access): boolean {
  return a.draft.is_public === 1 || a.canEdit;
}

function versionStatements(db: D1Database, draftId: string, body: string, now: number): D1PreparedStatement[] {
  return [
    db.prepare("INSERT INTO draft_versions (draft_id, body, created_at) VALUES (?, ?, ?)").bind(draftId, body, now),
    db
      .prepare(
        "DELETE FROM draft_versions WHERE draft_id = ? AND id NOT IN (SELECT id FROM draft_versions WHERE draft_id = ? ORDER BY created_at DESC, id DESC LIMIT ?)"
      )
      .bind(draftId, draftId, VERSIONS_KEPT),
  ];
}

export async function listVersions(db: D1Database, draftId: string): Promise<VersionRow[]> {
  const { results } = await db
    .prepare("SELECT id, created_at FROM draft_versions WHERE draft_id = ? ORDER BY created_at DESC, id DESC")
    .bind(draftId)
    .all<VersionRow>();
  return results ?? [];
}

export async function getVersion(db: D1Database, draftId: string, versionId: number): Promise<{ id: number; body: string; created_at: number } | null> {
  return await db
    .prepare("SELECT id, body, created_at FROM draft_versions WHERE id = ? AND draft_id = ?")
    .bind(versionId, draftId)
    .first<{ id: number; body: string; created_at: number }>();
}

export async function create(
  db: D1Database,
  ownerUserId: number,
  input: { title?: string; project?: string; status?: Status; body: string }
): Promise<string> {
  const id = randomId(12);
  const now = Date.now();
  await db
    .prepare("INSERT INTO drafts (id, owner_user_id, title, project, status, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, ownerUserId, (input.title ?? "untitled").slice(0, 300), (input.project ?? "misc").slice(0, 100), input.status ?? "active", input.body, now, now)
    .run();
  return id;
}

export interface UpdateInput {
  title?: string;
  project?: string;
  status?: Status;
  isPublic?: number;
  body?: string;
}

export async function update(db: D1Database, id: string, input: UpdateInput): Promise<void> {
  let previous: string | undefined;
  if (input.body !== undefined) {
    const cur = await db.prepare("SELECT body FROM drafts WHERE id = ?").bind(id).first<{ body: string }>();
    previous = cur?.body;
  }
  const sets = ["updated_at = ?"];
  const args: unknown[] = [Date.now()];
  if (input.title !== undefined) {
    sets.push("title = ?");
    args.push(input.title.slice(0, 300));
  }
  if (input.project !== undefined) {
    sets.push("project = ?");
    args.push(input.project.slice(0, 100));
  }
  if (input.status !== undefined) {
    sets.push("status = ?");
    args.push(input.status);
  }
  if (input.isPublic !== undefined) {
    sets.push("is_public = ?");
    args.push(input.isPublic);
  }
  if (input.body !== undefined) {
    sets.push("body = ?");
    args.push(input.body);
  }
  args.push(id);
  const statements = [db.prepare(`UPDATE drafts SET ${sets.join(", ")} WHERE id = ?`).bind(...args)];
  if (previous !== undefined && previous !== input.body) statements.push(...versionStatements(db, id, previous, Date.now()));
  await db.batch(statements);
}

export async function remove(db: D1Database, id: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM draft_access WHERE draft_id = ?").bind(id),
    db.prepare("DELETE FROM draft_versions WHERE draft_id = ?").bind(id),
    db.prepare("DELETE FROM drafts WHERE id = ?").bind(id),
  ]);
}

export async function grant(db: D1Database, draftId: string, resolved: { github_id: number; login: string }): Promise<void> {
  await db
    .prepare("INSERT INTO draft_access (draft_id, github_id, login, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(draft_id, github_id) DO NOTHING")
    .bind(draftId, resolved.github_id, resolved.login, Date.now())
    .run();
}

export async function revoke(db: D1Database, draftId: string, githubId: number): Promise<void> {
  await db.prepare("DELETE FROM draft_access WHERE draft_id = ? AND github_id = ?").bind(draftId, githubId).run();
}

export async function listGrants(db: D1Database, draftId: string): Promise<{ github_id: number; login: string }[]> {
  const { results } = await db
    .prepare("SELECT github_id, login FROM draft_access WHERE draft_id = ? ORDER BY created_at")
    .bind(draftId)
    .all<{ github_id: number; login: string }>();
  return results ?? [];
}

export async function listMine(db: D1Database, userId: number, q: string, filter: string, project: string): Promise<DraftRow[]> {
  const like = likePattern(q);
  const { results } = await db
    .prepare(
      `SELECT id, title, project, status, is_public, created_at, updated_at FROM drafts
       WHERE owner_user_id = ?1 AND (?2 = '%%' OR title LIKE ?2 ESCAPE '\\' OR project LIKE ?2 ESCAPE '\\' OR body LIKE ?2 ESCAPE '\\') AND ((?3 = 'archived') = (status = 'archived')) AND (?3 IN ('all', 'archived') OR status = ?3)
       AND (?4 = '' OR project = ?4)
       ORDER BY created_at DESC LIMIT 500`
    )
    .bind(userId, like, filter, project)
    .all<DraftRow>();
  return results ?? [];
}

export async function listShared(db: D1Database, githubId: number, q: string, filter: string, project: string): Promise<DraftRow[]> {
  const like = likePattern(q);
  const { results } = await db
    .prepare(
      `SELECT d.id, d.title, d.project, d.status, d.is_public, d.created_at, d.updated_at, u.login AS owner_login
       FROM drafts d JOIN draft_access a ON a.draft_id = d.id JOIN users u ON u.id = d.owner_user_id
       WHERE a.github_id = ?1 AND (?2 = '%%' OR d.title LIKE ?2 ESCAPE '\\' OR d.project LIKE ?2 ESCAPE '\\' OR d.body LIKE ?2 ESCAPE '\\') AND ((?3 = 'archived') = (d.status = 'archived')) AND (?3 IN ('all', 'archived') OR d.status = ?3)
       AND (?4 = '' OR d.project = ?4)
       ORDER BY d.created_at DESC LIMIT 500`
    )
    .bind(githubId, like, filter, project)
    .all<DraftRow>();
  return results ?? [];
}

export async function listProjects(db: D1Database, userId: number, githubId: number): Promise<string[]> {
  const { results } = await db
    .prepare(
      "SELECT project FROM drafts WHERE owner_user_id = ?1 " +
        "UNION SELECT d.project FROM drafts d JOIN draft_access a ON a.draft_id = d.id WHERE a.github_id = ?2 " +
        "ORDER BY project COLLATE NOCASE"
    )
    .bind(userId, githubId)
    .all<{ project: string }>();
  return (results ?? []).map((row) => row.project);
}
