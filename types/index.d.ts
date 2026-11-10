export type SessionStatus = 'working' | 'idle' | 'error' | 'ended'
export type RunStatus = 'running' | 'done' | 'failed'

export type AgentCard = {
  id: string
  label: string
  kind?: string // the subagent type: general-purpose, Explore, a plugin's agent
  status: RunStatus
  tools: number
  activity: string
  startedAt?: number
  endedAt?: number
}

// One tool call, for the detail view's tree: `agent` is the subagent's id, null for the main loop.
export type CallRow = { id: string; agent: string | null; label: string; status: RunStatus; at: number }

// A file the session read or changed, newest first.
export type FileRow = { path: string; act: 'read' | 'edit' | 'write'; reads: number; edits: number; at: number }

export type SentMessage = { to: string; text: string; at: number }
export type ReceivedMessage = { text: string; at: number }

// What one session publishes to the shared folder, one file per session.
export type SessionCard = {
  id: string
  name: string
  cwd: string
  status: SessionStatus
  startedAt?: number // when the session began: orders sessions that share a name
  since: number
  activity: string
  activityAt: number
  tools: number
  agents: AgentCard[]
  calls?: CallRow[]
  files?: FileRow[]
  sent: SentMessage[]
  received: ReceivedMessage[]
  updatedAt: number
  root?: string // the repo root (else the cwd): sessions sharing it are "in the same directory"
  team?: string | null // sessions connected by the person share this key and form a team
  role?: string // the session's role, as the person names it: "ejecutora", "revisora"
  worksFor?: string // whom it works for: another session's name, or a person or client
}

// What every interactive session writes, joined or not: just enough for a session to see that
// another one is open in the same directory, so it asks only then.
export type Presence = { id: string; root: string; startedAt: number; updatedAt: number }

export type View = 'board' | 'detail'

declare module 'claude-code' {
  interface PluginState {
    sesiones: {
      sessions: Shaped<SessionCard[]>
      selfId: string
      joined: boolean
      frame: number
      view: View
      focus: string // the session the detail view shows; '' for this one
      agents: AgentCard[] // this session's own subagents, for the line above the prompt
    }
  }
}
