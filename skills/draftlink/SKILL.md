---
name: draftlink
description: When the user asks for a draftlink or an HTML writeup of work (NOT as part of the codebase). Also use to read or update drafts when given a draftlink link.
---

# Draftlink

Draftlink is a personal service for hosting single HTML pages.

Create and publish readable HTML plans, proposals, briefs, reports, or architecture notes as searchable, status-tracked drafts.

All requests go through the `draftlink` CLI (installed globally). The user is responsible for logging-in. If a command fails with "not logged in", tell the human to run `draftlink auth login` and stop.

The service adds a header to every draft (a "draftlink" link back to the dashboard and the dark-mode toggle) and loads Tailwind with `darkMode: 'class'`. Do not add any page chrome — no nav, back link, or theme button.

Style theme-dependent content with Tailwind `dark:` variants; never use `@media (prefers-color-scheme: ...)` — the toggle flips the `dark` class on `<html>`, which media queries ignore. Give text and controls deliberate colors in both modes.

Do not write your own theme toggle, storage key, or logic. Ensure text and controls have deliberate colors in both modes. Keep the writeup concise and readable. Do not publish secrets, local paths, or private URLs.

Publish (prints `id` and `url`); title is a short human summary, project is the working repo's basename:

```sh
draftlink upload file.html --title "Short title" --project myrepo
```

Return the resulting `url`.

Drafts are private by default: only the owner and people the owner granted by GitHub handle (read/write) can open them. An owner may make a draft public, which turns its link into a read-only page for anyone.

Read a draftlink link with your stored login:

```sh
draftlink read <url-or-id>     # prints the uploaded HTML to stdout
```

Reading requires access — if it fails with 404, the draft is private and not shared with you; don't retry unauthenticated. Public drafts are also readable by plain `curl <url>`.

Update an existing draft (same public URL, no version history):

```sh
draftlink update <id> --file v2.html [--title T] [--project P] [--status S]
```

Omitting `--file` keeps the current HTML and only changes the metadata.

`--public` and `--private` change who can read the draft. NEVER pass `--public` unless the user explicitly asked to publish that draft — it exposes the content to the entire internet.

Statuses are `active`, `done`, `archived`. Set `done` when the user says the work shipped; `archived` only when they explicitly ask to archive/hide a draft (it disappears from the dashboard's default view). Never delete unless asked explicitly (owner-only anyway).

Search the user's drafts when they ask where something went:

```sh
draftlink list [query]
```
