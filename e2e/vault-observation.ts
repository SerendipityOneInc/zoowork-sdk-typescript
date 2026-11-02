// The Engine fixture's public observation protocol; no Engine implementation imports.
import { check } from './guard.ts'

export interface FixtureAccount { id: string; marker: string; fingerprint: string }
export interface FixtureObservation {
  runId: string | null
  accounts: Record<string, { complete: boolean; requests: {
    method: string; tool?: string; outcome: string; credentialHeaders: Record<string, string>
  }[] }>
  drafts: Record<string, { title: string; body: string }[]>
  droppedForBudget: number
  pendingErrors: number
}
export function assertObservation(value: FixtureObservation, runId: string, accounts: FixtureAccount[]): void {
  check(value.runId === runId && value.droppedForBudget === 0 && value.pendingErrors === 0, 'fixture_not_exclusive_or_incomplete')
  for (const account of accounts) {
    check(value.accounts[account.id]?.complete === true && Array.isArray(value.accounts[account.id]?.requests)
      && Array.isArray(value.drafts[account.id]), 'fixture_account_evidence_missing')
  }
}
export function assertIdentity(before: FixtureObservation, after: FixtureObservation,
  own: FixtureAccount, other: FixtureAccount, title: string): void {
  const previous = before.accounts[own.id]!.requests
  const current = after.accounts[own.id]!.requests
  check(JSON.stringify(current.slice(0, previous.length)) === JSON.stringify(previous), 'fixture_observations_replaced')
  check(JSON.stringify(after.accounts[other.id]) === JSON.stringify(before.accounts[other.id]), 'other_account_was_called')
  const calls = current.slice(previous.length).filter(row => row.method === 'tools/call')
  check(calls.some(row => row.tool === 'whoami' && row.outcome === 'ok'), 'whoami_not_observed')
  check(calls.some(row => row.tool === 'create_draft' && row.outcome === 'ok'), 'draft_call_not_observed')
  check(calls.every(row => row.credentialHeaders.authorization === `Bearer ${own.fingerprint}`), 'wrong_upstream_credential')
  const drafts = after.drafts[own.id]!.filter(draft => draft.title === title)
  check(drafts.length === 1 && drafts[0]!.body.includes(own.marker)
    && !drafts[0]!.body.includes(other.marker), 'wrong_or_duplicate_private_draft')
  check(!after.drafts[other.id]!.some(draft => draft.title === title), 'draft_written_to_other_user')
}
