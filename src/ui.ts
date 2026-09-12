import { esc, dateLabel } from "./util";
import { TOGGLE_ORDER, type Access, type DraftRow, type VersionRow } from "./drafts";

export interface DashboardOptions {
  q: string;
  filter: string;
  project: string;
  projects: string[];
  mine: DraftRow[];
  shared: DraftRow[];
}

const STATUS_STYLE: Record<string, { chip: string; icon: string }> = {
  active: { chip: "bg-zinc-200 dark:bg-zinc-700 text-zinc-700 dark:text-zinc-300", icon: "○" },
  done: { chip: "bg-emerald-200 dark:bg-emerald-900 text-emerald-800 dark:text-emerald-300", icon: "✓" },
  archived: { chip: "bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-500 line-through", icon: "⌛" },
};

const THEME_SCRIPT = `<script src="/theme.js"></script>`;

const BASE_STYLE = `<style>
@view-transition{navigation:auto}
html{background:#fafafa}
html.dark{background:#09090b}
@media (prefers-reduced-motion:reduce){::view-transition-group(*),::view-transition-image-pair(*),::view-transition-old(*),::view-transition-new(*){animation:none!important}}
</style>`;

const SPECULATION_RULES = `<script type="speculationrules">{"prerender":[{"source":"document","where":{"href_matches":"\\\\/*"},"eagerness":"moderate"}]}</script>`;

const LOCAL_TIME_SCRIPT = `<script>
(() => {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const formatter = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  });

  function formatLocalTime(date) {
    const parts = Object.fromEntries(formatter.formatToParts(date).map(({ type, value }) => [type, value]));
    return parts.day + "/" + parts.month + "/" + parts.year + " " + parts.hour + ":" + parts.minute;
  }

  window.dlFormatLocalTimes = (root = document) => {
    root.querySelectorAll("time[data-local-time]").forEach((element) => {
      const value = element.getAttribute("datetime");
      if (!value) return;
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return;
      element.textContent = formatLocalTime(date);
    });
  };

  document.addEventListener("click", (e) => {
    document.querySelectorAll("details[open]").forEach((d) => {
      if (!d.contains(e.target)) d.removeAttribute("open");
    });
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => window.dlFormatLocalTimes());
  } else {
    window.dlFormatLocalTimes();
  }
})();
</script>`;

function localTime(ms: number): string {
  const iso = new Date(ms).toISOString();
  return `<time datetime="${iso}" data-local-time>${dateLabel(ms)}</time>`;
}

const REPORTER_SCRIPT = `<script>
(function () {
  function post() {
    var el = document.documentElement;
    var h = Math.max(el.scrollHeight, document.body ? document.body.scrollHeight : 0);
    parent.postMessage({ type: "dl-size", h: h }, "*");
  }
  ["load", "resize"].forEach(function (ev) { addEventListener(ev, post); });
  document.addEventListener("DOMContentLoaded", post);
  if (window.ResizeObserver) new ResizeObserver(post).observe(document.documentElement);
  post();
})();
</script>`;

// scrollHeight can miss bottom body margins on some layouts; switch to iframe-resizer if that ever shows.
export function injectEmbed(body: string): string {
  let out = body;
  const injectIntoHead = (snippet: string) => {
    if (/<head[^>]*>/i.test(out)) out = out.replace(/<head[^>]*>/i, (m) => m + snippet);
    else out = snippet + out;
  };
  if (!/\/theme\.js/.test(out)) injectIntoHead(`<script src="/theme.js"></script>`);
  if (!/tailwind\.config/.test(out)) injectIntoHead(`<script>tailwind.config = { darkMode: 'class' }</script>`);
  if (!/cdn\.tailwindcss\.com/.test(out)) injectIntoHead(`<script src="https://cdn.tailwindcss.com"></script>`);
  if (!out.includes("dl-size")) injectIntoHead(REPORTER_SCRIPT);
  return out;
}

function themeButton(): string {
  return `<button id="themeToggle" onclick="dlToggleTheme()" aria-label="Toggle dark mode" class="rounded-md border border-zinc-300 dark:border-zinc-600 px-2 py-1 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800">◐</button>`;
}

export function layout(opts: { title: string; body: string; user?: { login: string; admin?: boolean; pending?: number } | null; base: string; bare?: boolean; description?: string; ogUrl?: string }): string {
  const head = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)}</title>
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
${opts.description ? `<meta property="og:title" content="${esc(opts.title)}">
<meta property="og:description" content="${esc(opts.description)}">
<meta property="og:image" content="${esc(opts.base)}/banner.png">
<meta property="og:url" content="${esc(opts.ogUrl ?? opts.base)}">
<meta name="twitter:card" content="summary_large_image">` : ""}
<script src="https://cdn.tailwindcss.com"></script>
<script>tailwind.config = { darkMode: 'class' }</script>
${THEME_SCRIPT}
${BASE_STYLE}
${SPECULATION_RULES}
${LOCAL_TIME_SCRIPT}`;
  if (opts.bare) {
    return `<!doctype html>
<html lang="en">
<head>
${head}
</head>
<body class="bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100 min-h-screen">
${opts.body}
</body>
</html>`;
  }
  const pendingBadge = opts.user?.pending
    ? ` <span class="rounded-full bg-amber-200 px-1.5 py-0.5 text-xs text-amber-800 dark:bg-amber-900 dark:text-amber-300">${opts.user.pending}</span>`
    : "";
  const adminLink = opts.user?.admin ? `<a href="/admin" class="text-sm font-medium hover:underline">Admin${pendingBadge}</a>` : "";
  const nav = opts.user
    ? `<nav class="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
        <a href="/dashboard" class="text-sm font-medium hover:underline">Dashboard</a>
        ${adminLink}
        <a href="/install" class="text-sm font-medium hover:underline">Install</a>
        <a href="/keys" class="text-sm font-medium hover:underline">API keys</a>
        <form method="post" action="/logout" class="inline"><button class="text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">Sign out (@${esc(opts.user.login)})</button></form>
        ${themeButton()}
      </nav>`
    : `<div>${themeButton()}</div>`;
  return `<!doctype html>
<html lang="en">
<head>
${head}
</head>
<body class="bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100 min-h-screen">
<div class="max-w-5xl mx-auto px-4 py-6">
  <header class="flex flex-col items-start gap-4 mb-8 sm:flex-row sm:items-center sm:justify-between">
    <a href="/" class="flex items-center gap-1.5 text-lg font-bold tracking-tight"><img src="/logo.png" alt="" class="h-6 w-6">draftlink</a>
    ${nav}
  </header>
  ${opts.body}
</div>
</body>
</html>`;
}

export function loginPage(base: string, opts: { configured: boolean; error?: string }): string {
  const error = opts.error ? `<p class="mb-4 rounded-md bg-red-100 dark:bg-red-950 text-red-800 dark:text-red-300 px-4 py-2 text-sm">${esc(opts.error)}</p>` : "";
  const button = opts.configured
    ? `<a href="/auth/github" class="inline-flex items-center gap-2 rounded-md bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 px-4 py-2 font-medium hover:opacity-90">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>
        Sign in with GitHub
      </a>`
    : `<p class="rounded-md bg-amber-100 dark:bg-amber-950 text-amber-900 dark:text-amber-300 px-4 py-3 text-sm">Server not configured: set GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET and SESSION_SECRET secrets first.</p>`;
  return layout({
    base,
    title: "draftlink — sign in",
    description: "Publish HTML drafts from coding agents; searchable, shareable, status-tracked.",
    body: `
<div class="max-w-sm mx-auto mt-24 text-center">
  <img src="/banner.png" alt="DraftLink — from idea to impact" class="mb-6 w-full rounded-xl shadow-md">
  <h1 class="text-2xl font-bold mb-2">draftlink</h1>
  <p class="text-sm text-zinc-500 mb-6">Publish HTML drafts, share them, move on.</p>
  ${error}
  ${button}
</div>`,
  });
}

function draftCard(d: DraftRow, isOwner: boolean): string {
  const st = STATUS_STYLE[d.status] ?? STATUS_STYLE.active;
  const next = TOGGLE_ORDER[d.status === "done" ? 0 : 1];
  return `
<li class="flex items-start gap-3 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3">
  <form method="post" action="/drafts/${esc(d.id)}/status" title="Mark as ${next}">
    <input type="hidden" name="status" value="${next}">
    <button class="mt-0.5 w-6 h-6 rounded-full border flex items-center justify-center text-xs ${st.chip}" aria-label="Status: ${esc(d.status)}, click to set ${next}">${st.icon}</button>
  </form>
  <div class="min-w-0 flex-1">
    <a href="/d/${esc(d.id)}" class="font-medium hover:underline block truncate">${esc(d.title)}</a>
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1 text-xs text-zinc-500">
      <span class="rounded bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5">${esc(d.project)}</span>
      ${d.is_public ? `<span class="rounded bg-sky-100 dark:bg-sky-950 text-sky-700 dark:text-sky-400 px-1.5 py-0.5">public</span>` : ""}
      <span title="created">${localTime(d.created_at)}</span>
      ${d.updated_at - d.created_at > 60_000 ? `<span title="updated">(edited)</span>` : ""}
      ${!isOwner && d.owner_login ? `<span>shared by @${esc(d.owner_login)}</span>` : ""}
      <a href="/drafts/${esc(d.id)}/edit" class="hover:underline">edit</a>
      ${isOwner ? `<a href="/drafts/${esc(d.id)}/share" class="hover:underline">share</a>` : ""}
      ${
        isOwner
          ? `<form method="post" action="/drafts/${esc(d.id)}/status" class="inline" onsubmit="return confirm('Archive this draft? It will be hidden from the dashboard.')"><input type="hidden" name="status" value="archived"><button class="hover:underline">archive</button></form>`
          : ""
      }
      ${
        isOwner
          ? `<form method="post" action="/drafts/${esc(d.id)}/delete" class="inline" onsubmit="return confirm('Delete this draft?')"><button class="hover:underline text-red-600 dark:text-red-400">delete</button></form>`
          : ""
      }
    </div>
  </div>
</li>`;
}

function groupList(title: string, drafts: DraftRow[], isOwner: boolean): string {
  if (drafts.length === 0) return "";
  const byMonth = new Map<string, DraftRow[]>();
  for (const d of drafts) {
    const key = new Date(d.created_at).toISOString().slice(0, 7);
    const arr = byMonth.get(key);
    if (arr) arr.push(d);
    else byMonth.set(key, [d]);
  }
  const sections = [...byMonth.entries()]
    .map(([month, rows]) => {
      const label = new Date(`${month}-01T00:00:00Z`).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
      return `<section class="mb-6">
  <h3 class="text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-2">${esc(label)} · ${rows.length}</h3>
  <ul class="space-y-2">${rows.map((d) => draftCard(d, isOwner)).join("")}</ul>
</section>`;
    })
    .join("");
  return `<h2 class="text-lg font-semibold mb-3">${title}</h2>${sections}`;
}

function dashboardHref(opts: DashboardOptions, overrides: { filter?: string; project?: string } = {}): string {
  const params = new URLSearchParams();
  if (opts.q) params.set("q", opts.q);
  params.set("filter", overrides.filter ?? opts.filter);
  const project = overrides.project ?? opts.project;
  if (project) params.set("project", project);
  return `/dashboard?${params.toString()}`;
}

function dashboardFilters(opts: DashboardOptions): string {
  const filters = ["all", "active", "done"];
  const chips = filters
    .map((f) => {
      const cls =
        f === opts.filter
          ? "bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900"
          : "border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800";
      return `<a href="${dashboardHref(opts, { filter: f })}" data-filter="${f}" class="rounded-full px-3 py-1 text-xs ${cls}">${f}</a>`;
    })
    .join("");
  const archivedCls = opts.filter === "archived" ? "bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900" : "border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800";
  const archiveChip = `<a href="${dashboardHref(opts, { filter: "archived" })}" data-filter="archived" class="rounded-full px-3 py-1 text-xs ${archivedCls}">archived</a>`;  const projectChips = ["", ...opts.projects]
    .map((project) => {
      const selected = project === opts.project;
      const cls = selected
        ? "bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900"
        : "border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800";
      const label = project || "All projects";
      return `<a href="${dashboardHref(opts, { project })}" data-project="${esc(project)}" class="rounded-full px-3 py-1 text-xs whitespace-nowrap ${cls}">${esc(label)}</a>`;
    })
    .join("");
  return `<div id="filterControls" class="space-y-2" aria-label="Draft filters">
  <div id="statusFilters" class="flex flex-wrap gap-1.5 items-center" aria-label="Filter by status">${chips}<span class="text-zinc-300 dark:text-zinc-700">|</span>${archiveChip}</div>
  <div id="projectFilters" class="flex flex-wrap gap-1.5" aria-label="Filter by project">${projectChips}</div>
</div>`;
}

export function dashboardResults(opts: DashboardOptions): string {
  const hasResults = opts.mine.length > 0 || opts.shared.length > 0;
  const empty = !hasResults
    ? opts.q || opts.project || opts.filter !== "all"
      ? `<p class="text-sm text-zinc-500">No drafts match these filters.</p>`
      : `<div class="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6 text-center">
          <p class="text-sm font-medium mb-1">Nothing here yet</p>
          <p class="text-sm text-zinc-500 mb-3">Install the CLI and the agent skill to publish drafts straight from your coding agent.</p>
          <a href="/install" class="inline-block rounded-md bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 px-4 py-2 text-sm font-medium hover:opacity-90">Go to install →</a>
        </div>`
    : "";
  return `<div id="draftResults" aria-live="polite">
${empty}
${groupList("My drafts", opts.mine, true)}
${groupList("Shared with me", opts.shared, false)}
</div>`;
}

export function dashboardFragment(opts: DashboardOptions): string {
  return `${dashboardFilters(opts)}${dashboardResults(opts)}`;
}

export function dashboardPage(base: string, user: { login: string }, opts: DashboardOptions): string {
  const newForm = `
<details class="mb-8">
  <summary class="cursor-pointer text-sm font-medium text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">+ New draft</summary>
  <form method="post" action="/drafts" enctype="multipart/form-data" class="mt-3 space-y-2 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
    <div class="flex flex-col gap-2 sm:flex-row">
      <input name="title" placeholder="Title" required class="flex-1 rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm">
      <input name="project" placeholder="project" class="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm sm:w-40">
    </div>
    <textarea name="body" rows="10" placeholder="<html>… (or attach a file below)" class="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm font-mono"></textarea>
    <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <input type="file" name="file" accept=".html,.htm,text/html" class="text-sm">
      <button class="w-full rounded-md bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 px-4 py-2 text-sm font-medium hover:opacity-90 sm:w-auto">Publish</button>
    </div>
  </form>
</details>`;
  const body = `
<div class="mb-6 space-y-3">
  <form id="dashboardSearch" method="get" action="/dashboard" class="flex flex-col gap-2 sm:flex-row">
    <input id="draftSearch" type="search" name="q" value="${esc(opts.q)}" placeholder="Search title, project, content…" autocomplete="off" class="min-w-0 flex-1 rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm">
    <input type="hidden" name="filter" value="${esc(opts.filter)}">
    <input type="hidden" name="project" value="${esc(opts.project)}">
    <button class="w-full rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 sm:w-auto">Search</button>
  </form>
  ${dashboardFilters(opts)}
</div>
${newForm}
${dashboardResults(opts)}
${DASHBOARD_SCRIPT}`;
  return layout({ base, title: "draftlink", user, body });
}

const DASHBOARD_SCRIPT = `<script>
(() => {
  const search = document.querySelector("#draftSearch");
  const form = document.querySelector("#dashboardSearch");
  const controls = document.querySelector("#filterControls");
  let pending;
  let debounce;

  function state() {
    const params = new URL(window.location.href).searchParams;
    return {
      q: params.get("q") || "",
      filter: params.get("filter") || "all",
      project: params.get("project") || "",
    };
  }

  function updateUrl(next, mode) {
    const url = new URL(window.location.href);
    if (next.q) url.searchParams.set("q", next.q); else url.searchParams.delete("q");
    if (next.filter && next.filter !== "all") url.searchParams.set("filter", next.filter); else url.searchParams.delete("filter");
    if (next.project) url.searchParams.set("project", next.project); else url.searchParams.delete("project");
    window.history[mode](null, "", url);
  }

  function syncSearch() {
    if (search) search.value = state().q;
  }

  async function refresh() {
    if (pending) pending.abort();
    pending = new AbortController();
    const url = new URL(window.location.href);
    url.searchParams.set("fragment", "1");
    try {
      const response = await fetch(url, { headers: { Accept: "text/html" }, signal: pending.signal });
      if (!response.ok) return;
      const doc = new DOMParser().parseFromString(await response.text(), "text/html");
      for (const id of ["statusFilters", "projectFilters", "draftResults"]) {
        const current = document.querySelector("#" + id);
        const next = doc.querySelector("#" + id);
        if (current && next && current.innerHTML !== next.innerHTML) current.replaceWith(next);
      }
      window.dlFormatLocalTimes?.();
      syncSearch();
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) console.error("draft refresh failed", error);
    }
  }

  controls?.addEventListener("click", (event) => {
    const target = event.target;
    const link = target instanceof Element ? target.closest("a[data-filter], a[data-project]") : null;
    if (!link) return;
    event.preventDefault();
    const next = state();
    if (link.dataset.filter) next.filter = link.dataset.filter;
    if (link.dataset.project !== undefined) next.project = link.dataset.project;
    updateUrl(next, "pushState");
    void refresh();
  });

  search?.addEventListener("input", () => {
    const next = state();
    next.q = search.value;
    updateUrl(next, "replaceState");
    clearTimeout(debounce);
    debounce = setTimeout(() => void refresh(), 150);
  });

  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    const next = state();
    next.q = search?.value || "";
    updateUrl(next, "pushState");
    void refresh();
  });

  window.addEventListener("popstate", () => {
    syncSearch();
    void refresh();
  });

  window.setInterval(() => {
    if (document.visibilityState === "visible") void refresh();
  }, 10000);
})();
</script>`;

export interface ShellOptions {
  access: Access;
  versions: VersionRow[];
  versionId: number | null;
}

export function draftShellHeader(opts: ShellOptions): string {
  const d = opts.access.draft;
  const st = STATUS_STYLE[d.status] ?? STATUS_STYLE.active;
  const next = TOGGLE_ORDER[d.status === "done" ? 0 : 1];
  const live = opts.versionId === null;
  const viewedIdx = live ? -1 : opts.versions.findIndex((v) => v.id === opts.versionId);
  const chip = opts.access.canEdit
    ? `<form method="post" action="/drafts/${esc(d.id)}/status" class="shrink-0" title="Mark as ${next}">
        <input type="hidden" name="status" value="${next}">
        <button class="flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${st.chip}" aria-label="Status: ${esc(d.status)}, click to set ${next}">${st.icon} ${esc(d.status)}</button>
      </form>`
    : `<span class="rounded-full px-2.5 py-0.5 text-xs font-medium ${st.chip}">${st.icon} ${esc(d.status)}</span>`;
  const dropdown = opts.versions.length
    ? `<details class="relative shrink-0">
  <summary class="cursor-pointer list-none rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-600 dark:hover:bg-zinc-800">${viewedIdx >= 0 ? `v${opts.versions.length - viewedIdx}` : "history"}<span class="ml-1 text-zinc-400">▾</span></summary>
  <div class="absolute right-0 z-50 mt-1 max-h-72 w-60 overflow-y-auto rounded-lg border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
    <a href="/d/${esc(d.id)}" class="block rounded px-2 py-1.5 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 ${live ? "font-semibold" : ""}">live (current)</a>
    ${opts.versions
      .map(
        (v, i) =>
          `<a href="/d/${esc(d.id)}?v=${v.id}" class="block rounded px-2 py-1.5 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 ${opts.versionId === v.id ? "bg-zinc-100 font-semibold dark:bg-zinc-800" : ""}">v${opts.versions.length - i} · ${localTime(v.created_at)}</a>`
      )
      .join("")}
  </div>
</details>`
    : "";
  return `<header id="dl-hdr" data-updated-at="${d.updated_at}" data-versions="${opts.versions.length}" data-viewing="${live ? 0 : 1}" data-meta="/d/${esc(d.id)}?meta=1" class="sticky top-0 z-50 flex items-center gap-2 border-b border-zinc-200 bg-zinc-50/95 px-3 py-2 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/95">
  <a href="/" class="flex shrink-0 items-center gap-1.5 text-sm font-bold tracking-tight"><img src="/logo.png" alt="" class="h-4 w-4">draftlink</a>
  <span class="min-w-0 flex-1 truncate text-sm font-medium text-zinc-500">${esc(d.title)}</span>
  ${chip}
  ${dropdown}
  ${themeButton()}
</header>`;
}

function draftShellBanner(opts: ShellOptions): string {
  if (opts.versionId === null) return "";
  const d = opts.access.draft;
  const idx = opts.versions.findIndex((v) => v.id === opts.versionId);
  const label = idx >= 0 ? `v${opts.versions.length - idx} from ${localTime(opts.versions[idx].created_at)}` : "a saved version";
  const restore = opts.access.isOwner
    ? `<form method="post" action="/drafts/${esc(d.id)}/restore" class="inline"><input type="hidden" name="v" value="${opts.versionId}"><button class="font-medium underline">Restore this version</button></form>`
    : "";
  return `<div class="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
  <span class="flex-1">Viewing ${label} — it won't live-update.</span>
  <a href="/d/${esc(d.id)}" class="font-medium underline">Back to live</a>
  ${restore}
</div>`;
}

const SHELL_SCRIPT = `<script>
(() => {
  const frame = document.getElementById("dl-frame");
  let hdr = document.getElementById("dl-hdr");
  const viewing = hdr.dataset.viewing === "1";
  let busy = false;

  addEventListener("message", (e) => {
    if (e.source !== frame.contentWindow) return;
    if (e.data && e.data.type === "dl-size" && typeof e.data.h === "number" && e.data.h > 0) {
      frame.style.height = Math.ceil(e.data.h) + "px";
      frame.contentWindow.postMessage({ type: "dl-theme", dark: document.documentElement.classList.contains("dark") }, "*");
    }
  });

  setInterval(async () => {
    if (busy || document.visibilityState !== "visible") return;
    busy = true;
    try {
      const res = await fetch(hdr.dataset.meta, { headers: { Accept: "text/html" } });
      if (!res.ok) return;
      const doc = new DOMParser().parseFromString(await res.text(), "text/html");
      const next = doc.getElementById("dl-hdr");
      if (!next) return;
      const newVersions = Number(next.dataset.versions) !== Number(hdr.dataset.versions);
      if (newVersions || next.dataset.updatedAt !== hdr.dataset.updatedAt) {
        hdr.replaceWith(next);
        hdr = next;
      }
      if (newVersions && !viewing) {
        const u = new URL(frame.src);
        u.searchParams.set("t", Date.now());
        frame.src = u.pathname + u.search;
      }
    } catch {}
    finally { busy = false; }
  }, 10000);
})();
</script>`;

export function draftShellPage(opts: ShellOptions & { base: string }): string {
  const d = opts.access.draft;
  const embedUrl = `/d/${esc(d.id)}?embed=1${opts.versionId ? `&v=${opts.versionId}` : ""}`;
  const body = `
${draftShellHeader(opts)}
${draftShellBanner(opts)}
<iframe id="dl-frame" src="${embedUrl}" sandbox="allow-scripts allow-popups" title="${esc(d.title)}" class="block w-full border-0" style="height:100vh"></iframe>
${SHELL_SCRIPT}`;
  return layout({ base: opts.base, title: d.title, bare: true, body, ogUrl: `${opts.base}/d/${d.id}` });
}

export function editPage(base: string, user: { login: string }, d: DraftRow & { body: string }): string {
  const body = `
<h1 class="text-xl font-bold mb-4">Edit draft</h1>
<form method="post" action="/drafts/${esc(d.id)}/edit" enctype="multipart/form-data" class="space-y-3 max-w-3xl">
  <div class="flex flex-col gap-2 sm:flex-row">
    <input name="title" value="${esc(d.title)}" required class="flex-1 rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm">
    <input name="project" value="${esc(d.project)}" class="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm sm:w-40">
  </div>
  <textarea name="body" rows="22" class="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm font-mono">${esc(d.body)}</textarea>
  <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
    <label class="text-sm text-zinc-500">replace with file <input type="file" name="file" accept=".html,.htm,text/html" class="ml-1 max-w-full"></label>
    <div class="flex flex-wrap gap-2">
      <a href="/d/${esc(d.id)}" class="rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800">View live ↗</a>
      <button class="rounded-md bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 px-4 py-2 text-sm font-medium hover:opacity-90">Save</button>
    </div>
  </div>
</form>`;
  return layout({ base, title: `edit — ${d.title}`, user, body });
}

export function sharePage(base: string, user: { login: string }, d: DraftRow, grants: { github_id: number; login: string }[], error?: string): string {
  const err = error ? `<p class="mb-3 rounded-md bg-red-100 dark:bg-red-950 text-red-800 dark:text-red-300 px-3 py-2 text-sm">${esc(error)}</p>` : "";
  const rows = grants.length
    ? grants
        .map(
          (g) => `<li class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-3 py-2">
  <span class="text-sm font-medium">@${esc(g.login)}</span>
  <form method="post" action="/drafts/${esc(d.id)}/revoke"><input type="hidden" name="gid" value="${g.github_id}"><button class="text-sm text-red-600 dark:text-red-400 hover:underline">revoke</button></form>
</li>`
        )
        .join("")
    : `<li class="text-sm text-zinc-500">Not shared with anyone yet.</li>`;
  const visibility = d.is_public
    ? `<form method="post" action="/drafts/${esc(d.id)}/visibility" class="flex flex-wrap items-center gap-3 mb-6 rounded-lg border border-sky-200 dark:border-sky-900 bg-sky-50 dark:bg-sky-950 px-3 py-2 max-w-md">
        <span class="text-sm text-sky-700 dark:text-sky-400 flex-1">Public — anyone with the link can read</span>
        <input type="hidden" name="value" value="private">
        <button class="text-sm font-medium hover:underline">Make private</button>
      </form>`
    : `<form method="post" action="/drafts/${esc(d.id)}/visibility" class="flex flex-wrap items-center gap-3 mb-6 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-3 py-2 max-w-md">
        <span class="text-sm text-zinc-500 flex-1">Private — only you and people below</span>
        <input type="hidden" name="value" value="public">
        <button class="text-sm font-medium hover:underline">Make public (read-only link)</button>
      </form>`;
  const body = `
<h1 class="text-xl font-bold mb-1">Share “${esc(d.title)}”</h1>
<p class="text-sm text-zinc-500 mb-6">Grants get read/write. Only you can delete, re-share, or change visibility.</p>
${visibility}
${err}
<form method="post" action="/drafts/${esc(d.id)}/share" class="flex flex-col gap-2 mb-6 max-w-md sm:flex-row">
  <input name="login" placeholder="github handle e.g. octocat" required class="flex-1 rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm">
  <button class="w-full rounded-md bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 px-4 py-2 text-sm font-medium hover:opacity-90 sm:w-auto">Grant read/write</button>
</form>
<ul class="space-y-2 max-w-md">${rows}</ul>`;
  return layout({ base, title: `share — ${d.title}`, user, body });
}

export function keysPage(base: string, user: { login: string }, keys: { id: number; prefix: string; label: string; created_at: number; last_used_at: number | null }[], newKey?: string): string {
  const banner = newKey
    ? `<div class="mb-6 rounded-lg border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950 p-4">
        <p class="text-sm font-medium mb-2">New API key (copy now, shown once):</p>
        <code class="block break-all rounded bg-white dark:bg-zinc-900 px-3 py-2 text-sm select-all">${esc(newKey)}</code>
      </div>`
    : "";
  const rows = keys.length
    ? keys
        .map(
          (k) => `<li class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-3 py-2">
  <div>
    <code class="text-sm">${esc(k.prefix)}…</code>
    <span class="ml-2 text-xs text-zinc-500">${esc(k.label)} · created ${localTime(k.created_at)} · ${k.last_used_at ? `last used ${localTime(k.last_used_at)}` : "never used"}</span>
  </div>
  <form method="post" action="/keys/revoke"><input type="hidden" name="id" value="${k.id}"><button class="text-sm text-red-600 dark:text-red-400 hover:underline">revoke</button></form>
</li>`
        )
        .join("")
    : `<li class="text-sm text-zinc-500">No API keys yet.</li>`;
  const usage = `<pre class="mt-6 overflow-x-auto rounded-lg bg-zinc-900 text-zinc-100 dark:bg-black p-4 text-xs leading-relaxed">draftlink auth login       # paste this key once; CLI stores it (agents never see it)

curl -X POST "${esc(base)}/api/drafts?title=My%20plan&amp;project=myrepo" \\
  -H "Authorization: Bearer dl_..." \\
  -H "Content-Type: text/html" \\
  --data-binary @plan.html

curl -X PUT "${esc(base)}/api/drafts/&lt;id&gt;?status=done" -H "Authorization: Bearer dl_…" -H "Content-Type: text/html" --data-binary @v2.html
curl -X DELETE "${esc(base)}/api/drafts/&lt;id&gt;" -H "Authorization: Bearer dl_…"
curl "${esc(base)}/api/drafts?q=search" -H "Authorization: Bearer dl_…"</pre>`;
  const body = `
<h1 class="text-xl font-bold mb-1">API keys</h1>
<p class="text-sm text-zinc-500 mb-6">Keys act as you, full read/write. Revoke leaked ones here.</p>
${banner}
<form method="post" action="/keys" class="flex flex-col gap-2 mb-6 max-w-md sm:flex-row">
  <input name="label" placeholder="label e.g. laptop-cli" class="flex-1 rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm">
  <button class="w-full rounded-md bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 px-4 py-2 text-sm font-medium hover:opacity-90 sm:w-auto">Create key</button>
</form>
<ul class="space-y-2">${rows}</ul>
${usage}`;
  return layout({ base, title: "API keys", user, body });
}

const COPY_SCRIPT = `<script>
document.querySelectorAll("[data-copy]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const text = btn.parentElement.querySelector("pre").textContent;
    navigator.clipboard.writeText(text).then(() => {
      btn.textContent = "copied!";
      setTimeout(() => (btn.textContent = "copy"), 1500);
    });
  });
});
</script>`;

export function installPage(base: string, user: { login: string }): string {
  const cmdBlock = (code: string) => `<div class="relative">
  <pre class="overflow-x-auto rounded bg-zinc-900 text-zinc-100 dark:bg-black p-3 text-xs">${esc(code)}</pre>
  <button data-copy class="absolute right-2 top-2 rounded border border-zinc-600 bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-300 hover:bg-zinc-700">copy</button>
</div>`;
  const step = (n: number, title: string, body: string) => `<li class="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
  <p class="font-medium mb-2">${n}. ${title}</p>
  <div class="text-sm text-zinc-500 space-y-2">${body}</div>
</li>`;
  const body = `
<h1 class="text-xl font-bold mb-1">Install</h1>
<p class="text-sm text-zinc-500 mb-6">Same steps on macOS, Linux and Windows. Requires <a href="https://nodejs.org" class="underline">Node 22+</a>.</p>
<ol class="space-y-3 max-w-2xl">
  ${step(1, "Install the CLI", cmdBlock("npm install -g draftlink"))}
  ${step(2, "Install the agent skill", `Teaches your coding agents (Claude Code, Codex, …) to publish drafts. The installer asks which harnesses to target.${cmdBlock("npx skills add lm-sousa/draftlink --skill draftlink -g")}`)}
  ${step(3, "Log in once — you, in a terminal", `Run it, paste this instance's URL, and paste your API key when asked — create it in step 4 so it's still in your clipboard. Agents only ever call <code>draftlink</code> and never see the token.${cmdBlock("draftlink auth login")}or include the <code>--url</code> argument — handy for scripts and CI:${cmdBlock(`draftlink auth login --url ${base}`)}`)}
  ${step(4, "Create an API key", `<a href="/keys" class="font-medium underline">Create a key</a> and copy it — it's shown once. This is the token the CLI asks for in step 3.`)}
</ol>
<h2 class="text-lg font-semibold mt-10 mb-2">Staying up to date</h2>
<div class="max-w-2xl space-y-2 text-sm text-zinc-500">
  <p>The CLI prints a one-line notice when a newer release exists — run it or update any time:</p>
  ${cmdBlock("draftlink upgrade\nnpx skills update draftlink -g   # refresh the skill too")}
  <p>Windows note: pipe stdin like <code>Get-Content plan.html | draftlink upload -</code>, or pass the file directly.</p>
</div>
${COPY_SCRIPT}`;
  return layout({ base, title: "Install", user, body });
}

export function adminPage(
  base: string,
  user: { login: string },
  users: { id: number; login: string; status: string; is_admin: number; created_at: number }[],
  invites: { id: number; created_at: number; expires_at: number; used_at: number | null }[] = [],
  newInvite?: string
): string {
  const STATUS_STYLES: Record<string, string> = {
    approved: "text-emerald-600 dark:text-emerald-400",
    pending: "text-amber-600 dark:text-amber-400",
    banned: "text-red-600 dark:text-red-400",
  };
  const rows = users
    .map((u) => `<li class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-3 py-2">
  <div>
    <span class="text-sm font-medium">@${esc(u.login)}</span>
    <span class="ml-2 text-xs ${STATUS_STYLES[u.status] ?? "text-zinc-500"}">${esc(u.status)}</span>
    <span class="ml-2 text-xs text-zinc-500">joined ${localTime(u.created_at)}</span>
  </div>
  <div class="flex gap-3">
    ${u.is_admin ? `<span class="text-xs font-medium text-sky-600 dark:text-sky-400">admin</span>` : ""}
    ${u.status !== "approved" ? `<form method="post" action="/admin/approve"><input type="hidden" name="id" value="${u.id}"><button class="text-sm text-emerald-600 dark:text-emerald-400 hover:underline">approve</button></form>` : ""}
    ${u.status !== "banned" ? `<form method="post" action="/admin/ban"><input type="hidden" name="id" value="${u.id}"><button class="text-sm text-red-600 dark:text-red-400 hover:underline">ban</button></form>` : ""}
    ${u.is_admin ? `<form method="post" action="/admin/remove-admin"><input type="hidden" name="id" value="${u.id}"><button class="text-sm text-zinc-500 hover:underline" title="Removing the last admin is blocked">remove admin</button></form>` : `<form method="post" action="/admin/make-admin"><input type="hidden" name="id" value="${u.id}"><button class="text-sm text-sky-600 dark:text-sky-400 hover:underline">make admin</button></form>`}
  </div>
</li>`)
    .join("");
  const now = Date.now();
  const inviteBanner = newInvite
    ? `<div class="mb-6 rounded-lg border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950 p-4">
        <p class="text-sm font-medium mb-2">New invite link (copy now, shown once):</p>
        <code class="block break-all rounded bg-white dark:bg-zinc-900 px-3 py-2 text-sm select-all">${esc(base)}/auth/github?invite=${esc(newInvite)}</code>
      </div>`
    : "";
  const inviteRows = invites.length
    ? invites
        .map((i) => {
          const used = i.used_at !== null;
          const expired = !used && i.expires_at <= now;
          const state = used ? `<span class="text-xs text-zinc-500">used ${localTime(i.used_at!)}</span>` : expired ? `<span class="text-xs text-red-600 dark:text-red-400">expired</span>` : `<span class="text-xs text-emerald-600 dark:text-emerald-400">active</span>`;
          const revoke = !used && !expired ? `<form method="post" action="/admin/invite/revoke"><input type="hidden" name="id" value="${i.id}"><button class="text-sm text-red-600 dark:text-red-400 hover:underline">revoke</button></form>` : "";
          return `<li class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-3 py-2">
  <span class="text-xs text-zinc-500">created ${localTime(i.created_at)} · expires ${localTime(i.expires_at)}</span>
  <div class="flex items-center gap-3">${state}${revoke}</div>
</li>`;
        })
        .join("")
    : `<li class="text-sm text-zinc-500">No invite links yet.</li>`;
  const inviteSection = `
<h2 class="text-lg font-semibold mt-10 mb-1">Invite links</h2>
<p class="text-sm text-zinc-500 mb-4">Anyone signing in through an invite link is approved automatically — no pending review. Links are single-use and expire after 7 days.</p>
${inviteBanner}
<form method="post" action="/admin/invite" class="mb-6"><button class="rounded-md bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 px-4 py-2 text-sm font-medium hover:opacity-90">Create invite link</button></form>
<ul class="space-y-2 max-w-md">${inviteRows}</ul>`;
  const body = `
<h1 class="text-xl font-bold mb-1">Admin — accounts</h1>
<p class="text-sm text-zinc-500 mb-6">New GitHub signups start as <span class="text-amber-600 dark:text-amber-400">pending</span> and can't sign in until you approve them. Banning blocks dashboard and API access immediately. Removing the last remaining admin is blocked to prevent lockout.</p>
<ul class="space-y-2">${rows}</ul>${inviteSection}`;
  return layout({ base, title: "Admin", user, body });
}

export function errorPage(base: string, status: number, message: string, user?: { login: string } | null): string {
  return layout({
    base,
    title: `${status}`,
    user,
    body: `<div class="max-w-md mx-auto mt-24 text-center"><h1 class="text-3xl font-bold mb-2">${status}</h1><p class="text-zinc-500">${esc(message)}</p></div>`,
  });
}
