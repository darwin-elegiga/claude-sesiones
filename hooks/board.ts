import type { CallRow, FileRow, Presence, SessionCard } from '../types'

export const MAX_FILES = 12
export const MAX_CALLS = 30

// A path as the person reads it: inside the session's root, from there; else its last two parts.
export function shortPath(path: string, root: string) {
  const r = root.endsWith('/') ? root : `${root}/`
  if (root && path.startsWith(r)) return path.slice(r.length)
  return path.split('/').filter(Boolean).slice(-2).join('/')
}

// Notes a read or a change of `path`, newest first, at most MAX_FILES kept.
export function recordFile(files: FileRow[], path: string, act: FileRow['act'], at: number): FileRow[] {
  const old = files.find(f => f.path === path)
  const isChange = act !== 'read'
  const row: FileRow = {
    path,
    act: isChange ? act : (old?.act ?? 'read'), // a file once changed stays shown as changed
    reads: (old?.reads ?? 0) + (isChange ? 0 : 1),
    edits: (old?.edits ?? 0) + (isChange ? 1 : 0),
    at,
  }
  return [row, ...files.filter(f => f.path !== path)].slice(0, MAX_FILES)
}

// Tool calls grouped under who made them: the main loop first, then each subagent in order.
export function callTree(calls: CallRow[], agents: { id: string }[]) {
  const main = calls.filter(c => c.agent === null || !agents.some(a => a.id === c.agent))
  return { main, byAgent: new Map(agents.map(a => [a.id, calls.filter(c => c.agent === a.id)])) }
}

// The other sessions open right now in the same directory as `self`.
export function neighbours(list: Presence[], self: { id: string; root: string }, now: number): Presence[] {
  return list.filter(p => p.id !== self.id && p.root === self.root && now - p.updatedAt < 20_000)
}

// Claude's spark, the glyph cycle the terminal spinner uses.
export const SPARK = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢']
export const CLAUDE_ORANGE = '#D97757'

export const STALE_MS = 20_000 // a session that stopped publishing this long ago is gone
export const EDGE_MS = 90_000 // a message stays on the board this long
export const TRAVEL_MS = 6_000 // the dot travels this long, then the link shows delivered

export type Edge = {
  from: string // session id
  fromName: string
  to: string | null // session id, null when no live session matches
  toName: string
  text: string
  at: number
}

export function spark(frame: number) {
  return SPARK[frame % SPARK.length]!
}

export function isLive(card: SessionCard, now: number) {
  return card.status !== 'ended' && now - card.updatedAt < STALE_MS
}

// "4m12s", "35s", "1h03m"
export function elapsed(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

export function cut(text: string, max: number) {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : `${t.slice(0, Math.max(1, max - 1))}…`
}

const norm = (t: string) => t.replace(/\s+/g, ' ').trim().toLowerCase()

// Pairs each sent message with the session that received it: by the text first (the receiver
// records what reached it), then by the address matching a session's name or id.
export function edges(cards: SessionCard[], now: number, windowMs = EDGE_MS): Edge[] {
  const out: Edge[] = []
  for (const from of cards) {
    for (const m of from.sent) {
      if (now - m.at > windowMs) continue
      const probe = norm(m.text).slice(0, 80)
      const byText = probe
        ? cards.find(c => c.id !== from.id && c.received.some(r => Math.abs(r.at - m.at) < EDGE_MS && norm(r.text).includes(probe)))
        : undefined
      const addr = norm(m.to)
      const byName = byText ?? cards.find(c => c.id !== from.id && (norm(c.name) === addr || c.id.startsWith(addr) || addr.includes(norm(c.name))))
      out.push({ from: from.id, fromName: from.name, to: byName?.id ?? null, toName: byName?.name ?? m.to, text: m.text, at: m.at })
    }
  }
  return out.sort((a, b) => b.at - a.at)
}

export const TEAM_MS = 2 * 60 * 60_000 // sessions that talked within this window form a team

export type Team = { ids: string[]; links: Edge[] }

// Sessions joined by any message between them, or connected by the person (one `team` key),
// each group with its messages, newest first; groups of one are left out.
export function teams(cards: SessionCard[], links: Edge[]): Team[] {
  const parent = new Map(cards.map(c => [c.id, c.id]))
  const root = (id: string): string => {
    let r = id
    while (parent.get(r) !== r) r = parent.get(r)!
    return r
  }
  const join = (a: string, b: string) => {
    const ra = root(a)
    const rb = root(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  for (const l of links) if (l.to && parent.has(l.from) && parent.has(l.to)) join(l.from, l.to)
  const byTeam = new Map<string, string>()
  for (const c of cards) {
    if (!c.team) continue
    const first = byTeam.get(c.team)
    if (first) join(c.id, first)
    else byTeam.set(c.team, c.id)
  }
  // A session that works for another one on the board belongs with it.
  for (const c of cards) {
    const boss = boardSession(cards, c.worksFor, c.id)
    if (boss) join(c.id, boss.id)
  }
  const groups = new Map<string, string[]>()
  for (const c of cards) groups.set(root(c.id), [...(groups.get(root(c.id)) ?? []), c.id])
  return [...groups.values()]
    .filter(ids => ids.length > 1)
    .map(ids => ({ ids, links: links.filter(l => ids.includes(l.from)) }))
    .sort((a, b) => (b.links[0]?.at ?? 0) - (a.links[0]?.at ?? 0))
}

// The session on the board a "works for" names, by its name, ignoring case; none for a person.
export function boardSession(cards: SessionCard[], name: string | undefined, selfId: string) {
  const want = norm(name ?? '')
  return want ? cards.find(c => c.id !== selfId && norm(c.name) === want) : undefined
}

// Whom a session works for: what the person set, else whom it messages most (inferred).
export function worksFor(card: SessionCard, links: Edge[]): { who: string; isInferred: boolean } | null {
  if (card.worksFor) return { who: card.worksFor, isInferred: false }
  const counts = new Map<string, number>()
  for (const l of links) if (l.from === card.id && l.to) counts.set(l.toName, (counts.get(l.toName) ?? 0) + 1)
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
  return top ? { who: top[0], isInferred: true } : null
}

// Several sessions in one folder share a name: number the later ones, oldest first, so each
// card and each link says which one it is.
export function distinctNames(cards: SessionCard[]): SessionCard[] {
  const byAge = [...cards].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.id.localeCompare(b.id))
  const seen = new Map<string, number>()
  const names = new Map<string, string>()
  for (const c of byAge) {
    const n = (seen.get(c.name) ?? 0) + 1
    seen.set(c.name, n)
    names.set(c.id, n === 1 ? c.name : `${c.name} #${n}`)
  }
  return cards.map(c => ({ ...c, name: names.get(c.id) ?? c.name }))
}

// The link as one line of cells: a dot travelling along it while the message is fresh.
export function link(width: number, age: number, frame: number) {
  const w = Math.max(4, width)
  if (age >= TRAVEL_MS) return { line: `${'─'.repeat(w - 1)}▶`, isMoving: false }
  const pos = Math.floor(((frame % 8) / 8 + age / TRAVEL_MS) * (w - 1)) % (w - 1)
  const cells = Array.from({ length: w - 1 }, (_, i) => (i === pos ? '●' : i === (pos + w - 2) % (w - 1) ? '•' : '─'))
  return { line: `${cells.join('')}▶`, isMoving: true }
}

// A bar of ten for the tool calls of a turn, filling as it grows (it never claims a total).
export function bar(tools: number) {
  const filled = Math.min(10, Math.ceil(Math.log2(tools + 1) * 2))
  return `${'▰'.repeat(filled)}${'▱'.repeat(10 - filled)}`
}

// One short label for a tool call, from its arguments.
export function toolLabel(tool: string, args: Record<string, unknown>) {
  const str = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : '')
  const base = (p: string) => p.split('/').filter(Boolean).pop() ?? p
  const detail =
    str('file_path') ? base(str('file_path'))
    : str('command') ? str('command')
    : str('pattern') ? str('pattern')
    : str('url') ? str('url')
    : str('query') ? str('query')
    : str('description') ? str('description')
    : str('to') ? `→ ${str('to')}`
    : ''
  return cut(detail ? `${tool} ${detail}` : tool, 60)
}
