// Sesiones: /sesiones opens an animated board of the Claude Code sessions on this machine that
// the person put on it: what each one does, its subagents, the files it touches and the messages
// the sessions send each other, grouped into teams. A detail view follows one session call by
// call, and a line above the prompt shows this session's running subagents.
// A session asks to join only when another one is open in its directory. Its card is published
// to a shared local folder; nothing leaves the machine and no model is called.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentCard, CallRow, Presence, SessionCard, View } from '../types'
import {
  CLAUDE_ORANGE,
  MAX_CALLS,
  TEAM_MS,
  TRAVEL_MS,
  bar,
  callTree,
  cut,
  distinctNames,
  edges,
  elapsed,
  isLive,
  link,
  neighbours,
  recordFile,
  shortPath,
  spark,
  teams,
  toolLabel,
  worksFor,
} from './board'

const PANE = 'sesiones'
// The tool each session's model calls to say its role and whom it works for.
const ROLE_TOOL = 'rol'
const ROLE_TOOL_FULL = 'mcp__sesiones__rol'
const TICK_MS = 250 // animation frame
const READ_EVERY = 4 // ticks between reads of the shared folder (1 s)
const NEIGHBOUR_EVERY = 8 // ticks between looks for another session in this directory (2 s)
const HEARTBEAT_MS = 3_000
const MAX_AGENTS = 8
const MAX_MESSAGES = 10
const BAND_AGENTS = 3 // running subagents shown above the prompt
const CONNECT = 'Sí, conectarla con ellas'
const CONNECT_OPEN = 'Sí, conectarla y abrir el tablero aquí'
const SHOW = 'Solo mostrarla, sin conectar'
const NO = 'No'
// Claude Code's own bookkeeping, not work a person follows.
const INTERNAL = new Set(['ToolSearch', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'SubagentHandback'])
const FILE_TOOLS: Record<string, 'read' | 'edit' | 'write'> = { Read: 'read', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', Write: 'write' }

const COLOR = {
  working: CLAUDE_ORANGE,
  idle: '#8B8B8B',
  error: '#E5484D',
  ended: '#5A5A5A',
  done: '#46A758',
  team: '#A78BFA',
  role: '#38BDF8',
  read: '#60A5FA',
  edit: '#FBBF24',
  ink: '#1A1A1A',
}
const STATUS_WORD = { working: 'TRABAJANDO', idle: 'EN ESPERA', error: 'ERROR', ended: 'CERRADA' }

const sessions = atom({ plugin: 'sesiones', key: 'sessions' } as const, [] as SessionCard[], { shape: 'cards-2' })
const selfIdAtom = atom({ plugin: 'sesiones', key: 'selfId' } as const, '')
const joinedAtom = atom({ plugin: 'sesiones', key: 'joined' } as const, false)
const frame = atom({ plugin: 'sesiones', key: 'frame' } as const, 0)
const viewAtom = atom({ plugin: 'sesiones', key: 'view' } as const, 'board' as View)
const focusAtom = atom({ plugin: 'sesiones', key: 'focus' } as const, '')
const agentsAtom = atom({ plugin: 'sesiones', key: 'agents' } as const, [] as AgentCard[])

// This session's own card; published on every change and on the heartbeat, once joined.
const self: SessionCard = {
  id: '',
  name: '',
  cwd: '',
  status: 'idle',
  startedAt: Date.now(),
  since: Date.now(),
  activity: 'esperando tu turno',
  activityAt: Date.now(),
  tools: 0,
  agents: [],
  calls: [],
  files: [],
  sent: [],
  received: [],
  updatedAt: 0,
  root: '',
  team: null,
}
const run = {
  dir: '',
  joined: false,
  isInteractive: false,
  isAnswered: false, // asked and answered (or set by a command): never asked again
  isAsking: false,
  isToldModel: false,
  dirty: true,
  agentsDirty: false,
  lastPublish: 0,
  lastPresence: 0,
  ticks: 0,
  isPlaced: false,
  isReading: false,
  isPublishing: false,
}

function touch(activity?: string) {
  if (activity !== undefined) {
    self.activity = activity
    self.activityAt = Date.now()
  }
  run.dirty = true
}

function touchAgents() {
  run.agentsDirty = true
  touch()
}

// ---------------------------------------------------------------- the shared folder

async function publish($: EngineInterface, force = false) {
  if (!run.dir || !self.id || run.isPublishing || (!run.joined && !force)) return
  run.isPublishing = true
  try {
    self.updatedAt = Date.now()
    await $.fs.write(`${run.dir}/${self.id}.json`, JSON.stringify(self))
    run.dirty = false
    run.lastPublish = self.updatedAt
  } finally {
    run.isPublishing = false
  }
}

async function readAll($: EngineInterface) {
  if (!run.dir || run.isReading) return
  run.isReading = true
  try {
    const now = Date.now()
    const entries = await $.fs.list(run.dir).catch(() => [])
    const cards: SessionCard[] = []
    for (const entry of entries) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.json') || now - entry.mtimeMs > 3_600_000) continue
      const text = await $.fs.read(`${run.dir}/${entry.name}`).catch(() => '')
      if (typeof text !== 'string' || !text) continue
      try {
        const card = JSON.parse(text) as SessionCard
        if (card && typeof card.id === 'string' && Array.isArray(card.agents)) cards.push(card)
      } catch {
        // a card half written by its session: read again on the next pass
      }
    }
    cards.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.id.localeCompare(b.id))
    await update($, sessions, () => cards)
  } finally {
    run.isReading = false
  }
}

// The presence note: id, directory and times, nothing of what the session does.
async function publishPresence($: EngineInterface) {
  if (!run.dir || !self.id || !run.isInteractive) return
  const note: Presence = { id: self.id, root: self.root || self.cwd, startedAt: self.startedAt ?? 0, updatedAt: Date.now() }
  await $.fs.write(`${run.dir}/presence/${self.id}.json`, JSON.stringify(note))
  run.lastPresence = note.updatedAt
}

async function readPresence($: EngineInterface): Promise<Presence[]> {
  const entries = await $.fs.list(`${run.dir}/presence`).catch(() => [])
  const out: Presence[] = []
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json') || Date.now() - entry.mtimeMs > 60_000) continue
    const text = await $.fs.read(`${run.dir}/presence/${entry.name}`).catch(() => '')
    try {
      const p = JSON.parse(typeof text === 'string' ? text : '') as Presence
      if (p && typeof p.id === 'string' && typeof p.root === 'string') out.push(p)
    } catch {
      // half written: next pass
    }
  }
  return out
}

// ---------------------------------------------------------------- joining and connecting

async function defaultName($: EngineInterface, cwd: string) {
  const repo = await $.session.repo().catch(() => null)
  return repo?.name || cwd.split('/').filter(Boolean).pop() || cwd
}

// Connects this session with the others of its directory (one team key), or disconnects it.
async function connect($: EngineInterface, isConnected: boolean) {
  self.team = isConnected ? self.root || self.cwd : null
  await $.store.set(`team:${self.id}`, self.team).catch(() => {})
  touch()
}

// Sets the role and whom the session works for, as the model or a command says; "" clears.
async function setRole($: EngineInterface, role?: string, boss?: string) {
  if (role !== undefined) {
    self.role = role.trim() ? cut(role.trim(), 24) : undefined
    await $.store.set(`role:${self.id}`, self.role ?? '').catch(() => {})
  }
  if (boss !== undefined) {
    self.worksFor = boss.trim() ? cut(boss.trim(), 30) : undefined
    await $.store.set(`for:${self.id}`, self.worksFor ?? '').catch(() => {})
  }
  touch()
  await publish($).catch(() => {}) // on the board at once, not on the next heartbeat
}

// Once a session is on the board, its model is told so in a row of its own (never a change to
// what it was already sent), so it names its role and whom it works for by itself.
async function tellModel($: EngineInterface) {
  if (run.isToldModel || (self.role && self.worksFor)) return
  run.isToldModel = true
  const text =
    `[Tablero de sesiones] Esta sesión aparece como «${self.name}» en el tablero de sesiones de Claude Code del usuario. ` +
    `En cuanto sepas tu papel en este trabajo (por lo que el usuario te pidió o por los mensajes de otras sesiones), llama a la herramienta ${ROLE_TOOL_FULL} ` +
    'con `role` (tu rol en pocas palabras, p. ej. «ejecutora», «revisora de tests») y `worksFor` (para quién trabajas: el nombre de otra sesión, ' +
    'p. ej. «ejecutora», o la persona o cliente). Vuelve a llamarla si tu papel cambia. No hace falta comentarlo al usuario.'
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } }).catch(() => {
    run.isToldModel = false
  })
}

// Puts this session on the board (or takes it off), and remembers the answer for a resume.
async function join($: EngineInterface, isJoined: boolean, name?: string) {
  run.isAnswered = true
  if (name) {
    self.name = cut(name, 30)
    await $.store.set(`name:${self.id}`, self.name).catch(() => {})
  }
  await $.store.set(`join:${self.id}`, isJoined).catch(() => {})
  if (run.joined && !isJoined) {
    self.status = 'ended'
    await publish($, true).catch(() => {}) // the board drops it at once
  }
  run.joined = isJoined
  await update($, joinedAtom, () => isJoined)
  if (isJoined) {
    if (self.status === 'ended') self.status = 'idle'
    touch()
    await publish($).catch(() => {})
    await tellModel($)
  }
}

async function openBoard($: EngineInterface, view?: View) {
  if (view) await update($, viewAtom, () => view)
  await $.ui.open({ id: PANE, title: 'Sesiones', focus: true })
  run.isPlaced = true
  await readAll($).catch(() => {})
}

// Asked once, and only when another session is open in this same directory.
async function askToJoin($: EngineInterface, others: number) {
  const place = (self.root || self.cwd).split('/').filter(Boolean).pop() ?? self.cwd
  const more = others === 1 ? 'otra sesión abierta' : `${others} sesiones más abiertas`
  const answer = await $.ui
    .ask(`Hay ${more} en «${place}». ¿Quieres verla en el tablero de sesiones y conectarla con ellas? (en «Otro» escribe su nombre, p. ej. «revisora 1», y se conecta)`, {
      header: 'Sesiones',
      options: [CONNECT, CONNECT_OPEN, SHOW, NO],
    })
    .catch(() => NO) // dismissed: it stays off the board; /sesiones unir puts it on
  if (answer === NO) return join($, false)
  const isNamed = ![CONNECT, CONNECT_OPEN, SHOW].includes(answer)
  await connect($, answer !== SHOW)
  await join($, true, isNamed ? answer : undefined)
  if (answer === CONNECT_OPEN) await openBoard($)
}

// ---------------------------------------------------------------- the hooks

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    const home = (await $.env.get('HOME')) ?? ''
    run.dir = home ? `${home}/.cache/claude-sesiones` : ''
    self.id = await $.session.id()
    self.cwd = e.cwd
    self.root = (await $.session.repo().catch(() => null))?.root || e.cwd
    run.isInteractive = e.isInteractive
    const custom = await $.store.get(`name:${self.id}`).catch(() => undefined)
    self.name = typeof custom === 'string' && custom ? custom : await defaultName($, e.cwd)
    const team = await $.store.get(`team:${self.id}`).catch(() => undefined)
    self.team = typeof team === 'string' ? team : null
    const role = await $.store.get(`role:${self.id}`).catch(() => undefined)
    self.role = typeof role === 'string' && role ? role : undefined
    const boss = await $.store.get(`for:${self.id}`).catch(() => undefined)
    self.worksFor = typeof boss === 'string' && boss ? boss : undefined
    await update($, selfIdAtom, () => self.id)
    await $.command.register({
      name: 'sesiones',
      description: 'Tablero animado de tus sesiones de trabajo de Claude Code, sus subagentes y sus mensajes',
      argumentHint: '[detalle | unir [nombre] | salir | conectar | desconectar | nombre <x> | rol <x> | para <x>]',
    }).catch(() => {})
    await $.tool.register({
      name: ROLE_TOOL,
      description:
        'Tablero de sesiones: declara el rol de esta sesión y para quién trabaja, para que el usuario lo vea en su tablero. ' +
        'Úsala cuando esta sesión esté en el tablero y sepas tu papel (p. ej. role «revisora», worksFor «ejecutora»). Una cadena vacía borra el valor.',
      inputSchema: {
        type: 'object',
        properties: {
          role: { type: 'string', description: 'Tu rol en pocas palabras: «ejecutora», «revisora de tests», «investigación»…' },
          worksFor: { type: 'string', description: 'Para quién trabajas: el nombre de otra sesión del tablero, o la persona o cliente' },
        },
      },
      isDeferred: false,
    }).catch(() => {})

    // A resumed session keeps its answer; a new one is asked once another session opens in
    // its directory (the timer below looks), a headless run never.
    const known = await $.store.get(`join:${self.id}`).catch(() => undefined)
    if (typeof known === 'boolean') await join($, known)

    $.clock.every(TICK_MS, () => {
      void (async () => {
        run.ticks++
        if (run.isInteractive && Date.now() - run.lastPresence > HEARTBEAT_MS) await publishPresence($)
        if (run.isInteractive && !run.isAnswered && !run.isAsking && run.ticks % NEIGHBOUR_EVERY === 0) {
          const others = neighbours(await readPresence($), { id: self.id, root: self.root || self.cwd }, Date.now())
          if (others.length > 0) {
            run.isAsking = true
            void askToJoin($, others.length)
              .catch(() => {})
              .finally(() => {
                run.isAsking = false
                run.isAnswered = true // a dismissed question is not asked again either
              })
          }
        }
        if (run.joined && run.dirty && Date.now() - run.lastPublish > 500) await publish($)
        if (run.joined && Date.now() - run.lastPublish > HEARTBEAT_MS) await publish($)
        if (run.agentsDirty) {
          run.agentsDirty = false
          await update($, agentsAtom, () => self.agents.map(a => ({ ...a })))
        }
        if (run.ticks % READ_EVERY === 0) {
          run.isPlaced = (await $.ui.panes()).some(p => p.id === PANE && p.isPlaced)
          if (run.isPlaced) await readAll($)
        }
        // The frame moves the sparks: while the board is open or a subagent runs above the prompt.
        if (run.isPlaced || self.agents.some(a => a.status === 'running')) await update($, frame, n => n + 1)
      })().catch(() => {})
    })
    return r
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      self.status = 'working'
      self.since = Date.now()
      self.tools = 0
      self.calls = (self.calls ?? []).filter(c => c.status === 'running' && c.agent !== null)
      self.agents = self.agents.filter(a => a.status === 'running')
      touchAgents()
      touch(e.text ? `pensando: ${cut(e.text, 40)}` : 'pensando…')
    }
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (r.agentId) {
      const agent: AgentCard = {
        id: r.agentId,
        label: cut(e.description || e.subagentType, 40),
        kind: e.subagentType,
        status: 'running',
        tools: 0,
        activity: 'arrancando',
        startedAt: Date.now(),
      }
      self.agents = [...self.agents, agent].slice(-MAX_AGENTS)
      touchAgents()
    }
    return r
  }).catch(($, e, next) => next(e)) // the board never stands in a spawn's way

  // The model's own call to say its role: answered here, nothing beneath runs.
  on('tool.call', { tool: ROLE_TOOL_FULL }, async ($, e) => {
    const args = e as unknown as Record<string, unknown>
    const role = typeof args.role === 'string' ? args.role : undefined
    const boss = typeof args.worksFor === 'string' ? args.worksFor : undefined
    await setRole($, role, boss)
    const said = [self.role && `rol «${self.role}»`, self.worksFor && `trabaja para «${self.worksFor}»`].filter(Boolean).join(', ')
    // An MCP-style tool's output is text (or content blocks), never a record: core sets `text` itself.
    return {
      result: run.joined ? `Tablero actualizado: ${said || 'sin rol'}.` : `Guardado (${said || 'sin rol'}); esta sesión aún no está en el tablero.`,
    }
  })

  on('tool.call', async ($, e, next) => {
    if (e.tool === 'Agent' || INTERNAL.has(String(e.tool)) || String(e.tool) === ROLE_TOOL_FULL) return next(e)
    const args = e as unknown as Record<string, unknown>
    const label = toolLabel(String(e.tool), args)
    const agent = e.agentId ? self.agents.find(a => a.id === e.agentId) : undefined
    if (agent) {
      agent.tools++
      agent.activity = label
      touchAgents()
    } else {
      self.tools++
      touch(label)
    }
    const row: CallRow = { id: e.tool_use_id, agent: agent ? agent.id : null, label, status: 'running', at: Date.now() }
    self.calls = [...(self.calls ?? []), row].slice(-MAX_CALLS)

    let failed = true
    try {
      const r = await next(e)
      failed = r.deny !== undefined || r.isError === true
      return r
    } finally {
      self.calls = (self.calls ?? []).map(c => (c.id === row.id ? { ...c, status: failed ? 'failed' : 'done' } : c))
      const act = FILE_TOOLS[String(e.tool)]
      const path = typeof args.file_path === 'string' ? args.file_path : ''
      if (act && path && !failed) self.files = recordFile(self.files ?? [], shortPath(path, self.root || self.cwd), act, Date.now())
      touch()
    }
  }).catch(($, e, next) => next(e)) // nor a tool call's

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    const failed = e.reason === 'error'
    if (e.agentId) {
      const agent = self.agents.find(a => a.id === e.agentId)
      if (agent) {
        agent.status = failed ? 'failed' : 'done'
        agent.activity = failed ? 'falló' : 'terminado'
        agent.endedAt = Date.now()
        touchAgents()
      }
    } else {
      self.status = failed ? 'error' : 'idle'
      self.since = Date.now()
      self.calls = (self.calls ?? []).map(c => (c.status === 'running' && c.agent === null ? { ...c, status: 'done' } : c))
      touch(failed ? 'terminó con un error' : 'esperando tu turno')
    }
    return r
  })

  on('session.send', async ($, e, next) => {
    const r = await next(e)
    self.sent = [...self.sent, { to: e.to, text: cut(e.text, 200), at: Date.now() }].slice(-MAX_MESSAGES)
    touch(`mensaje → ${cut(e.to, 30)}`)
    return r
  }).catch(($, e, next) => next(e)) // nor a message's

  on('session.receive', async ($, e, next) => {
    const kind = e.origin.kind
    if (kind === 'peer' || kind === 'peer-send-message' || kind === 'coordinator') {
      self.received = [...self.received, { text: cut(e.text, 300), at: Date.now() }].slice(-MAX_MESSAGES)
      touch()
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    if (run.joined) {
      self.status = 'ended'
      await publish($, true).catch(() => {})
    }
    if (e.reason === 'clear') {
      // The process goes on under a new id: it keeps its place on the board, as a fresh card.
      const wasJoined = run.joined
      self.id = await $.session.id().catch(() => '')
      self.status = 'idle'
      self.tools = 0
      self.agents = []
      self.calls = []
      self.files = []
      touchAgents()
      touch('esperando tu turno')
      await update($, selfIdAtom, () => self.id)
      if (wasJoined) await join($, true, self.name)
    }
    return next(e)
  })

  on('command.run', { command: 'sesiones' }, async ($, e) => {
    const arg = e.args.trim()
    const named = /^nombre\s+(.+)$/i.exec(arg)
    if (named) {
      self.name = cut(named[1]!, 30)
      await $.store.set(`name:${self.id}`, self.name)
      touch()
      return { text: `Esta sesión se llama ahora «${self.name}» en el tablero.` }
    }
    // `rol <x>` and `para <x>`; a lone "-" clears either.
    // A correction by hand, should the model have named it wrong.
    const roleArg = /^rol\s+(.+)$/i.exec(arg)
    if (roleArg) {
      const value = roleArg[1]!.trim()
      await setRole($, value === '-' ? '' : value)
      return { text: self.role ? `Rol de «${self.name}»: ${self.role}.` : `«${self.name}» ya no tiene rol.` }
    }
    const forArg = /^para\s+(.+)$/i.exec(arg)
    if (forArg) {
      const value = forArg[1]!.trim()
      await setRole($, undefined, value === '-' ? '' : value)
      return {
        text: self.worksFor
          ? `«${self.name}» trabaja para ${self.worksFor}. Si es una sesión del tablero, quedan en el mismo equipo.`
          : `«${self.name}» ya no indica para quién trabaja (el tablero lo deducirá de sus mensajes).`,
      }
    }
    const joining = /^unir(?:\s+(.+))?$/i.exec(arg)
    if (joining) {
      await join($, true, joining[1])
      return { text: `«${self.name}» está ahora en el tablero de sesiones.` }
    }
    if (/^salir$/i.test(arg)) {
      await join($, false)
      return { text: 'Esta sesión ya no aparece en el tablero. /sesiones unir la vuelve a poner.' }
    }
    if (/^conectar$/i.test(arg)) {
      await connect($, true)
      if (!run.joined) await join($, true)
      return { text: `«${self.name}» está conectada con las sesiones de este directorio que también lo estén.` }
    }
    if (/^desconectar$/i.test(arg)) {
      await connect($, false)
      return { text: `«${self.name}» ya no está conectada; sigue en el tablero.` }
    }
    if (/^detalle$/i.test(arg)) {
      await update($, focusAtom, () => '')
      await openBoard($, 'detail')
      return { text: 'Detalle de esta sesión. t: tablero · 1-9: otra sesión · q: cerrar.' }
    }
    await openBoard($, 'board')
    const live = (await read($, sessions)).filter(c => isLive(c, Date.now())).length
    return { text: `Tablero de sesiones: ${live} en el tablero. d: detalle · 1-9: elegir sesión · q: cerrar.` }
  })

  // ---------------------------------------------------------------- the pane

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const f = await read($, frame)
    const selfId = await read($, selfIdAtom)
    const isJoined = await read($, joinedAtom)
    const view = await read($, viewAtom)
    const focus = await read($, focusAtom)
    const now = Date.now()
    const all = distinctNames((await read($, sessions)).filter(c => isLive(c, now)))
    const byId = new Map(all.map(c => [c.id, c]))
    const links = edges(all, now, TEAM_MS)
    const groups = teams(all, links)
    const inTeam = new Set(groups.flatMap(g => g.ids))
    const alone = all.filter(c => !inTeam.has(c.id))
    const fresh = edges(all, now).length
    const working = all.filter(c => c.status === 'working').length
    const agentsRunning = all.reduce((n, c) => n + c.agents.filter(a => a.status === 'running').length, 0)
    const columns = Math.max(30, e.props.bodyColumns)
    const rows = Math.max(10, (e.props.scroll?.bodyRows ?? 30) - 4)

    const statusColor = (c: SessionCard) => COLOR[c.status] ?? COLOR.idle
    const icon = (c: SessionCard) => (c.status === 'working' ? spark(f) : c.status === 'error' ? '✗' : '✻')
    const runIcon = (s: 'running' | 'done' | 'failed', offset = 0) => (s === 'running' ? spark(f + offset) : s === 'failed' ? '✗' : '✓')
    const runColor = (s: 'running' | 'done' | 'failed') => (s === 'running' ? CLAUDE_ORANGE : s === 'failed' ? COLOR.error : COLOR.done)

    const badge = (c: SessionCard) => (
      <Text backgroundColor={statusColor(c)} color={COLOR.ink} bold>{` ${STATUS_WORD[c.status]} `}</Text>
    )

    // "REVISORA  para ejecutora": the role as a chip, and whom it works for (inferred: dim note).
    const roleLine = (c: SessionCard, inner: number) => {
      const boss = worksFor(c, links)
      if (!c.role && !boss) return null
      const isSession = boss ? all.some(o => o.id !== c.id && o.name.toLowerCase() === boss.who.toLowerCase()) : false
      return (
        <Text wrap="truncate-end">
          {c.role && <Text backgroundColor={COLOR.role} color={COLOR.ink} bold>{` ${cut(c.role, Math.max(6, inner - 20)).toUpperCase()} `}</Text>}
          {boss && <Text dimColor>{c.role ? '  para ' : 'para '}</Text>}
          {boss && <Text bold color={isSession ? COLOR.team : undefined}>{`${isSession ? '⇄ ' : ''}${cut(boss.who, 24)}`}</Text>}
          {boss?.isInferred && <Text dimColor>{' (por sus mensajes)'}</Text>}
        </Text>
      )
    }

    const agentLine = (a: AgentCard, i: number, isLast: boolean, inner: number) => {
      const label = cut(a.label, Math.max(8, Math.floor(inner * 0.4)))
      const meta = `${a.startedAt ? `${elapsed((a.endedAt ?? now) - a.startedAt)} · ` : ''}${a.tools}`
      const room = Math.max(8, inner - label.length - meta.length - 9) // what the line has left
      return (
        <Text wrap="truncate-end">
          <Text dimColor>{isLast ? '└ ' : '├ '}</Text>
          <Text color={runColor(a.status)}>{runIcon(a.status, i * 3)}</Text>
          <Text bold={a.status === 'running'}>{` ${label}`}</Text>
          <Text dimColor>{` ${meta}`}</Text>
          {a.status === 'running' && <Text color={COLOR.idle}>{`  ▸ ${cut(a.activity, room)}`}</Text>}
        </Text>
      )
    }

    const card = (c: SessionCard, width: number) => {
      const inner = Math.max(12, width - 4)
      const isWorking = c.status === 'working'
      const agents = [...c.agents].sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running')).slice(0, 4)
      const edited = (c.files ?? []).filter(x => x.edits > 0).length
      const readOnly = (c.files ?? []).filter(x => x.edits === 0).length
      return (
        <Box key={`card-${c.id}`} flexDirection="column" width={width} borderStyle="round" borderColor={statusColor(c)} paddingX={1}>
          <Text wrap="truncate-end">
            <Text color={statusColor(c)} bold>{`${icon(c)} `}</Text>
            <Text bold>{cut(c.name, inner - 22)}</Text>
            {c.id === selfId && <Text dimColor>{' (esta)'}</Text>}
            <Text>{'  '}</Text>
            {badge(c)}
            <Text dimColor>{` ${elapsed(now - c.since)}`}</Text>
          </Text>
          {roleLine(c, inner)}
          {c.activity !== '' && (
            <Text wrap="truncate-end">
              <Text dimColor>{isWorking ? '▸ ' : 'último: '}</Text>
              <Text>{cut(c.activity, inner - 8)}</Text>
            </Text>
          )}
          {isWorking && (
            <Text wrap="truncate-end">
              <Text color={statusColor(c)}>{bar(c.tools)}</Text>
              <Text dimColor>{` ${c.tools} herramientas`}</Text>
            </Text>
          )}
          {(edited > 0 || readOnly > 0) && (
            <Text wrap="truncate-end">
              {edited > 0 && <Text color={COLOR.edit}>{`✎ ${edited} editados  `}</Text>}
              {readOnly > 0 && <Text color={COLOR.read}>{`◉ ${readOnly} leídos`}</Text>}
            </Text>
          )}
          {agents.length > 0 && <Text dimColor>{`subagentes · ${c.agents.filter(a => a.status === 'running').length} en marcha`}</Text>}
          {agents.map((a, i) => agentLine(a, i, i === agents.length - 1, inner))}
        </Box>
      )
    }

    // Cards in rows that fit `width`: two side by side when there is room, else one.
    const grid = (list: SessionCard[], width: number, key: string) => {
      const perRow = width >= 90 ? 2 : 1
      const cardWidth = Math.floor((width - (perRow - 1)) / perRow) - 1
      const lines: SessionCard[][] = []
      for (let i = 0; i < list.length; i += perRow) lines.push(list.slice(i, i + perRow))
      return lines.map((row, i) => (
        <Box key={`${key}-row-${i}`} flexDirection="row" gap={1}>
          {row.map(c => card(c, cardWidth))}
        </Box>
      ))
    }

    const nameRoom = Math.min(16, Math.max(6, Math.floor(columns / 6)))
    const linkRoom = Math.min(16, Math.max(6, Math.floor(columns / 6)))
    const textRoom = Math.max(8, columns - nameRoom * 2 - linkRoom - 16)
    const messageLine = (l: (typeof links)[number], i: number) => {
      const age = now - l.at
      const { line, isMoving } = link(linkRoom, age, f + i * 2)
      return (
        <Text wrap="truncate-end">
          <Text bold>{cut(l.fromName, nameRoom).padEnd(nameRoom)}</Text>
          <Text color={isMoving ? CLAUDE_ORANGE : COLOR.idle}>{` ${line} `}</Text>
          <Text bold={l.to !== null}>{cut(l.toName, nameRoom).padEnd(nameRoom)}</Text>
          <Text dimColor>{` «${cut(l.text, textRoom)}»`}</Text>
          <Text dimColor>{isMoving ? '' : ` ✓ hace ${elapsed(age)}`}</Text>
        </Text>
      )
    }

    const header = (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text wrap="truncate-end">
            <Text color={CLAUDE_ORANGE} bold>{`${working ? spark(f) : '✻'} Sesiones`}</Text>
            <Text dimColor>{`  ${all.length} en el tablero · `}</Text>
            <Text color={working ? CLAUDE_ORANGE : undefined} dimColor={!working}>{`${working} trabajando`}</Text>
            <Text dimColor>{` · ${agentsRunning} subagentes · ${groups.length} equipos · ${fresh} mensajes ahora`}</Text>
          </Text>
          <Box flexDirection="row" gap={1}>
            <Button key="tab-board" label="Tablero" hotkey="t" variant={view === 'board' ? 'primary' : undefined} onPress={() => update($, viewAtom, () => 'board')} />
            <Button key="tab-detail" label="Detalle" hotkey="d" variant={view === 'detail' ? 'primary' : undefined} onPress={() => update($, viewAtom, () => 'detail')} />
            <Button key="close" label="Cerrar" hotkey="q" role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
          </Box>
        </Box>
        {all.length > 0 && (
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Text dimColor>ver:</Text>
            {all.slice(0, 9).map((c, i) => (
              <Button
                key={`pick-${c.id}`}
                plain
                hotkey={String(i + 1)}
                label={cut(c.name, 18)}
                onPress={async () => {
                  await update($, focusAtom, () => c.id)
                  await update($, viewAtom, () => 'detail')
                }}
              />
            ))}
          </Box>
        )}
        {!isJoined && <Text dimColor>Esta sesión no está en el tablero · /sesiones unir [nombre] para añadirla</Text>}
      </Box>
    )

    const legend = (
      <Box marginTop={1}>
        <Text dimColor wrap="truncate-end">
          <Text color={CLAUDE_ORANGE}>{spark(f)}</Text>
          {' trabajando  '}
          <Text color={COLOR.idle}>✻</Text>
          {' en espera  '}
          <Text color={COLOR.error}>✗</Text>
          {' error  '}
          <Text color={COLOR.team}>⇄</Text>
          {' equipo  '}
          <Text color={COLOR.edit}>✎</Text>
          {' editado  '}
          <Text color={COLOR.read}>◉</Text>
          {` leído · el punto viaja ${TRAVEL_MS / 1000}s`}
        </Text>
      </Box>
    )

    // ---- detail: one session, call by call
    if (view === 'detail') {
      const c = byId.get(focus || selfId) ?? byId.get(selfId) ?? all[0]
      if (!c) {
        return (
          <Box flexDirection="column">
            {header}
            <Text dimColor>Ninguna sesión en el tablero todavía.</Text>
          </Box>
        )
      }
      const inner = Math.max(20, columns - 4)
      const tree = callTree(c.calls ?? [], c.agents)
      const callRoom = Math.max(6, Math.floor((rows - 10) / 2))
      const callLine = (k: CallRow, depth: number, i: number) => (
        <Text wrap="truncate-end">
          <Text dimColor>{depth ? '   │ ' : ' │ '}</Text>
          <Text color={runColor(k.status)}>{runIcon(k.status, i)}</Text>
          <Text dimColor={k.status === 'done'}>{` ${cut(k.label, inner - 14)}`}</Text>
          <Text dimColor>{` ${elapsed(now - k.at)}`}</Text>
        </Text>
      )
      const mine = links.filter(l => l.from === c.id || l.to === c.id).slice(0, 4)
      return (
        <Box flexDirection="column">
          {header}
          <Box flexDirection="column" borderStyle="round" borderColor={statusColor(c)} paddingX={1} marginTop={1}>
            <Text wrap="truncate-end">
              <Text color={statusColor(c)} bold>{`${icon(c)} `}</Text>
              <Text bold>{c.name}</Text>
              {c.id === selfId && <Text dimColor>{' (esta)'}</Text>}
              <Text>{'  '}</Text>
              {badge(c)}
              <Text dimColor>{` ${elapsed(now - c.since)} · ${c.tools} herramientas · ${c.cwd.split('/').filter(Boolean).slice(-2).join('/')}`}</Text>
            </Text>
            {roleLine(c, inner)}
            <Text wrap="truncate-end">
              <Text dimColor>▸ </Text>
              <Text>{cut(c.activity, inner - 4)}</Text>
            </Text>

            <Box marginTop={1}><Text bold color={COLOR.idle}>Principal</Text></Box>
            {tree.main.length === 0 && <Text dimColor> │ sin herramientas en este turno</Text>}
            {tree.main.slice(-callRoom).map((k, i) => callLine(k, 0, i))}

            {c.agents.length > 0 && <Box marginTop={1}><Text bold color={COLOR.idle}>Subagentes</Text></Box>}
            {c.agents.map((a, i) => (
              <Box key={`agent-${a.id}`} flexDirection="column">
                <Text wrap="truncate-end">
                  <Text color={runColor(a.status)} bold>{` ${runIcon(a.status, i * 3)} `}</Text>
                  <Text bold>{cut(a.label, inner - 34)}</Text>
                  <Text dimColor>{` ${a.kind ?? ''} · ${elapsed((a.endedAt ?? now) - (a.startedAt ?? now))} · ${a.tools} herramientas`}</Text>
                </Text>
                {(tree.byAgent.get(a.id) ?? []).slice(a.status === 'running' ? -4 : -1).map((k, j) => callLine(k, 1, j))}
              </Box>
            ))}

            {(c.files ?? []).length > 0 && <Box marginTop={1}><Text bold color={COLOR.idle}>Archivos</Text></Box>}
            {(c.files ?? []).slice(0, 8).map(x => (
              <Text wrap="truncate-end">
                <Text color={x.edits > 0 ? COLOR.edit : COLOR.read}>{x.edits > 0 ? ' ✎ ' : ' ◉ '}</Text>
                <Text bold={now - x.at < 5_000}>{cut(x.path, inner - 24)}</Text>
                <Text dimColor>{`  ${x.edits ? `${x.edits} cambios ` : ''}${x.reads ? `${x.reads} lecturas ` : ''}· hace ${elapsed(now - x.at)}`}</Text>
              </Text>
            ))}

            {mine.length > 0 && <Box marginTop={1}><Text bold color={COLOR.idle}>Mensajes</Text></Box>}
            {mine.map(messageLine)}
          </Box>
          {legend}
        </Box>
      )
    }

    // ---- board: every session, teams first
    return (
      <Box flexDirection="column">
        {header}
        {all.length === 0 && <Text dimColor>Aún no hay sesiones en el tablero. Al abrir otra sesión en el mismo directorio, cada una pregunta si quieres verla y conectarla.</Text>}

        {groups.map((g, gi) => {
          const members = g.ids.map(id => byId.get(id)).filter((m): m is SessionCard => m !== undefined)
          return (
            <Box key={`team-${gi}`} flexDirection="column" borderStyle="round" borderColor={COLOR.team} paddingX={1} marginTop={1}>
              <Text wrap="truncate-end">
                <Text backgroundColor={COLOR.team} color={COLOR.ink} bold>{` ⇄ EQUIPO ${gi + 1} `}</Text>
                <Text bold>{`  ${members.map(m => m.name).join(' ⇄ ')}`}</Text>
                <Text dimColor>{g.links.length ? ` · ${g.links.length} mensajes` : ' · conectadas, sin mensajes aún'}</Text>
              </Text>
              {grid(members, columns - 4, `team-${gi}`)}
              {g.links.slice(0, 4).map(messageLine)}
            </Box>
          )
        })}

        {alone.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            {groups.length > 0 && <Text dimColor bold>Sin conexión</Text>}
            {grid(alone, columns, 'alone')}
          </Box>
        )}
        {legend}
      </Box>
    )
  })

  // ---------------------------------------------------------------- above the prompt

  // One line per running subagent of this session, and a word on the board while it is closed.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e) // what other mods and Claude Code draw here stays
    if (e.props.hasSurvey) return rest
    const agents = (await read($, agentsAtom)).filter(a => a.status === 'running')
    if (agents.length === 0) return rest
    const f = await read($, frame)
    const { Box, Text } = $.ui.resolve(e)
    const now = Date.now()
    const width = Math.max(30, e.props.bodyColumns)
    const shown = agents.slice(-BAND_AGENTS)
    return (
      <Box flexDirection="column">
        {rest}
        {shown.map((a, i) => (
          <Text wrap="truncate-end">
            <Text color={CLAUDE_ORANGE} bold>{` ${spark(f + i * 3)} `}</Text>
            <Text bold>{cut(a.label, Math.floor(width / 3))}</Text>
            <Text dimColor>{` ${a.kind ?? ''} · ${elapsed(now - (a.startedAt ?? now))} · ${a.tools} herr.`}</Text>
            <Text color={COLOR.idle}>{`  ▸ ${cut(a.activity, Math.floor(width / 3))}`}</Text>
          </Text>
        ))}
        {agents.length > BAND_AGENTS && <Text dimColor>{`   +${agents.length - BAND_AGENTS} subagentes más · /sesiones detalle`}</Text>}
      </Box>
    )
  })
}
