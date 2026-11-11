import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import type { SessionCard } from '../types'
import { TEAM_MS, TRAVEL_MS, distinctNames, edges, elapsed, link, spark, teams, toolLabel, worksFor } from '../hooks/board'

// The engine beneath the plugin for a session start: its id, a store, HOME, and the writes it makes.
// `neighbour`: another session's presence note in the same directory, or none.
function world(on: On, askAnswer: string | null, neighbour?: { id: string; root: string }) {
  const writes: { path: string; text: string }[] = []
  const clock = mock.clock(on, { now: Date.now() }) // the module dates its notes by the wall clock
  mock.store(on)
  mock.env(on, { HOME: '/home/t' })
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.repo', () => ({ value: { root: '/w/proyecto-a', remote: null, internal: false, name: 'Proyecto A' } }))
  on('command.register', () => ({ value: { command: 'sesiones' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__sesiones__rol' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.write', (_, e) => {
    writes.push(e as { path: string; text: string })
    return { value: undefined }
  })
  on('fs.list', (_, e) => ({
    value:
      neighbour && (e as { path: string }).path.endsWith('/presence')
        ? [{ name: `${neighbour.id}.json`, kind: 'file', size: 10, mtimeMs: clock.now(), isLink: false }]
        : [],
  }))
  on('fs.read', () => ({
    value: neighbour ? JSON.stringify({ ...neighbour, startedAt: 1, updatedAt: clock.now() }) : '',
  }))
  on('ui.panes', () => ({ value: [] }))
  const asked: string[] = []
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    asked.push(JSON.stringify(e))
    return askAnswer === null ? { result: { isError: true, text: 'dismissed' } } : { result: { text: askAnswer } }
  })
  return { writes, clock, asked }
}

const NOW = 1_000_000

const PANE_MOUNT = {
  plugin: 'sesiones',
  component: 'Pane',
  requestId: 'sesiones',
  props: { title: 'Sesiones', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

// What an earlier dispatch stored in $.state, by key.
function seed(on: On, values: Record<string, unknown>) {
  on('state.get', (_, e) => {
    const key = (e as { key?: string }).key ?? ''
    return { value: key in values ? { value: values[key], version: 1 } : { value: undefined, version: 0 } }
  })
}

function card(over: Partial<SessionCard>): SessionCard {
  return {
    id: 'id', name: 'name', cwd: '/', status: 'idle', since: NOW, activity: '', activityAt: NOW,
    tools: 0, agents: [], sent: [], received: [], updatedAt: NOW, ...over,
  }
}

test('a message is paired with the session that received its text', async () => {
  const projA = card({ id: 'a1', name: 'Proyecto A', sent: [{ to: 'whatever-name', text: '¿Qué API usa el login?', at: NOW - 1000 }] })
  const projB = card({ id: 'b2', name: 'Proyecto B', received: [{ text: 'Another session says: ¿qué API usa el login?', at: NOW - 900 }] })
  const [edge] = edges([projA, projB], NOW)
  expect(edge?.to).toBe('b2')
  expect(edge?.toName).toBe('Proyecto B')
})

test('without the text, the address names the session', async () => {
  const projA = card({ id: 'a1', name: 'Proyecto A', sent: [{ to: 'proyecto b', text: 'hola', at: NOW }] })
  const projB = card({ id: 'b2', name: 'Proyecto B' })
  expect(edges([projA, projB], NOW)[0]?.to).toBe('b2')
})

test('an address nobody carries keeps its own name, and old messages leave the board', async () => {
  const projA = card({ id: 'a1', sent: [{ to: 'ghost', text: 'x', at: NOW }, { to: 'ghost', text: 'old', at: NOW - 200_000 }] })
  const list = edges([projA], NOW)
  expect(list.length).toBe(1)
  expect(list[0]?.to).toBe(null)
  expect(list[0]?.toName).toBe('ghost')
})

test('the dot travels while the message is fresh, then the link rests', async () => {
  const fresh = link(10, 0, 0)
  expect(fresh.isMoving).toBe(true)
  expect(fresh.line.includes('●')).toBe(true)
  expect(fresh.line.endsWith('▶')).toBe(true)
  expect(link(10, 0, 3).line === fresh.line).toBe(false) // it moves frame to frame
  const done = link(10, TRAVEL_MS, 0)
  expect(done.isMoving).toBe(false)
  expect(done.line).toBe('─────────▶')
})

test('three sessions in one repo get three names, oldest first, and keep them', async () => {
  const exec = card({ id: 'e', name: 'Proyecto A', startedAt: 1 })
  const rev1 = card({ id: 'r1', name: 'Proyecto A', startedAt: 2 })
  const rev2 = card({ id: 'r2', name: 'Proyecto A', startedAt: 3 })
  const named = card({ id: 'n', name: 'revisora', startedAt: 4 })
  const out = distinctNames([rev2, named, exec, rev1])
  expect(out.map(c => c.name).join('|')).toBe('Proyecto A #3|revisora|Proyecto A|Proyecto A #2')
})

test('an executor and two reviewers that message each other are one team; a lone session is none', async () => {
  const exec = card({ id: 'e', name: 'ejecutora', sent: [{ to: 'revisora 1', text: 'revisa el PR', at: NOW - 5000 }, { to: 'revisora 2', text: 'revisa tests', at: NOW - 4000 }] })
  const rev1 = card({ id: 'r1', name: 'revisora 1', sent: [{ to: 'ejecutora', text: 'falta un test', at: NOW - 1000 }] })
  const rev2 = card({ id: 'r2', name: 'revisora 2' })
  const lone = card({ id: 'x', name: 'Proyecto B' })
  const cards = [exec, rev1, rev2, lone]
  const groups = teams(cards, edges(cards, NOW, TEAM_MS))
  expect(groups.length).toBe(1)
  expect([...groups[0]!.ids].sort().join(',')).toBe('e,r1,r2')
  expect(groups[0]!.links.length).toBe(3)
  expect(groups[0]!.links[0]?.text).toBe('falta un test') // newest first
})

test('labels, times and the spark', async () => {
  expect(toolLabel('Read', { file_path: '/a/b/login.ts' })).toBe('Read login.ts')
  expect(toolLabel('Bash', { command: 'git status' })).toBe('Bash git status')
  expect(elapsed(4 * 60_000 + 12_000)).toBe('4m12s')
  expect(elapsed(35_000)).toBe('35s')
  expect(spark(0) === spark(1)).toBe(false)
})

test('the pane draws each live session and the message between them', async ($, on) => {
  const now = Date.now()
  const cards: SessionCard[] = [
    card({ id: 'a1', name: 'Proyecto A', status: 'working', since: now - 252_000, activity: 'Bash graphify query', tools: 23, updatedAt: now,
      agents: [{ id: 'g1', label: 'docs 1-15', status: 'done', tools: 9, activity: 'terminado' }, { id: 'g2', label: 'docs 16-30', status: 'running', tools: 4, activity: 'Read informe.pdf' }],
      sent: [{ to: 'proyecto b', text: '¿qué API?', at: now - 1000 }] }),
    card({ id: 'b2', name: 'Proyecto B', status: 'idle', updatedAt: now, since: now - 5_000, role: 'revisora', worksFor: 'Proyecto A' }),
    card({ id: 'c3', name: 'Cerrada', status: 'ended', updatedAt: now }),
  ]
  seed(on, { sessions: { shape: 'cards-2', value: cards } })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE_MOUNT, surface })
    expect((await ui.find({ type: 'Text', text: /2 en el tablero · 1 trabajando · 1 subagentes · 1 equipos · 1 mensajes ahora/ }))?.text).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /EQUIPO 1 +Proyecto A ⇄ Proyecto B/ }))?.text).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /TRABAJANDO +4m12s/ }))?.text).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /docs 16-30.*▸ Read informe\.pdf/ }))?.text).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /«¿qué API\?»/ }))?.text).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /REVISORA +para ⇄ Proyecto A/ }))?.text).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /para ⇄ Proyecto B \(por sus mensajes\)/ }))?.text).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Cerrada/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('the detail view follows one session: its calls, each subagent, its files', async ($, on) => {
  const now = Date.now()
  const projA = card({
    id: 'a1', name: 'ejecutora', status: 'working', since: now - 60_000, activity: 'Edit login.ts', tools: 5, updatedAt: now,
    agents: [{ id: 'g2', label: 'revisar tipos', kind: 'general-purpose', status: 'running', tools: 2, activity: 'Read types.ts', startedAt: now - 30_000 }],
    calls: [
      { id: 'c1', agent: null, label: 'Read login.ts', status: 'done', at: now - 20_000 },
      { id: 'c2', agent: null, label: 'Edit login.ts', status: 'running', at: now - 1_000 },
      { id: 'c3', agent: 'g2', label: 'Read types.ts', status: 'running', at: now - 2_000 },
    ],
    files: [{ path: 'src/login.ts', act: 'edit', reads: 1, edits: 2, at: now - 1_000 }],
  })
  seed(on, { sessions: { shape: 'cards-2', value: [projA] }, view: 'detail', focus: 'a1' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE_MOUNT, surface })
    expect((await ui.find({ type: 'Text', text: /Principal/ }))?.text).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /Read login\.ts/ }))?.text).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /revisar tipos general-purpose · 30s · 2 herramientas/ }))?.text).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /Read types\.ts/ }))?.text).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /src\/login\.ts +2 cambios 1 lecturas/ }))?.text).toBeDefined()
    await ui.unmount()
  }
})

test('the line above the prompt shows each running subagent, and nothing when none runs', async ($, on) => {
  const now = Date.now()
  const agents = [
    { id: 'g1', label: 'tests unitarios', kind: 'general-purpose', status: 'running', tools: 4, activity: 'Bash npm test', startedAt: now - 65_000 },
    { id: 'g2', label: 'ya terminado', status: 'done', tools: 1, activity: 'terminado' },
  ]
  seed(on, { agents })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text> // the engine's own band, which stays drawn
  })
  const BAND = { plugin: 'sesiones', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: true, maxRows: 6, bodyColumns: 100, scroll: { offset: 0, bodyRows: 6 }, view: {} } } as const
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /tests unitarios general-purpose · 1m05s · 4 herr\. +▸ Bash npm test/ }))?.text).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /ya terminado/ })).toBeUndefined()
  await ui.unmount()
})

test('a session publishes nothing until it joins, and leaves the board on salir', async ($, on) => {
  const { writes, clock } = world(on, null)
  await $.session.start({ cwd: '/w/proyecto-a', surface: 'terminal', isInteractive: false })
  await clock.advance(5000)
  expect(writes.length).toBe(0) // headless: no presence, no question, not on the board

  await $.command.run({ command: 'sesiones', args: 'unir revisora 1', origin: { kind: 'user' } } as never)
  const joined = JSON.parse(writes.at(-1)!.text) as SessionCard
  expect(writes.at(-1)!.path).toBe('/home/t/.cache/claude-sesiones/sess-1.json')
  expect(joined.name).toBe('revisora 1')
  expect(joined.status).toBe('idle')

  await $.command.run({ command: 'sesiones', args: 'salir', origin: { kind: 'user' } } as never)
  expect((JSON.parse(writes.at(-1)!.text) as SessionCard).status).toBe('ended')
  const count = writes.length
  await clock.advance(10_000)
  expect(writes.length).toBe(count) // no heartbeat once it left
})

const cardWrites = (writes: { path: string }[]) => writes.filter(w => !w.path.includes('/presence/'))

test('a session alone in its directory is never asked, and only leaves a presence note', async ($, on) => {
  const { writes, clock, asked } = world(on, null)
  await $.session.start({ cwd: '/w/proyecto-a', surface: 'terminal', isInteractive: true })
  await clock.advance(30_000)
  expect(asked.length).toBe(0)
  expect(cardWrites(writes).length).toBe(0)
  const note = JSON.parse(writes.find(w => w.path.endsWith('/presence/sess-1.json'))!.text)
  expect(Object.keys(note).sort().join(',')).toBe('id,root,startedAt,updatedAt') // nothing of its work
})

test('with another session in the same directory it asks once; a dismissed question keeps it off', async ($, on) => {
  const { writes, clock, asked } = world(on, null, { id: 'other', root: '/w/proyecto-a' })
  await $.session.start({ cwd: '/w/proyecto-a', surface: 'terminal', isInteractive: true })
  expect(asked.length).toBe(0) // never inside the session's start
  await clock.advance(5000)
  expect(asked.length).toBe(1)
  expect(asked[0]!.includes('otra sesión abierta en «proyecto-a»')).toBe(true)
  expect(asked[0]!.includes('Sí, conectarla con ellas')).toBe(true)
  await clock.advance(30_000)
  expect(asked.length).toBe(1) // not asked again
  expect(cardWrites(writes).length).toBe(0)
})

test('a session in another directory does not count', async ($, on) => {
  const { clock, asked } = world(on, null, { id: 'other', root: '/w/proyecto-b' })
  await $.session.start({ cwd: '/w/proyecto-a', surface: 'terminal', isInteractive: true })
  await clock.advance(10_000)
  expect(asked.length).toBe(0)
})

test('on joining, the model is told to name its role, and its tool call reaches the board', async ($, on) => {
  const { writes } = world(on, null)
  const session = mock.session(on)
  await $.session.start({ cwd: '/w/proyecto-a', surface: 'terminal', isInteractive: false })
  await $.command.run({ command: 'sesiones', args: 'unir revisora 1', origin: { kind: 'user' } } as never)
  const note = session.appended().find(r => JSON.stringify(r.message.content).includes('[Tablero de sesiones]'))
  expect(note?.message.type).toBe('user')
  expect(JSON.stringify(note?.message.content).includes('mcp__sesiones__rol')).toBe(true)

  const r = await $.tool.call({ tool: 'mcp__sesiones__rol', role: 'revisora de tests', worksFor: 'ejecutora' } as never)
  expect((r as { result?: unknown }).result).toBe('Tablero actualizado: rol «revisora de tests», trabaja para «ejecutora».')
  const published = JSON.parse(writes.filter(w => !w.path.includes('/presence/')).at(-1)!.text) as SessionCard
  expect(published.role).toBe('revisora de tests')
  expect(published.worksFor).toBe('ejecutora')
})

test('whom a session works for: set, else inferred from whom it messages most', async () => {
  const exec = card({ id: 'e', name: 'ejecutora' })
  const rev = card({ id: 'r', name: 'revisora', sent: [{ to: 'ejecutora', text: 'a', at: NOW }, { to: 'ejecutora', text: 'b', at: NOW }] })
  const set = card({ id: 's', name: 'otra', worksFor: 'Ana' })
  const links = edges([exec, rev, set], NOW, TEAM_MS)
  expect(JSON.stringify(worksFor(rev, links))).toBe('{"who":"ejecutora","isInferred":true}')
  expect(JSON.stringify(worksFor(set, links))).toBe('{"who":"Ana","isInferred":false}')
  expect(worksFor(exec, links)).toBe(null)
})

test('a session working for another one on the board is in its team; one working for a person is not', async () => {
  const exec = card({ id: 'e', name: 'ejecutora' })
  const rev = card({ id: 'r', name: 'revisora', worksFor: 'Ejecutora' })
  const solo = card({ id: 's', name: 'soporte', worksFor: 'Ana' })
  const groups = teams([exec, rev, solo], [])
  expect(groups.length).toBe(1)
  expect([...groups[0]!.ids].sort().join(',')).toBe('e,r')
})

test('connected sessions form a team before any message', async () => {
  const exec = card({ id: 'e', name: 'ejecutora', team: '/w/proyecto-a' })
  const rev = card({ id: 'r', name: 'revisora', team: '/w/proyecto-a' })
  const solo = card({ id: 's', name: 'solo', team: null })
  const groups = teams([exec, rev, solo], [])
  expect(groups.length).toBe(1)
  expect([...groups[0]!.ids].sort().join(',')).toBe('e,r')
})

test('the pane says when no session publishes yet, on every surface', async ($, on) => {
  on('ui.close', () => ({ value: undefined }))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'sesiones',
      surface,
      component: 'Pane',
      requestId: 'sesiones',
      props: { title: 'Sesiones', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
    })
    expect((await ui.find({ type: 'Text', text: /Aún no hay sesiones/ }))?.text).toBeDefined()
    await ui.unmount()
  }
})
