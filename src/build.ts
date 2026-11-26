/** Build create fields; the SDK adds the wire discriminator. */
export interface BuildAgentInput {
  name?: string | null
  intent?: string
  model?: string | null
}

export interface BuildAgentCreated {
  agent_id: string
  config_version: number
  mode: 'build'
  build_session_id: string
  working_revision_id: string
}

export interface BuildSession {
  session_id: string
  working_revision_id: string
}

export type BuildApplyState = 'applied' | 'pending' | 'blocked' | 'in_progress'
export type BuildRunApplyState = BuildApplyState | 'superseded'
export type BuildRebuildPhase = 'stopping' | 'switching' | 'preparing' | 'restoring' | 'ready' | 'failed'

export interface BuildApplyOptions {
  confirm_rebuild?: boolean
  expected_revision_id?: string
  expected_config_version?: number
}

export interface BuildBlocker {
  code: string
  acknowledgeable: boolean
}

export interface BuildApply {
  state: BuildApplyState
  config_version: number
  phase: BuildRebuildPhase | null
  blockers: BuildBlocker[]
}

export interface BuildRunApply extends Omit<BuildApply, 'state'> {
  state: BuildRunApplyState
}

export interface BuildQuickCommand {
  name: string
  prompt: string
}

export interface BuildSummary {
  name: string
  description: string
  avatar_url: string | null
  quick_commands: BuildQuickCommand[]
  working_revision_id: string
  effective_revision_id: string | null
  apply: BuildApply
}

interface BuildRunBase {
  run_id: string
  working_revision_id: string
  effective_revision_id: string | null
}

export interface BuildCommittedRun extends BuildRunBase {
  change: 'committed'
  revision_id: string
  apply: BuildRunApply
}

export interface BuildUncommittedRun extends BuildRunBase {
  change: 'none' | 'draft' | 'conflict'
}

export type BuildRun = BuildCommittedRun | BuildUncommittedRun

export interface AgentRevisionSummary {
  revision_id: string
  parent_revision_id: string | null
  commit_message: string
  created_at: string
  validation_passed: boolean
}

export interface AgentRevisionList {
  revisions: AgentRevisionSummary[]
}

export interface AgentRevisionDiff {
  revision_id: string
  parent_revision_id: string | null
  unified_diff: string
}
