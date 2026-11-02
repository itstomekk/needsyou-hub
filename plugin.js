// Needs You Hub - one page for every question Hermes sessions are asking you.
//
// - Listens to clarify.request / approval.request gateway events from ALL live sessions.
// - Lets you answer them in one place (clarify.lock / clarify.respond / approval.respond,
//   the same RPCs the chat's own prompt uses).
// - Shows what is working (with sub-agents) and what finished recently.
//
// Plain ESM, no build step. Install: copy to $HERMES_HOME/desktop-plugins/needs-you-hub/plugin.js

import {
  host,
  haptic,
  atom,
  useValue,
  useQuery,
  Button,
  Input,
  Codicon,
  EmptyState,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  STATUSBAR_AREAS
} from '@hermes/plugin-sdk'
import * as SDK from '@hermes/plugin-sdk'
import { useEffect, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ROUTE = '/needs-you-hub'
const POLL_MS = 4000
const STALE_GRACE_MS = 8000
const INBOX_MAX = 12
const STALE_S = 6 * 3600 // a 'working' session with no activity this long is flagged as probably stuck

// ---------------------------------------------------------------- pure logic

const stripRec = s => String(s ?? '').replace(/\s*\(Recommended\)\s*$/i, '').trim()

/** Normalise a clarify.request / approval.request gateway payload into a pending item. */
function itemFromEvent(type, e, now = Date.now()) {
  const p = e && e.payload
  if (!p || !e.session_id || typeof p.prompt_id !== 'string' || !p.prompt_id) return null
  const base = { promptId: p.prompt_id, sessionId: e.session_id, profile: e.profile || 'default', at: now }
  if (type === 'clarify.request') {
    const raw = Array.isArray(p.questions) && p.questions.length
      ? p.questions
      : [{ qid: p.prompt_id, question: p.question, choices: p.choices, multi_select: p.multi_select }]
    const questions = raw
      .map(q => {
        const choices = Array.isArray(q.choices) ? q.choices.filter(c => typeof c === 'string' && c.trim()) : []
        return {
          qid: String(q.qid ?? p.prompt_id),
          question: String(q.question ?? '').trim(),
          choices,
          multiSelect: q.multi_select === true && choices.length > 0
        }
      })
      .filter(q => q.question)
    if (!questions.length) return null
    return { ...base, kind: 'clarify', questions }
  }
  if (type === 'approval.request') {
    const choices = Array.isArray(p.choices) && p.choices.length ? p.choices.filter(c => typeof c === 'string') : ['once', 'deny']
    return {
      ...base,
      kind: 'approval',
      command: typeof p.command === 'string' ? p.command : '',
      description: typeof p.description === 'string' ? p.description : '',
      choices
    }
  }
  return null
}

const isWaiting = row => row && row.status === 'waiting'
const isWorking = row => row && (row.status === 'working' || row.status === 'starting')

function findRow(rows, sessionId) {
  return rows.find(r => r.id === sessionId || r.session_key === sessionId) || null
}

/** Prompt ids whose session is known and no longer waiting (answered elsewhere / turn ended). */
function staleIds(pendingMap, rows, now = Date.now()) {
  const out = []
  for (const it of Object.values(pendingMap)) {
    if (now - it.at < STALE_GRACE_MS) continue
    const row = findRow(rows, it.rowId || it.sessionId) || findRow(rows, it.sessionId)
    if (row && !isWaiting(row)) out.push(it.promptId)
  }
  return out
}

/** Sessions flagged waiting by the gateway that we hold no prompt details for. */
function orphanWaiting(pendingMap, rows) {
  const known = new Set(Object.values(pendingMap).flatMap(i => [i.sessionId, i.rowId].filter(Boolean)))
  return rows.filter(r => isWaiting(r) && !known.has(r.id) && !known.has(r.session_key))
}

/** Pending prompts out of a session.resume snapshot (open_requests / pending_approval). */
function itemsFromSnapshot(res, row, profile = 'default', now = Date.now()) {
  if (!res || typeof res !== 'object') return []
  const sid = res.session_id || (row && row.id)
  if (!sid) return []
  const out = []
  const seen = new Set()
  const add = (type, promptId, payload) => {
    if (!promptId || seen.has(promptId)) return
    const it = itemFromEvent(type, { session_id: sid, profile, payload: { ...payload, prompt_id: promptId } }, now)
    if (it) { seen.add(promptId); out.push(it) }
  }
  for (const r of Array.isArray(res.open_requests) ? res.open_requests : []) {
    if (r && (r.method === 'clarify' || r.method === 'approval')) add(`${r.method}.request`, r.id, r.params || {})
  }
  const pa = res.pending_approval
  if (pa && typeof pa === 'object') add('approval.request', pa.prompt_id || pa.request_id, pa)
  return out
}

function msgText(m) {
  const c = m && (m.content ?? m.text)
  if (typeof c === 'string') return c.trim()
  if (Array.isArray(c)) return c.map(x => (typeof x === 'string' ? x : (x && x.text) || '')).join('').trim()
  return ''
}

/** Last assistant message of a resume snapshot: what the session said before waiting. */
function lastAssistantText(res) {
  const ms = res && Array.isArray(res.messages) ? res.messages : []
  for (let i = ms.length - 1; i >= 0; i--) {
    if (ms[i] && ms[i].role === 'assistant') {
      const t = msgText(ms[i])
      if (t) return t
    }
  }
  return ''
}

/** Resume a waiting session: recover any open prompt AND return its last assistant message. */
async function loadOrphan(row, rpc = host.request) {
  const profile = (host.state.profile && host.state.profile.get && host.state.profile.get()) || 'default'
  const res = await rpc('session.resume', { session_id: row.id, profile })
  const items = itemsFromSnapshot(res, row, profile)
  if (items.length) {
    const cur = $pending.get()
    const next = { ...cur }
    for (const it of items) if (!next[it.promptId]) next[it.promptId] = { ...it, rowId: row.id }
    $pending.set(next)
  }
  return { n: items.length, text: lastAssistantText(res), sessionId: (res && res.session_id) || row.id, profile }
}

/** Free-text reply into a session (same call the composer uses). */
function sendText(sessionId, text, rpc = host.request) {
  return rpc('prompt.submit', { session_id: sessionId, text: String(text).trim() })
}

const recoverAttempted = new Set()

/** Load the question text of a session that was already waiting before this plugin saw its event. */
async function recoverOrphan(row, rpc = host.request) {
  const profile = (host.state.profile && host.state.profile.get && host.state.profile.get()) || 'default'
  const res = await rpc('session.resume', { session_id: row.id, profile, omit_messages: true })
  const items = itemsFromSnapshot(res, row, profile)
  const cur = $pending.get()
  const next = { ...cur }
  for (const it of items) if (!next[it.promptId]) next[it.promptId] = { ...it, rowId: row.id }
  if (Object.keys(next).length !== Object.keys(cur).length) $pending.set(next)
  return items.length
}

/** Queued/lost admissions listed in a session.resume result (several possible shapes). */
function pendingOf(res) {
  const out = []
  for (const src of [res && res.pending, res && res.info && res.info.pending, res && res.pending_submissions, res && res.info && res.info.pending_submissions])
    if (Array.isArray(src)) for (const p of src) if (p && p.admission_id && !out.some(o => o.admission_id === p.admission_id)) out.push(p)
  return out
}

/**
 * Clear a session that is stuck "working"/"starting": interrupt a running turn, retire queued
 * messages, acknowledge lost (unknown) turns so the queue stops waiting on them.
 * Returns a short human summary of what was done.
 */
async function stopSession(row, rpc = host.request) {
  const profile = (host.state.profile && host.state.profile.get && host.state.profile.get()) || 'default'
  const res = await rpc('session.resume', { session_id: row.id, profile, omit_messages: true })
  const gen = [res && res.execution_generation, res && res.info && res.info.execution_generation].find(g => typeof g === 'number')
  const running = !!(res && (res.running === true || (res.info && res.info.running === true)))
  const pend = pendingOf(res)
  const done = []
  if (running && typeof gen === 'number') {
    await rpc('session.interrupt', { session_id: row.id, profile, execution_generation: gen })
    done.push('interrupted the running turn')
  }
  let nq = 0
  for (const p of pend.filter(x => x.status === 'queued')) {
    try { await rpc('prompt.cancel', { session_id: row.id, profile, admission_id: p.admission_id }); nq++ } catch { /* already started */ }
  }
  if (nq) done.push(`cancelled ${nq} queued message(s)`)
  let nu = 0
  for (const p of pend.filter(x => x.status === 'unknown')) {
    const g = typeof p.execution_generation === 'number' ? p.execution_generation : gen
    if (typeof g !== 'number') continue
    try { await rpc('prompt.resolve_unknown', { session_id: row.id, profile, admission_id: p.admission_id, execution_generation: g }); nu++ } catch { /* leave it */ }
  }
  if (nu) done.push(`cleared ${nu} lost turn(s)`)
  if (!done.length) {
    const keys = res && typeof res === 'object' ? Object.keys(res).join(',') : typeof res
    throw new Error(`nothing to stop (running=${running}, pending=${pend.length}; resume keys: ${keys})`)
  }
  return done.join(', ')
}

async function recoverOrphans(rows) {
  for (const r of orphanWaiting($pending.get(), rows)) {
    if (recoverAttempted.has(r.id)) continue
    recoverAttempted.add(r.id)
    try { await recoverOrphan(r) } catch { /* the card keeps its manual "Load question" button */ }
  }
}

function answerFor(q, state) {
  const picked = state.sel[q.qid]
  const other = (state.other[q.qid] || '').trim()
  if (q.multiSelect) {
    const arr = [...(Array.isArray(picked) ? picked : []).map(stripRec), ...(other ? [other] : [])]
    return arr.length ? JSON.stringify(arr) : ''
  }
  if (other) return other
  return picked ? stripRec(picked) : ''
}

function allAnswered(item, state) {
  return item.questions.every(q => answerFor(q, state) !== '')
}

async function sendClarify(item, state, rpc = host.request) {
  for (const q of item.questions) {
    const answer = answerFor(q, state)
    const params = { session_id: item.sessionId, profile: item.profile, request_id: item.promptId, question_id: q.qid, answer }
    let res
    try {
      res = await rpc('clarify.lock', params)
    } catch (err) {
      if (!/unknown method/i.test(String(err)) || item.questions.length > 1) throw err
      res = await rpc('clarify.respond', { session_id: item.sessionId, profile: item.profile, request_id: item.promptId, answer })
    }
    if (res && res.status === 'expired') throw new Error('This question already expired or was answered elsewhere.')
  }
}

function sendApproval(item, choice, rpc = host.request) {
  return rpc('approval.respond', { session_id: item.sessionId, profile: item.profile, request_id: item.promptId, choice })
}

function ago(tsSeconds, nowMs = Date.now()) {
  if (!tsSeconds) return ''
  const s = Math.max(0, Math.round(nowMs / 1000 - tsSeconds))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function titleOf(row, fallbackId) {
  const t = row && (row.title || row.preview)
  if (t && String(t).trim()) return String(t).trim()
  const id = (row && row.id) || fallbackId || ''
  return id ? `Session ${String(id).replace(/^local-/, '').slice(0, 8)}` : 'Untitled session'
}

// ---------------------------------------------------------------- unread inbox (pure)

/** Ids that were busy in `prev` and are idle in `next`: a finished run is news even if the activity stamp did not move. */
function justFinished(prev, next) {
  const busy = new Set(prev.filter(r => r.status === 'working' || r.status === 'starting' || r.status === 'waiting').map(r => r.id))
  return next.filter(r => r.status === 'idle' && busy.has(r.id)).map(r => r.id)
}

/** Last activity of a row; falls back to start time when the gateway has no activity stamp. */
const lastAct = r => r.last_active || r.started_at || 0

/**
 * Read mark = { t: last activity, n: message count } at the time of "Mark read".
 * (Legacy: a bare number = last activity only.) A session is read only while neither has grown.
 */
function isRead(rec, r) {
  if (rec === undefined || rec === null) return false
  const t = typeof rec === 'object' ? rec.t || 0 : rec
  const n = typeof rec === 'object' && rec.n != null ? rec.n : Infinity
  return lastAct(r) <= t && (r.message_count || 0) <= n
}

/** Finished, quiet sessions with something new since the user last marked them read. */
function inboxRows(rows, dismissed, focusedId, nowS = Date.now() / 1000) {
  return rows
    .filter(r => {
      if (r.status !== 'idle' || r.source === 'cron' || !(r.message_count > 0)) return false
      return !isRead(dismissed[r.id], r)
    })
    .sort((a, b) => lastAct(b) - lastAct(a))
}

/** Why a row is NOT in Done (for the diagnostics list). Empty string = it is in Done. */
function doneReason(r, dismissed, focusedId, nowS = Date.now() / 1000) {
  if (r.status !== 'idle') return `status is "${r.status}"`
  if (r.source === 'cron') return 'source is cron'
  if (!(r.message_count > 0)) return 'no messages'
  if (isRead(dismissed[r.id], r)) return 'marked read'
  return ''
}

/** The last n paragraphs of the last real assistant message in a session.history payload. */
function lastParagraphs(res, n = 3, maxChars = 1400) {
  const ms = res && Array.isArray(res.messages) ? res.messages : []
  for (let i = ms.length - 1; i >= 0; i--) {
    const m = ms[i]
    if (!m || m.role !== 'assistant') continue
    const t = msgText(m)
    if (!t) continue
    let out = t.split(/\n\s*\n/).map(x => x.trim()).filter(Boolean).slice(-n).join('\n\n')
    if (out.length > maxChars) out = '…' + out.slice(out.length - maxChars)
    return out
  }
  return ''
}

const excerptCache = new Map() // `${id}:${message_count}:${n}` -> text
let excerptChain = Promise.resolve()

/** Loads one excerpt at a time, once per message revision. Read-only RPC, no session wake-up. */
function loadExcerpt(row, rpc = host.request, n = 3) {
  const key = row.id + ':' + (row.message_count || 0) + ':' + n
  if (excerptCache.has(key)) return Promise.resolve(excerptCache.get(key))
  const job = excerptChain.then(async () => {
    if (excerptCache.has(key)) return excerptCache.get(key)
    let text = ''
    try { text = lastParagraphs(await rpc('session.history', { session_id: row.id }), n) } catch { text = '' }
    excerptCache.set(key, text)
    if (excerptCache.size > 60) excerptCache.delete(excerptCache.keys().next().value)
    return text
  })
  excerptChain = job.catch(() => {})
  return job
}

/** Cheap change detector: only the fields the UI reads. */
function rowsSig(rows) {
  let out = ''
  for (const r of rows) out += `${r.id}|${r.status}|${r.last_active || 0}|${r.message_count || 0}|${r.title || ''}|${r.source || ''}\n`
  return out
}
function kidsSig(kids) { return JSON.stringify(kids) }
let lastRowsSig = '', lastKidsSig = ''

// ---------------------------------------------------------------- shared state

const $pending = atom({})          // promptId -> item
const $rows = atom([])             // last active_list rows
const $children = atom([])         // delegation.status active[]
const $folded = atom({})           // section key -> true when collapsed
const $dismissed = atom({})        // sessionId -> last_active when marked read
let storage = null

const openSession = id => host.navigate('/' + encodeURIComponent(id))
const countWaiting = () => Object.keys($pending.get()).length + orphanWaiting($pending.get(), $rows.get()).length

function removePrompt(promptId) {
  const cur = $pending.get()
  if (!(promptId in cur)) return
  const next = { ...cur }
  delete next[promptId]
  $pending.set(next)
}

/**
 * Also clear Hermes' own unread state so the green dot in the left pane goes away:
 * local per-profile "finished unread" list (SDK forgetSessionUnread) + server flag (PATCH unread:false).
 */
function syncSidebarRead(rowsToMark, deps = {}) {
  const forget = deps.forget || SDK.forgetSessionUnread
  const api = deps.api || (typeof window !== 'undefined' && window.hermesDesktop && window.hermesDesktop.api)
  const byProfile = {}
  for (const r of rowsToMark) {
    const prof = r.profile || (host.state.profile && host.state.profile.get && host.state.profile.get()) || 'default'
    ;(byProfile[prof] = byProfile[prof] || []).push(r)
  }
  for (const [prof, rs] of Object.entries(byProfile)) {
    const ids = [...new Set(rs.flatMap(r => [r.id, r.session_key]).filter(Boolean))]
    try { if (typeof forget === 'function') forget(ids, prof) } catch { /* best effort */ }
    if (typeof api !== 'function') continue
    for (const r of rs) {
      const sid = r.session_key || r.id
      Promise.resolve()
        .then(() => api({ path: `/api/sessions/${encodeURIComponent(sid)}`, method: 'PATCH', body: { unread: false, profile: prof }, profile: prof, priority: 'foreground' }))
        .catch(() => {})
    }
  }
}

/** Pinned ids sorted newest-first by activity. Ids with no known time keep their order at the end. */
function sortPinnedIds(ids, times) {
  const t = id => times.get(id) || 0
  return ids.map((id, i) => ({ id, i })).sort((a, b) => (t(b.id) - t(a.id)) || (a.i - b.i)).map(x => x.id)
}

/** One-off: reorder the left-pane Pinned list from newest to oldest. Returns a short summary. */
async function sortPinned(deps = {}) {
  const storage = deps.storage || localStorage
  const list = deps.list || ((profile) => host.listPersistedSessions(null, { profile, limit: 500 }))
  const reorder = deps.reorder || (ids => SDK.sessionsApi.reorderPinned(ids))
  const profile = (host.state.profile && host.state.profile.get && host.state.profile.get()) || 'default'
  let ids
  try { ids = JSON.parse(storage.getItem('hermes.desktop.pinnedSessions') || '[]') } catch { ids = [] }
  if (!Array.isArray(ids) || ids.length < 2) throw new Error('fewer than 2 pinned sessions')
  const res = await list(profile)
  const arr = Array.isArray(res) ? res : (res && (res.sessions || res.items)) || []
  const times = new Map()
  for (const r of arr) {
    const tm = Number(r.last_active || r.last_activity_at || r.updated_at || r.started_at || 0)
    for (const k of [r.id, r.session_key]) if (k) times.set(k, tm)
  }
  for (const r of $rows.get()) for (const k of [r.id, r.session_key]) if (k && lastAct(r) > (times.get(k) || 0)) times.set(k, lastAct(r))
  const known = ids.filter(id => times.has(id)).length
  const sorted = sortPinnedIds(ids, times)
  reorder(sorted)
  return `sorted ${ids.length} pinned (${known} with a known time)`
}

const APP_UNREAD_KEY = 'hermes.desktop.unreadFinishedSessions'
let prevAppUnread = null

/** Ids the app currently shows with a green "finished, unread" dot (all profiles). */
function readAppUnread(storage = typeof localStorage !== 'undefined' ? localStorage : null) {
  const out = new Set()
  try {
    const o = JSON.parse((storage && storage.getItem(APP_UNREAD_KEY)) || '{}')
    for (const arr of Object.values(o || {})) if (Array.isArray(arr)) for (const id of arr) if (typeof id === 'string') out.add(id)
  } catch { /* ignore */ }
  return out
}

/**
 * Left pane -> plugin. If the app cleared a green dot (id left its unread list) the session counts as read here;
 * if the app lit a dot (id joined the list) any plugin "read" mark is dropped so it shows in Done again.
 * Returns the new dismissed map or null when nothing changed.
 */
function reconcileAppUnread(prev, now, rows, dismissed) {
  if (!prev) return null
  const next = { ...dismissed }
  let changed = false
  for (const r of rows) {
    const keys = [r.id, r.session_key].filter(Boolean)
    const was = keys.some(k => prev.has(k)), is = keys.some(k => now.has(k))
    if (was && !is && !isRead(next[r.id], r)) { next[r.id] = { t: lastAct(r), n: r.message_count || 0 }; changed = true }
    if (!was && is && next[r.id] !== undefined) { delete next[r.id]; changed = true }
  }
  return changed ? next : null
}

function syncFromApp(rows) {
  const now = readAppUnread()
  const next = reconcileAppUnread(prevAppUnread, now, rows, $dismissed.get())
  prevAppUnread = now
  if (next) $dismissed.set(next)
}

function markRead(rowsToMark) {
  try { syncSidebarRead(rowsToMark) } catch { /* never block our own state */ }
  const next = { ...$dismissed.get() }
  for (const r of rowsToMark) next[r.id] = { t: lastAct(r), n: r.message_count || 0 }
  $dismissed.set(next)
}

let inflight = null
let lastFetchAt = 0
let pageOpen = 0   // mounted Page instances
const isHidden = () => typeof document !== 'undefined' && document.hidden

/** One shared fetch; concurrent callers (page query, background tick, Refresh) reuse it. */
function fetchSessions() {
  if (inflight) return inflight
  inflight = fetchSessionsNow().finally(() => { inflight = null; lastFetchAt = Date.now() })
  return inflight
}

/** How long the background tick waits before fetching again. */
function pollDelay(open, hidden) {
  if (hidden) return 30000
  return open ? POLL_MS : 10000
}

async function fetchSessionsNow() {
  const needKids = $children.get().length > 0 || $rows.get().some(isWorking) || !lastRowsSig
  const [a, d] = await Promise.allSettled([host.request('session.active_list', {}), needKids ? host.request('delegation.status', {}) : Promise.resolve({ active: [] })])
  const rows = a.status === 'fulfilled' && Array.isArray(a.value && a.value.sessions) ? a.value.sessions : null
  const kids = d.status === 'fulfilled' && Array.isArray(d.value && d.value.active) ? d.value.active : []
  if (!rows) throw a.reason || new Error('session.active_list failed')
  syncFromApp(rows)
  const fin = justFinished($rows.get(), rows)
  if (fin.length) {
    const next = { ...$dismissed.get() }
    for (const id of fin) delete next[id]
    $dismissed.set(next)
  }
  const rs = rowsSig(rows)
  if (rs !== lastRowsSig) { lastRowsSig = rs; $rows.set(rows) }
  const ks = kidsSig(kids)
  if (ks !== lastKidsSig) { lastKidsSig = ks; $children.set(kids) }
  for (const id of staleIds($pending.get(), rows)) removePrompt(id)
  recoverOrphans(rows).catch(() => {})
  return { rows, kids }
}

// ---------------------------------------------------------------- UI

const S = {
  page: { display: 'flex', flexDirection: 'column', gap: 18, padding: '18px 22px', overflowY: 'auto', height: '100%', fontSize: 13 },
  h1: { fontSize: 16, fontWeight: 600, margin: 0 },
  muted: { color: 'var(--ui-text-tertiary)' },
  section: { display: 'flex', flexDirection: 'column', gap: 8 },
  sectionHead: { fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--ui-text-secondary)' },
  card: { border: '1px solid var(--ui-stroke-secondary)', borderRadius: 8, padding: 12, display: 'flex', flexDirection: 'column', gap: 10 },
  cardAttn: { borderColor: 'var(--ui-accent)' },
  row: { display: 'flex', alignItems: 'center', gap: 8 },
  rowBetween: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  title: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  question: { whiteSpace: 'pre-wrap', lineHeight: 1.45 },
  choices: { display: 'flex', flexDirection: 'column', gap: 5 },
  pre: { margin: 0, padding: 8, borderRadius: 6, border: '1px solid var(--ui-stroke-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 12, maxHeight: 160, overflow: 'auto' },
  err: { color: 'var(--ui-accent)', fontSize: 12 }
}

function choiceButton(label, letter, selected, onClick) {
  return jsxs('button', {
    type: 'button',
    onClick,
    style: {
      display: 'flex', alignItems: 'baseline', gap: 8, textAlign: 'left', cursor: 'pointer', padding: '6px 9px', borderRadius: 6,
      color: 'inherit', background: 'transparent',
      border: `1px solid ${selected ? 'var(--ui-accent)' : 'var(--ui-stroke-secondary)'}`,
      outline: selected ? '1px solid var(--ui-accent)' : 'none'
    },
    children: [
      jsx('span', { style: { ...S.muted, fontWeight: 600, minWidth: 14 }, children: letter }),
      jsx('span', { style: S.question, children: label })
    ]
  })
}

function QuestionBlock({ q, state, setState }) {
  const toggle = choice => {
    setState(s => {
      const sel = { ...s.sel }
      const other = { ...s.other }
      if (q.multiSelect) {
        const cur = Array.isArray(sel[q.qid]) ? sel[q.qid] : []
        sel[q.qid] = cur.includes(choice) ? cur.filter(c => c !== choice) : [...cur, choice]
      } else {
        sel[q.qid] = choice
        other[q.qid] = ''
      }
      return { ...s, sel, other }
    })
  }
  const picked = state.sel[q.qid]
  const isSel = c => (q.multiSelect ? Array.isArray(picked) && picked.includes(c) : picked === c)
  return jsxs('div', {
    style: S.section,
    children: [
      jsx('div', { style: S.question, children: q.question }),
      q.choices.length
        ? jsx('div', { style: S.choices, children: q.choices.map((c, i) => choiceButton(c, String.fromCharCode(65 + i), isSel(c), () => toggle(c))) })
        : null,
      jsx(Input, {
        value: state.other[q.qid] || '',
        placeholder: q.choices.length ? 'Other answer…' : 'Your answer…',
        onChange: ev => {
          const v = ev.target.value
          setState(s => ({ ...s, other: { ...s.other, [q.qid]: v }, sel: q.multiSelect ? s.sel : { ...s.sel, [q.qid]: v ? '' : s.sel[q.qid] } }))
        }
      })
    ]
  })
}

function ClarifyCard({ item, row }) {
  const [state, setState] = useState({ sel: {}, other: {} })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const submit = async () => {
    setBusy(true)
    setErr('')
    try {
      await sendClarify(item, state)
      haptic('tap')
      removePrompt(item.promptId)
    } catch (e) {
      setErr(String((e && e.message) || e))
      setBusy(false)
    }
  }
  return jsxs('div', {
    style: { ...S.card, ...S.cardAttn },
    children: [
      cardHead(item, row),
      ...item.questions.map(q => jsx(QuestionBlock, { key: q.qid, q, state, setState })),
      jsxs('div', {
        style: S.rowBetween,
        children: [
          jsx('span', { style: S.err, children: err }),
          jsx(Button, { disabled: busy || !allAnswered(item, state), onClick: submit, children: busy ? 'Sending…' : 'Send answer' })
        ]
      }),
      jsx(SessionTail, { row, sessionId: item.sessionId })
    ]
  })
}

function ApprovalCard({ item, row }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const decide = async choice => {
    setBusy(true)
    setErr('')
    try {
      await sendApproval(item, choice)
      haptic('tap')
      removePrompt(item.promptId)
    } catch (e) {
      setErr(String((e && e.message) || e))
      setBusy(false)
    }
  }
  const label = c => ({ once: 'Allow once', session: 'Allow for session', always: 'Always allow', deny: 'Deny' }[c] || c)
  return jsxs('div', {
    style: { ...S.card, ...S.cardAttn },
    children: [
      cardHead(item, row, 'Approval'),
      item.description ? jsx('div', { style: S.question, children: item.description }) : null,
      item.command ? jsx('pre', { style: S.pre, children: item.command }) : null,
      jsxs('div', {
        style: { ...S.row, flexWrap: 'wrap' },
        children: [
          ...item.choices.map(c => jsx(Button, { key: c, variant: c === 'deny' ? 'outline' : undefined, disabled: busy, onClick: () => decide(c), children: label(c) })),
          jsx('span', { style: S.err, children: err })
        ]
      }),
      jsx(SessionTail, { row, sessionId: item.sessionId })
    ]
  })
}

/** Collapsed "last message" + reply box for waiting cards. Loads only when opened. */
function SessionTail({ row, sessionId }) {
  const r = row || { id: sessionId, last_active: 0 }
  const [open, setOpen] = useState(false)
  const [text, setText] = useState(null)
  const [reply, setReply] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  useEffect(() => {
    let live = true
    if (open) loadExcerpt(r, host.request, 2).then(t => { if (live) setText(t) })
    return () => { live = false }
  }, [open, r.id, r.message_count])
  const send = async () => {
    setBusy(true)
    setErr('')
    try { await sendText(r.id, reply); haptic('tap'); setReply('') } catch (e) { setErr(String((e && e.message) || e)) }
    setBusy(false)
  }
  return jsxs('div', {
    style: S.section,
    children: [
      jsx('button', { type: 'button', onClick: () => setOpen(!open), style: { ...S.muted, cursor: 'pointer', background: 'transparent', border: 'none', padding: 0, textAlign: 'left' }, children: open ? '▾ Last message' : '▸ Last message' }),
      open ? (text ? jsx('div', { style: { ...S.question, maxHeight: 220, overflow: 'auto' }, children: text }) : jsx('div', { style: S.muted, children: text === null ? 'Loading…' : 'No text to show.' })) : null,
      jsxs('div', {
        style: S.rowBetween,
        children: [
          jsx(Input, { value: reply, placeholder: 'Reply to this session…', onChange: e => setReply(e.target.value), onKeyDown: e => { if (e.key === 'Enter' && reply.trim() && !busy) send() } }),
          jsx(Button, { variant: 'outline', disabled: busy || !reply.trim(), onClick: send, children: 'Send' })
        ]
      }),
      err ? jsx('div', { style: S.err, children: err }) : null
    ]
  })
}

function cardHead(item, row, tag) {
  return jsxs('div', {
    style: S.rowBetween,
    children: [
      jsxs('div', {
        style: { ...S.row, minWidth: 0 },
        children: [
          jsx(Codicon, { name: item.kind === 'approval' ? 'shield' : 'comment-discussion' }),
          jsx('span', { style: S.title, children: titleOf(row, item.sessionId) }),
          tag ? jsx('span', { style: S.muted, children: tag }) : null,
          jsx('span', { style: S.muted, children: ago(item.at / 1000) })
        ]
      }),
      jsx(Button, { variant: 'outline', onClick: () => openSession((row && row.id) || item.sessionId), children: 'Open session' })
    ]
  })
}

function OrphanCard({ row }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [info, setInfo] = useState(null)
  const [text, setText] = useState('')
  const [sent, setSent] = useState(false)
  const load = async () => {
    setBusy(true)
    setMsg('')
    try {
      const r = await loadOrphan(row)
      setInfo(r)
    } catch (e) {
      setMsg(String((e && e.message) || e))
    }
    setBusy(false)
  }
  useEffect(() => { load() }, [row.id])
  const send = async () => {
    setBusy(true)
    setMsg('')
    try {
      await sendText((info && info.sessionId) || row.id, text)
      haptic('tap')
      setSent(true)
      setText('')
    } catch (e) {
      setMsg(String((e && e.message) || e))
    }
    setBusy(false)
  }
  return jsxs('div', {
    style: { ...S.card, ...S.cardAttn },
    children: [
      jsxs('div', {
        style: S.rowBetween,
        children: [
          jsxs('div', { style: { ...S.row, minWidth: 0 }, children: [jsx(Codicon, { name: 'bell' }), jsx('span', { style: S.title, children: titleOf(row) }), jsx('span', { style: S.muted, children: 'waiting for you' })] }),
          jsxs('div', {
            style: S.row,
            children: [
              jsx(Button, { variant: 'outline', disabled: busy, onClick: load, children: 'Refresh' }),
              jsx(Button, { variant: 'outline', onClick: () => openSession(row.id), children: 'Open session' })
            ]
          })
        ]
      }),
      info && info.text ? jsx('div', { style: { ...S.question, maxHeight: 260, overflow: 'auto' }, children: info.text }) : jsx('div', { style: S.muted, children: busy ? 'Loading what the session said…' : 'No text found. Open the session to see it.' }),
      sent ? jsx('div', { style: S.muted, children: 'Sent. The session continues.' }) : null,
      jsxs('div', {
        style: S.rowBetween,
        children: [
          jsx(Input, { value: text, placeholder: 'Reply to this session…', onChange: e => setText(e.target.value), onKeyDown: e => { if (e.key === 'Enter' && text.trim() && !busy) send() } }),
          jsx(Button, { disabled: busy || !text.trim(), onClick: send, children: 'Send' })
        ]
      }),
      msg ? jsx('div', { style: S.err, children: msg }) : null
    ]
  })
}

function RowCard({ row, kids, working }) {
  const n = working ? 1 : 3
  const dismissed = useValue($dismissed)
  const read = isRead(dismissed[row.id], row)
  const [text, setText] = useState(excerptCache.get(row.id + ':' + (row.last_active || 0) + ':' + n) ?? null)
  const [reply, setReply] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [armed, setArmed] = useState(false)
  const stop = async () => {
    if (!armed) { setArmed(true); setTimeout(() => setArmed(false), 4000); return }
    setBusy(true); setErr('')
    try { const done = await stopSession(row); await fetchSessions(); setErr('Stop: ' + done) } catch (e) { setErr('Stop failed: ' + String((e && e.message) || e)) }
    setBusy(false); setArmed(false)
  }
  useEffect(() => {
    let live = true
    if (!(working && read)) loadExcerpt(row, host.request, n).then(t => { if (live) setText(t) })
    return () => { live = false }
  }, [row.id, row.last_active, read])
  const mine = working && kids ? kids.filter(k => k.owner_agent_session_id === row.id || k.owner_agent_session_id === row.session_key) : []
  const send = async () => {
    setBusy(true)
    setErr('')
    try {
      await sendText(row.id, reply)
      haptic('tap')
      setReply('')
      if (!working) markRead([row])
    } catch (e) {
      setErr(String((e && e.message) || e))
    }
    setBusy(false)
  }
  return jsxs('div', {
    style: S.card,
    children: [
      jsxs('div', {
        style: S.rowBetween,
        children: [
          jsxs('div', { style: { ...S.row, minWidth: 0 }, children: [jsx(Codicon, { name: working ? 'sync' : 'mail' }), jsx('span', { style: S.title, children: titleOf(row) }), jsx('span', { style: S.muted, children: working && Date.now() / 1000 - (row.last_active || 0) > STALE_S ? `⚠ no activity for ${ago(row.last_active).replace(' ago', '')}, probably stuck` : `${working ? 'active ' : ''}${ago(row.last_active)}` })] }),
          jsxs('div', {
            style: S.row,
            children: [
              read && working ? null : jsx(Button, { onClick: () => markRead([row]), children: 'Mark read' }),
              jsx(Button, { variant: 'outline', onClick: () => openSession(row.id), children: 'Open' }),
              working ? jsx(Button, { variant: 'outline', disabled: busy, onClick: stop, children: armed ? 'Click again to stop' : 'Stop' }) : null
            ]
          })
        ]
      }),
      mine.length
        ? jsx('div', {
            style: S.section,
            children: mine.map(k =>
              jsx('div', {
                key: k.subagent_id,
                style: { ...S.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
                children: `↳ subagent · ${k.tool_count ?? 0} tools${k.last_tool ? ` · ${k.last_tool}` : ''} · ${String(k.goal || '').slice(0, 90)}`
              })
            )
          })
        : null,
      working && read
        ? null
        : text
          ? jsx('div', { style: { ...S.question, maxHeight: 280, overflow: 'auto' }, children: text })
          : jsx('div', { style: S.muted, children: text === null ? 'Loading…' : 'No text to show. Open the session.' }),
      jsxs('div', {
        style: S.rowBetween,
        children: [
          jsx(Input, { value: reply, placeholder: 'Reply to this session…', onChange: e => setReply(e.target.value), onKeyDown: e => { if (e.key === 'Enter' && reply.trim() && !busy) send() } }),
          jsx(Button, { variant: 'outline', disabled: busy || !reply.trim(), onClick: send, children: 'Send' })
        ]
      }),
      err ? jsx('div', { style: S.err, children: err }) : null
    ]
  })
}

function toggleFold(key) {
  $folded.set({ ...$folded.get(), [key]: !$folded.get()[key] })
}

function Fold({ id, label, count, extra, children }) {
  const folded = !!useValue($folded)[id]
  return jsxs('div', {
    style: S.section,
    children: [
      jsxs('div', {
        style: S.rowBetween,
        children: [
          jsxs('button', {
            type: 'button',
            onClick: () => toggleFold(id),
            title: folded ? 'Expand' : 'Collapse',
            style: { ...S.sectionHead, cursor: 'pointer', background: 'transparent', border: 'none', padding: 0, display: 'flex', alignItems: 'center', gap: 4 },
            children: [jsx(Codicon, { name: folded ? 'chevron-right' : 'chevron-down' }), `${label} (${count})`]
          }),
          folded ? null : extra || null
        ]
      }),
      ...(folded ? [] : children)
    ]
  })
}

function Page() {
  const pending = useValue($pending)
  const rows = useValue($rows)
  const kids = useValue($children)
  const dismissed = useValue($dismissed)
  const q = useQuery({ queryKey: ['needs-you-hub', 'sessions'], queryFn: fetchSessions, refetchInterval: false, refetchOnWindowFocus: false })
  useEffect(() => {
    pageOpen++
    return () => { pageOpen-- }
  }, [])
  const [note, setNote] = useState('')
  const refresh = () => {
    excerptCache.clear()
    recoverAttempted.clear()
    q.refetch()
  }

  const items = Object.values(pending).sort((a, b) => b.at - a.at)
  const orphans = orphanWaiting(pending, rows)
  const waitingN = items.length + orphans.length
  const workingAll = rows.filter(isWorking).sort((a, b) => (b.last_active || 0) - (a.last_active || 0))
  const nowQ = Date.now() / 1000
  const working = workingAll
  const focusedId = host.state.focusedSessionId.get()
  const hidden = rows
    .map(r => ({ r, why: doneReason(r, dismissed, focusedId, nowQ) }))
    .filter(x => x.why && x.r.status === 'idle')
  const [showAll, setShowAll] = useState(false)
  const done = inboxRows(rows, dismissed, host.state.focusedSessionId.get())
  const shown = showAll ? done : done.slice(0, INBOX_MAX)

  return jsxs('div', {
    style: S.page,
    children: [
      jsxs('div', {
        style: S.rowBetween,
        children: [
          jsx('h1', { style: S.h1, children: 'Needs You' }),
          jsxs('div', { style: S.row, children: [
            jsx(Button, { variant: 'outline', onClick: async () => { try { setNote(await sortPinned()) } catch (e) { setNote('Sort failed: ' + String((e && e.message) || e)) } }, children: 'Sort pinned' }),
          jsx(Button, { variant: 'outline', disabled: q.isFetching, onClick: refresh, children: q.isFetching ? 'Refreshing…' : 'Refresh' }),
          jsx('span', { style: S.muted, children: q.isError ? `Gateway error: ${String(q.error)}` : (note ? note + ' · ' : '') + `${waitingN} waiting · ${working.length} working` })
          ] })
        ]
      }),
      waitingN === 0 && workingAll.length === 0 && done.length === 0 && !q.isLoading
        ? jsx(EmptyState, { title: 'All clear', description: 'No session is waiting for you.' })
        : null,
      waitingN
        ? jsx(Fold, {
            id: 'waiting',
            label: 'Needs you',
            count: waitingN,
            children: [
              ...items.map(it => {
                const row = findRow(rows, it.rowId || it.sessionId) || findRow(rows, it.sessionId)
                return it.kind === 'approval' ? jsx(ApprovalCard, { key: it.promptId, item: it, row }) : jsx(ClarifyCard, { key: it.promptId, item: it, row })
              }),
              ...orphans.map(r => jsx(OrphanCard, { key: r.id, row: r }))
            ]
          })
        : null,
      working.length ? jsx(Fold, { id: 'working', label: 'Working', count: working.length, children: working.map(r => jsx(RowCard, { key: r.id, row: r, kids, working: true })) }) : null,
      done.length
        ? jsx(Fold, {
            id: 'done',
            label: 'Done',
            count: done.length,
            extra: jsx(Button, { variant: 'outline', onClick: () => markRead(done), children: 'Mark all read' }),
            children: [
              ...shown.map(r => jsx(RowCard, { key: r.id, row: r })),
              done.length > shown.length ? jsx(Button, { variant: 'outline', onClick: () => setShowAll(true), children: `Show ${done.length - shown.length} more` }) : null
            ]
          })
        : null,
      hidden.length
        ? jsxs('details', {
            children: [
              jsx('summary', { style: { ...S.sectionHead, cursor: 'pointer' }, children: `Why not in Done? (${hidden.length})` }),
              jsx('div', { style: { ...S.section, marginTop: 6 }, children: hidden.slice(0, 40).map(x => jsx('div', { key: x.r.id, style: { ...S.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }, children: `${titleOf(x.r)} · ${x.why} · ${x.r.source || '?'} · ${ago(x.r.last_active)}` })) })
            ]
          })
        : null
    ]
  })
}

function Chip() {
  const pending = useValue($pending)
  const rows = useValue($rows)
  const n = Object.keys(pending).length + orphanWaiting(pending, rows).length
  const w = rows.filter(isWorking).length
  const u = inboxRows(rows, useValue($dismissed), null).length
  if (!n && !w && !u) return null
  return jsxs('button', {
    type: 'button',
    onClick: () => host.navigate(ROUTE),
    title: 'Open Needs You',
    style: { padding: '0 6px', fontSize: '0.6875rem', cursor: 'pointer', background: 'transparent', border: 'none', color: n ? 'var(--ui-accent)' : 'var(--ui-text-tertiary)', fontWeight: n ? 600 : 400 },
    children: [n ? `needs you ${n}` : null, u ? `${u} done` : null, !n && !u ? `${w} working` : null].filter(Boolean).join(' · ')
  })
}

// ---------------------------------------------------------------- plugin

export const __test = { sortPinnedIds, sortPinned, reconcileAppUnread, readAppUnread, syncSidebarRead, rowsSig, pollDelay, fetchSessions, stopSession, pendingOf, isRead, justFinished, lastAct, doneReason, inboxRows, lastParagraphs, loadExcerpt, excerptCache, markRead, $dismissed, lastAssistantText, loadOrphan, sendText, itemsFromSnapshot, recoverOrphan, itemFromEvent, staleIds, orphanWaiting, answerFor, allAnswered, sendClarify, sendApproval, findRow, ago, titleOf, stripRec, STALE_GRACE_MS }

export default {
  id: 'needs-you-hub',
  name: 'Needs You Hub',
  register(ctx) {
    storage = ctx.storage

    // Restore prompts that were pending before a hot reload; stale ones get pruned by the first poll.
    Promise.resolve(ctx.storage.get('pending'))
      .then(saved => {
        if (saved && typeof saved === 'object' && !Object.keys($pending.get()).length) $pending.set(saved)
      })
      .catch(() => {})
    Promise.resolve(ctx.storage.get('dismissed'))
      .then(saved => { if (saved && typeof saved === 'object') $dismissed.set({ ...saved, ...$dismissed.get() }) })
      .catch(() => {})
    Promise.resolve(ctx.storage.get('folded'))
      .then(saved => { if (saved && typeof saved === 'object') $folded.set({ ...saved, ...$folded.get() }) })
      .catch(() => {})
    ctx.onDispose($folded.listen(v => Promise.resolve(ctx.storage.set('folded', v)).catch(() => {})))
    ctx.onDispose($dismissed.listen(v => Promise.resolve(ctx.storage.set('dismissed', v)).catch(() => {})))
    ctx.onDispose($pending.listen(v => Promise.resolve(ctx.storage.set('pending', v)).catch(() => {})))

    const onPrompt = type => e => {
      const it = itemFromEvent(type, e)
      if (!it || $pending.get()[it.promptId]) return
      $pending.set({ ...$pending.get(), [it.promptId]: it })
      const focused = host.state.focusedSessionId.get()
      if (focused !== it.sessionId) {
        const t = titleOf(findRow($rows.get(), it.sessionId), it.sessionId)
        host.notify({ kind: 'info', message: `❓ "${t}" is waiting for you` })
      }
    }
    ctx.onEvent('clarify.request', onPrompt('clarify.request'))
    ctx.onEvent('approval.request', onPrompt('approval.request'))
    ctx.onEvent('*', e => {
      if (e && typeof e.type === 'string' && e.type.endsWith('.settled') && e.payload && typeof e.payload.prompt_id === 'string') removePrompt(e.payload.prompt_id)
    })

    // Keep chip/sidebar fresh even when the page is closed.
    fetchSessions().catch(() => {})
    ctx.setInterval(() => {
      if (Date.now() - lastFetchAt >= pollDelay(pageOpen > 0, isHidden())) fetchSessions().catch(() => {})
    }, 2000)

    ctx.registerMany([
      { id: 'page', area: ROUTES_AREA, data: { path: ROUTE }, render: () => jsx(Page, {}) },
      { id: 'nav', area: SIDEBAR_NAV_AREA, data: { path: ROUTE, label: 'Needs You', codicon: 'bell' } },
      { id: 'chip', area: STATUSBAR_AREAS.left, order: 90, render: () => jsx(Chip, {}) }
    ])
  }
}
