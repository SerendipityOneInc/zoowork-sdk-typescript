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

export interface BuildBlocker {
  code: string
}

export interface BuildApply {
  state: BuildApplyState
  blockers: BuildBlocker[]
}

export interface BuildRunApply {
  state: BuildRunApplyState
  blockers: BuildBlocker[]
}

export interface BuildQuickCommand {
  id: string
  label: string
  label_cn: string
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

export interface AgentRevisionSkillBinding {
  name: string
  skill_id: string
  version: number
  source_owned: boolean
}

export interface AgentRevisionValidationIssue {
  level: 'error' | 'warning'
  code: string
  message: string
  path: string | null
}

export interface AgentRevisionValidation {
  passed: boolean
  issues: AgentRevisionValidationIssue[]
  checked_at: string
}

export interface AgentRevisionSummary {
  revision_id: string
  definition_id: string
  parent_revision_id: string | null
  source_digest: string
  projection_key: string
  seed_engine_config_version: number
  engine_rendered_digest: string | null
  baseline_fingerprint: string | null
  skill_bindings: AgentRevisionSkillBinding[]
  environment_id: string | null
  environment_version: number | null
  validation_summary: AgentRevisionValidation
  created_by: string
  created_at: string
  commit_message: string
  shared_published_at: string | null
  source_definition_id: string | null
  source_revision_id: string | null
}

export interface AgentRevisionList {
  revisions: AgentRevisionSummary[]
}

export interface AgentRevisionDiff {
  revision_id: string
  parent_revision_id: string | null
  unified_diff: string
}
