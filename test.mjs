// Node harness: mocks @hermes/plugin-sdk + react, then exercises the pure logic of plugin.js.
// Run: node test.mjs   (from this folder, native Windows path)
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
let src = fs.readFileSync(path.join(here, 'plugin.js'), 'utf8')

src = src
  .replace(/import \{[\s\S]*?\} from '@hermes\/plugin-sdk'/, 'const { host, haptic, atom, useValue, useQuery, Button, Input, Codicon, EmptyState, ROUTES_AREA, SIDEBAR_NAV_AREA, STATUSBAR_AREAS } = globalThis.__sdk')
  .replace("import * as SDK from '@hermes/plugin-sdk'", 'const SDK = globalThis.__sdk')
  .replace("import { useEffect, useState } from 'react'", 'const useState = globalThis.__useState, useEffect = () => {}')
  .replace("import { jsx, jsxs } from 'react/jsx-runtime'", 'const jsx = () => null, jsxs = () => null')

const mkAtom = init => {
  let v = init
  const ls = new Set()
  return { get: () => v, set: n => { v = n; ls.forEach(f => f(v)) }, listen: f => { ls.add(f); return () => ls.delete(f) } }
}
globalThis.__sdk = {
  host: { request: async () => ({}), navigate() {}, notify() {}, state: { focusedSessionId: { get: () => 'x' } } },
  haptic() {}, atom: mkAtom, useValue: a => a.get(), useQuery: () => ({}),
  Button: 1, Input: 1, Codicon: 1, EmptyState: 1, ROUTES_AREA: 'routes', SIDEBAR_NAV_AREA: 'nav', STATUSBAR_AREAS: { left: 'sl', right: 'sr' }
}
globalThis.__useState = v => [v, () => {}]

const tmp = path.join(os.tmpdir(), `needs-you-hub-test-${process.pid}.mjs`)
fs.writeFileSync(tmp, src)
const mod = await import(pathToFileURL(tmp).href)
const T = mod.__test

// --- itemFromEvent: single clarify
const single = T.itemFromEvent('clarify.request', {
  session_id: 'local-a', profile: 'default',
  payload: { prompt_id: 'p1', question: 'Which one?', choices: ['A (Recommended)', 'B'], multi_select: false }
}, 1000)
assert.equal(single.kind, 'clarify')
assert.equal(single.questions.length, 1)
assert.equal(single.questions[0].qid, 'p1')
assert.deepEqual(single.questions[0].choices, ['A (Recommended)', 'B'])

// --- batch + multiselect
const batch = T.itemFromEvent('clarify.request', {
  session_id: 'local-b',
  payload: { prompt_id: 'p2', questions: [
    { qid: 'q1', question: 'Pick', choices: ['x', 'y'], multi_select: true },
    { qid: 'q2', question: 'Free text?' },
    { qid: 'q3', question: '   ' }
  ] }
})
assert.equal(batch.profile, 'default')
assert.equal(batch.questions.length, 2)
assert.equal(batch.questions[0].multiSelect, true)
assert.equal(batch.questions[1].choices.length, 0)

// --- approval
const appr = T.itemFromEvent('approval.request', { session_id: 's', payload: { prompt_id: 'p3', command: 'rm -rf x', description: 'dangerous', choices: ['once', 'deny'] } })
assert.equal(appr.kind, 'approval'); assert.equal(appr.command, 'rm -rf x')

// --- rejects malformed
assert.equal(T.itemFromEvent('clarify.request', { session_id: '', payload: { prompt_id: 'p' } }), null)
assert.equal(T.itemFromEvent('clarify.request', { session_id: 's', payload: { question: 'no id' } }), null)
assert.equal(T.itemFromEvent('clarify.request', { session_id: 's', payload: { prompt_id: 'p', question: '' } }), null)
assert.equal(T.itemFromEvent('other', { session_id: 's', payload: { prompt_id: 'p' } }), null)

// --- answerFor / allAnswered
assert.equal(T.answerFor(single.questions[0], { sel: { p1: 'A (Recommended)' }, other: {} }), 'A')
assert.equal(T.answerFor(single.questions[0], { sel: { p1: 'A' }, other: { p1: ' custom ' } }), 'custom')
assert.equal(T.answerFor(batch.questions[0], { sel: { q1: ['x', 'y'] }, other: { q1: 'z' } }), JSON.stringify(['x', 'y', 'z']))
assert.equal(T.answerFor(batch.questions[0], { sel: {}, other: {} }), '')
assert.equal(T.allAnswered(batch, { sel: { q1: ['x'] }, other: {} }), false)
assert.equal(T.allAnswered(batch, { sel: { q1: ['x'] }, other: { q2: 'hi' } }), true)

// --- sendClarify: calls lock once per question, in order, with the right shape
const calls = []
await T.sendClarify(batch, { sel: { q1: ['x'] }, other: { q2: 'hi' } }, async (m, p) => { calls.push([m, p]); return { status: 'ok' } })
assert.deepEqual(calls.map(c => c[0]), ['clarify.lock', 'clarify.lock'])
assert.deepEqual(calls[0][1], { session_id: 'local-b', profile: 'default', request_id: 'p2', question_id: 'q1', answer: '["x"]' })
assert.equal(calls[1][1].answer, 'hi')

// --- sendClarify: expired surfaces as error
await assert.rejects(() => T.sendClarify(single, { sel: { p1: 'B' }, other: {} }, async () => ({ status: 'expired' })), /expired/)

// --- sendClarify: fallback to clarify.respond only for single question + unknown method
const fb = []
await T.sendClarify(single, { sel: { p1: 'B' }, other: {} }, async (m, p) => { fb.push(m); if (m === 'clarify.lock') throw new Error('unknown method: clarify.lock'); return {} })
assert.deepEqual(fb, ['clarify.lock', 'clarify.respond'])
await assert.rejects(() => T.sendClarify(batch, { sel: { q1: ['x'] }, other: { q2: 'hi' } }, async () => { throw new Error('unknown method: clarify.lock') }), /unknown method/)

// --- sendApproval
let ap
await T.sendApproval(appr, 'once', async (m, p) => { ap = [m, p] })
assert.deepEqual(ap, ['approval.respond', { session_id: 's', profile: 'default', request_id: 'p3', choice: 'once' }])

// --- stale / orphan reconciliation
const pend = { p1: { ...single, at: 0 }, p2: { ...batch, at: 0 }, fresh: { ...single, promptId: 'fresh', at: 100000 } }
const rows = [
  { id: 'local-a', session_key: 'local-a', status: 'idle' },
  { id: 'local-b', session_key: 'local-b', status: 'waiting' },
  { id: 'local-c', session_key: 'local-c', status: 'waiting' }
]
assert.deepEqual(T.staleIds(pend, rows, 100001), ['p1'])            // p1 session idle -> stale; p2 still waiting; fresh in grace window
assert.deepEqual(T.orphanWaiting(pend, rows).map(r => r.id), ['local-c'])
assert.deepEqual(T.staleIds({ p9: { ...single, promptId: 'p9', sessionId: 'unknown', at: 0 } }, rows, 999999), [])  // unknown session is kept


// --- session.resume snapshot recovery
const snap = {
  session_id: 'local-rt1',
  open_requests: [
    { id: 'c1', method: 'clarify', params: { session_id: 'local-rt1', questions: [{ qid: 'c1', question: 'Deploy now?', choices: ['yes', 'no'] }] } },
    { id: 'a1', method: 'approval', params: { session_id: 'local-rt1', request_id: 'a1', command: 'git push', description: 'push', choices: ['once', 'deny'] } },
    { id: 'z', method: 'other', params: {} }
  ],
  pending_approval: { prompt_id: 'a1', command: 'git push', description: 'push', choices: ['once', 'deny'] }
}
const rec = T.itemsFromSnapshot(snap, { id: 'row-1' }, 'default', 5)
assert.deepEqual(rec.map(r => [r.kind, r.promptId, r.sessionId]), [['clarify', 'c1', 'local-rt1'], ['approval', 'a1', 'local-rt1']])  // approval de-duplicated
assert.deepEqual(T.itemsFromSnapshot({}, { id: 'r' }), [])
assert.deepEqual(T.itemsFromSnapshot(null, { id: 'r' }), [])
// rowId drives stale detection when runtime id differs from the list id
const withRow = { c1: { ...rec[0], rowId: 'row-1', at: 0 } }
assert.deepEqual(T.staleIds(withRow, [{ id: 'row-1', session_key: 'row-1', status: 'idle' }], 99999), ['c1'])
assert.deepEqual(T.orphanWaiting(withRow, [{ id: 'row-1', session_key: 'row-1', status: 'waiting' }]), [])
// recoverOrphan end-to-end with a mocked rpc
let resumeCall
const n = await T.recoverOrphan({ id: 'row-9', title: 'x' }, async (m, p) => { resumeCall = [m, p]; return snap })
assert.equal(n, 2)
assert.equal(resumeCall[0], 'session.resume')
assert.equal(resumeCall[1].session_id, 'row-9'); assert.equal(resumeCall[1].omit_messages, true)


// --- orphan: last assistant text + free-text reply
assert.equal(T.lastAssistantText({ messages: [{ role: 'assistant', content: 'old' }, { role: 'user', content: 'q' }, { role: 'assistant', content: [{ text: 'Which one?' }] }] }), 'Which one?')
assert.equal(T.lastAssistantText({}), '')
const lo = await T.loadOrphan({ id: 'row-7' }, async () => ({ session_id: 'rt7', messages: [{ role: 'assistant', content: 'Pick A or B' }] }))
assert.deepEqual([lo.n, lo.text, lo.sessionId], [0, 'Pick A or B', 'rt7'])
let sc
await T.sendText('rt7', '  A  ', async (m, p) => { sc = [m, p] })
assert.deepEqual(sc, ['prompt.submit', { session_id: 'rt7', text: 'A' }])


// --- unread inbox
const R = (id, la, o = {}) => ({ id, session_key: id, status: 'idle', source: 'cli', message_count: 3, last_active: la, ...o })
const now0 = Math.floor(Date.now() / 1000)
const rowsI = [R('a', now0 - 100), R('b', now0 - 50), R('c', now0 - 10, { status: 'working' }), R('d', now0 - 10, { source: 'cron' }), R('e', now0 - 90000), R('f', now0 - 20, { message_count: 0 }), R('g', now0 - 30)]
assert.deepEqual(T.inboxRows(rowsI, {}, null, now0).map(r => r.id), ['g', 'b', 'a', 'e'])  // old sessions are listed too (no date cutoff)
assert.deepEqual(T.inboxRows(rowsI, { b: now0 - 50, a: now0 - 200 }, null, now0).map(r => r.id), ['g', 'a', 'e'])  // b read; a had new activity since
assert.deepEqual(T.inboxRows(rowsI, {}, 'g', now0).map(r => r.id), ['g', 'b', 'a', 'e'])  // focused session still listed
T.markRead([R('a', now0 - 100)])
assert.deepEqual(T.$dismissed.get().a, { t: now0 - 100, n: 3 })
const paras = T.lastParagraphs({ messages: [{ role: 'assistant', text: 'p1\n\np2\n\np3\n\np4' }, { role: 'assistant', text: '' }] }, 3)
assert.equal(paras, 'p2\n\np3\n\np4')
assert.equal(T.lastParagraphs({ messages: [{ role: 'user', text: 'hi' }] }), '')
let exCalls = 0
const rr = R('z', 5)
const t1 = await T.loadExcerpt(rr, async () => { exCalls++; return { messages: [{ role: 'assistant', text: 'x\n\ny' }] } })
const t2 = await T.loadExcerpt(rr, async () => { exCalls++; return {} })
assert.equal(t1, 'x\n\ny'); assert.equal(t2, t1); assert.equal(exCalls, 1)  // cached per revision

// --- helpers
assert.equal(T.ago(1000, 1000 * 1000 + 5000), '5s ago')
assert.equal(T.ago(1000, 1000 * 1000 + 125000), '2m ago')
assert.equal(T.titleOf({ id: 'local-abcdef123456', title: '' }), 'Session abcdef12')
assert.equal(T.titleOf({ id: 'x', title: ' Hi ' }), 'Hi')
assert.equal(T.stripRec('Do it (Recommended)'), 'Do it')

// --- register() wires events + areas without throwing
const reg = []; const evs = {}
const ctx = {
  storage: { get: async () => null, set: async () => {} }, onDispose() {}, setInterval() { return () => {} },
  onEvent: (t, f) => { evs[t] = f; return () => {} },
  registerMany: cs => reg.push(...cs)
}
mod.default.register(ctx)
assert.deepEqual(reg.map(r => r.id), ['page', 'nav', 'chip'])
evs['clarify.request']({ type: 'clarify.request', session_id: 'local-z', payload: { prompt_id: 'pz', question: 'Q?', choices: ['a'] } })
assert.ok(globalThis.__sdk.atom && true)
evs['*']({ type: 'clarify.settled', payload: { prompt_id: 'pz' } })

fs.unlinkSync(tmp)
console.log('ALL PASS')

console.log('INBOX PASS')

{
  const nw = Math.floor(Date.now() / 1000)
  const mk = o => ({ id: 'q', session_key: 'q', status: 'idle', source: 'local', message_count: 2, last_active: nw - 10, ...o })
  assert.equal(T.doneReason(mk({}), {}, null), '')
  assert.match(T.doneReason(mk({ status: 'working' }), {}, null), /working/)
  assert.equal(T.doneReason(mk({}), { q: nw }, null), 'marked read')
  assert.equal(T.doneReason(mk({ message_count: 5 }), { q: { t: nw, n: 2 } }, null), '')  // new messages reopen
  assert.equal(T.doneReason(mk({ message_count: 2 }), { q: { t: nw, n: 2 } }, null), 'marked read')
  assert.equal(T.doneReason(mk({}), {}, 'q'), '')  // focused sessions still count
  assert.equal(T.doneReason(mk({ last_active: 0, started_at: nw - 5 }), {}, null), '')  // no activity stamp: use started_at
  console.log('REASON PASS')
}

{
  const a = [{ id: 'x', status: 'working' }, { id: 'y', status: 'idle' }, { id: 'w', status: 'waiting' }]
  const b = [{ id: 'x', status: 'idle' }, { id: 'y', status: 'idle' }, { id: 'w', status: 'idle' }, { id: 'n', status: 'idle' }]
  assert.deepEqual(T.justFinished(a, b), ['x', 'w'])
  console.log('FINISH PASS')
}

{
  const calls = []
  const rpc = async (m, p) => { calls.push([m, p]); return m === 'session.resume' ? { info: { execution_generation: 7, running: false, pending: [{ admission_id: 'q1', status: 'queued' }, { admission_id: 'u1', status: 'unknown', execution_generation: 5 }] } } : { ok: true } }
  const msg = await T.stopSession({ id: 'z' }, rpc)
  assert.deepEqual(calls.map(c => c[0]), ['session.resume', 'prompt.cancel', 'prompt.resolve_unknown'])
  assert.equal(calls[2][1].execution_generation, 5)
  assert.match(msg, /cancelled 1 queued.*cleared 1 lost/)
  await assert.rejects(T.stopSession({ id: 'z' }, async () => ({})), /nothing to stop/)
  console.log('STOP PASS')
}

{
  assert.equal(T.pollDelay(true, false), 4000)
  assert.equal(T.pollDelay(false, false), 10000)
  assert.equal(T.pollDelay(true, true), 30000)
  const a = [{ id: 'a', status: 'idle', last_active: 1, message_count: 2, title: 't' }]
  assert.equal(T.rowsSig(a), T.rowsSig(a.map(r => ({ ...r }))))
  assert.notEqual(T.rowsSig(a), T.rowsSig([{ ...a[0], message_count: 3 }]))
  // excerpt cache is keyed by message_count, not last_active
  T.excerptCache.clear()
  let n = 0
  const rpc = async () => { n++; return { messages: [{ role: 'assistant', text: 'hi' }] } }
  await T.loadExcerpt({ id: 'e', message_count: 4, last_active: 1 }, rpc)
  await T.loadExcerpt({ id: 'e', message_count: 4, last_active: 99 }, rpc)
  assert.equal(n, 1)
  await T.loadExcerpt({ id: 'e', message_count: 5, last_active: 99 }, rpc)
  assert.equal(n, 2)
  console.log('PERF PASS')
}

{
  const f = [], a = []
  T.syncSidebarRead([{ id: 'local-1', session_key: 'k1', profile: 'default' }, { id: 'local-2', profile: 'p2' }], { forget: (ids, pr) => f.push([ids, pr]), api: async o => { a.push(o) } })
  await new Promise(r => setTimeout(r, 10))
  assert.deepEqual(f, [[['local-1', 'k1'], 'default'], [['local-2'], 'p2']])
  assert.equal(a.length, 2)
  assert.equal(a[0].path, '/api/sessions/k1')
  assert.equal(a[0].method, 'PATCH')
  assert.equal(a[0].body.unread, false)
  assert.equal(a[1].path, '/api/sessions/local-2')
  console.log('SIDEBAR PASS')
}

{
  const row = { id: 'a', session_key: 'ka', status: 'idle', last_active: 100, message_count: 3 }
  const st = { getItem: () => JSON.stringify({ default: ['ka'], p2: ['zz'] }) }
  assert.deepEqual([...T.readAppUnread(st)].sort(), ['ka', 'zz'])
  assert.equal(T.reconcileAppUnread(null, new Set(), [row], {}), null)
  // dot cleared in app -> read here
  const n1 = T.reconcileAppUnread(new Set(['ka']), new Set(), [row], {})
  assert.deepEqual(n1.a, { t: 100, n: 3 })
  // dot lit again -> read mark dropped
  const n2 = T.reconcileAppUnread(new Set(), new Set(['ka']), [row], { a: { t: 100, n: 3 } })
  assert.equal(n2.a, undefined)
  assert.equal(T.reconcileAppUnread(new Set(['ka']), new Set(['ka']), [row], {}), null)
  console.log('APPSYNC PASS')
}

{
  const times = new Map([['a', 5], ['b', 50], ['c', 20]])
  assert.deepEqual(T.sortPinnedIds(['a', 'x', 'b', 'c', 'y'], times), ['b', 'c', 'a', 'x', 'y'])
  let got
  const msg = await T.sortPinned({ storage: { getItem: () => JSON.stringify(['a', 'b', 'c']) }, list: async () => ({ sessions: [{ id: 'a', last_active: 1 }, { id: 'b', last_active: 9 }, { id: 'c', started_at: 4 }] }), reorder: ids => { got = ids } })
  assert.deepEqual(got, ['b', 'c', 'a'])
  assert.match(msg, /sorted 3 pinned/)
  await assert.rejects(T.sortPinned({ storage: { getItem: () => '["a"]' }, list: async () => [], reorder: () => {} }), /fewer than 2/)
  console.log('PINSORT PASS')
}
