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
  origin: 'created' | 'shared'
  shared_revision_id?: string | null
  source_revision_id?: string
  update_available?: boolean
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

export interface PublishBuildInput {
  revision_id: string
  expected_shared_revision_id: string | null
}

export interface PublishedBuild {
  shared_revision_id: string
}

export interface ShareLinkCreated {
  share_id: string
  created_at: string
  /** Returned on initial creation only. */
  token?: string
}

export interface ShareLink {
  share_id: string
  created_at: string
  revoked_at: string | null
}

export interface AgentInstallPreview {
  name: string
  description: string
  avatar_url: string | null
  quick_commands: BuildQuickCommand[]
  source_revision_id: string
  already_installed: boolean
  agent_id?: string
}

export interface InstalledAgent {
  agent_id: string
  source_revision_id: string
}

export interface InstalledAgentItem extends InstalledAgent {
  shared_revision_id: string | null
  update_available: boolean
}

export interface InstalledAgentPage {
  installs: InstalledAgentItem[]
  next_cursor: string | null
}

export interface InstalledAgentQuery {
  update_available?: boolean
  cursor?: string
  limit?: number
}

export interface UpdateInstalledAgentInput extends Pick<BuildApplyOptions, 'confirm_rebuild' | 'expected_config_version'> {
  target_source_revision_id: string
  expected_local_revision_id: string
}

export interface InstalledAgentUpdateStatus {
  state: 'updating' | 'succeeded' | 'needs_retry' | 'failed' | null
  source_revision_id: string
  active_revision_id: string | null
  apply: BuildApply
}
