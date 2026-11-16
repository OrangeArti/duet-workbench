export type Form = {
  type: string
  model: string
  effort: string
  /** auto = write when the task asks for a change, read-only otherwise (the runtime decides). */
  access: 'auto' | 'read' | 'write'
  background: boolean
  shape: boolean
  resume: boolean
  /** The previewed prompt as the human edited it; null = no preview open. */
  prompt: string | null
}

export type Job = {
  id: string
  status: string
  title: string
  model: string | null
  effort: string | null
  write: boolean
  elapsed: string
  last: string
  threadId: string | null
  /** Tokens the run has spent so far; null until Codex reports usage. */
  tokens: number | null
  isTask: boolean
  isPending: boolean
}

export type Model = { id: string; efforts: string[] }

/** What is left of one Codex quota window (the 5-hour session, the week). */
export type Limit = { label: string; leftPercent: number; resetsAt: string | null }

export type Data = {
  codex: string
  auth: string
  mirror: string
  offer: boolean
  models: Model[]
  limits: Limit[]
  jobs: Job[]
}

export type Out = {
  title: string
  text: string
  /** Runtime arguments a Confirm press runs (init, remove); null = nothing to confirm. */
  confirm: string[] | null
}

declare module 'claude-code' {
  interface PluginState {
    duet: { form: Shaped<Form>; data: Shaped<Data>; out: Shaped<Out> }
  }
}
