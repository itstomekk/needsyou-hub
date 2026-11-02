# Development notes

Plain ESM, no build step, no dependencies. `plugin.js` imports only `@hermes/plugin-sdk`, `react` and `react/jsx-runtime`, and is loaded uncompiled (no JSX, it uses `jsx()` / `jsxs()` directly).

```bash
node --check plugin.js   # syntax
node test.mjs            # logic tests against a mocked SDK, prints ALL PASS
```

Install by copying `plugin.js` to `%LOCALAPPDATA%\hermes\desktop-plugins\needs-you-hub\plugin.js`, then Ctrl+K, **Reload desktop plugins**. The plugin folder name is `needs-you-hub`; the repo is called `needsyou-hub`.

## How it works

| Need | Source |
|---|---|
| New question / approval from any session | `host.onEvent('clarify.request' / 'approval.request')`. Payload has `prompt_id`, `questions[]` (`qid`, `question`, `choices`, `multi_select`) or `command` / `description` / `choices`. |
| Question gone (answered elsewhere, turn ended) | `*.settled` event, plus a reconcile on every poll: a prompt whose session is no longer `waiting` is dropped after an 8 s grace. |
| Session list, titles, status | `host.request('session.active_list')`. Status values: `waiting` (needs you), `working`, `starting`, `idle`. |
| Sub-agents | `host.request('delegation.status')`, `active[].owner_agent_session_id`. Skipped when nothing is working. |
| Question text for sessions that were already waiting | `session.resume` with `omit_messages: true`, then `open_requests` / `pending_approval`. Same call the app uses to hydrate a session. |
| Send clarify answer | `clarify.lock` per question (same as the app's own prompt), falls back to `clarify.respond` for single questions on older gateways. The answer is the choice text without `(Recommended)`; multi-select is a JSON array string. |
| Send approval | `approval.respond` with `{ session_id, profile, request_id, choice }`. |
| Reply to a session | `prompt.submit`. |
| Last message of a session | `session.history` (read-only). |
| Open a session | `host.navigate('/' + sessionId)` (route is `#/<id>`). |

All of this was read from the installed desktop app's bundled JavaScript (the `i18n-*`, `index-*` and `use-deep-link-highlight-*` assets under `apps/desktop/release/win-unpacked/resources/app.asar.unpacked/dist/assets`), not from the SDK docs. Method and event names drift between builds, so re-check them after a major app update.

## Behaviour worth knowing

- **Polling.** One adaptive poller: 4 s while the page is open, 10 s otherwise, 30 s while the window is hidden. The in-flight fetch is shared. `$rows` / `$children` are only set when content actually changed (`rowsSig`).
- **Done.** Any idle, non-cron session with a result and a `last_active` newer than its stored read mark. The read mark is `{ t: last activity, n: message count }`, kept in plugin storage (`dismissed`). A newer `last_active` brings the session back. A "Why not in Done?" fold lists every non-Done idle session with its reason. Falls back to `started_at` when `last_active` is empty.
- **Stale "working" rows.** Rows with no activity for 6 h (`STALE_S`) are flagged "probably stuck". `row.last_active` is not reliable for live sessions (a session working right now can show an old value), so do not use short thresholds on it.
- **Excerpt cache.** The last-message excerpt is keyed by `message_count`, not `last_active` (which is stale for live sessions). `session.history` has no limit parameter server-side, so it is fetched only when the message count changes, one call at a time.
- **Mark read and the sidebar.** `markRead()` also calls the SDK's `forgetSessionUnread(ids, profile)` and sends `PATCH /api/sessions/<key>` with `{ unread: false }` through `window.hermesDesktop.api`. Both are best-effort. In the other direction, each fetch reads the `hermes.desktop.unreadFinishedSessions` localStorage key: an id that left the list counts as read in the plugin, an id that joined drops the plugin's read mark. Only sessions that were in the app's list can sync this way.
- **Sort pinned.** Reads `hermes.desktop.pinnedSessions`, takes times from `host.listPersistedSessions` plus live rows, and calls the SDK's `sessionsApi.reorderPinned(sorted)`. One-off. The response shape of `listPersistedSessions` is assumed (`{ sessions: [...] }` or a plain array).
- **Persistence.** Pending prompts are stored in plugin storage so a hot reload does not lose them; stale ones are pruned by the first poll.
- **Recovery.** `session.resume` is called automatically once per waiting session without known details (`recoverAttempted`), then only on button press.

## Gotchas

- Event `session_id` is the runtime id; the list `id` can differ. Recovered items keep `rowId` for matching against the list.
- A plugin cannot recolour the sidebar's own dots. Only `SESSION_ROW_AREAS` decorations are possible.
- `export const __test` exists for the harness; the loader ignores it.

## Not covered / open

- Live end-to-end send of every prompt type (answers are mock-tested; approval sending is the least exercised).
- Sudo and secret prompts.
- Ideas: per-session row badge via `SESSION_ROW_AREAS`, OS notification, filter by profile.
