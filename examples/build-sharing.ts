import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { setTimeout } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import {
  createZooworkClient,
  ZooworkError,
  type InstalledAgentUpdateStatus,
  type UpdateInstalledAgentInput,
  type ZooworkClient,
} from '../src/index.js'

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Set ${name}`)
  return value
}

async function ask(prompt: string): Promise<string> {
  const input = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await input.question(prompt)
  } finally {
    input.close()
  }
}
async function submitConfirmation(
  confirm: () => Promise<InstalledAgentUpdateStatus>,
  signal: AbortSignal,
): Promise<InstalledAgentUpdateStatus> {
  let delay = 1000
  for (;;) {
    signal.throwIfAborted()
    try {
      return await confirm()
    } catch (error) {
      if (!(error instanceof ZooworkError && error.status === 503 && error.code === 'agent_environment.building')) {
        throw error
      }
    }
    await setTimeout(delay, undefined, { signal })
    delay = Math.min(delay * 2, 10_000)
  }
}

export async function trackUpdate(
  installer: Pick<ZooworkClient, 'getUpdateStatus'>,
  agentId: string,
  update: InstalledAgentUpdateStatus,
  signal: AbortSignal,
  confirm?: () => Promise<InstalledAgentUpdateStatus>,
): Promise<InstalledAgentUpdateStatus> {
  if (confirm) update = await submitConfirmation(confirm, signal)
  while (update.apply.state === 'in_progress') {
    console.log('Rebuild phase', update.apply.phase)
    await setTimeout(2000, undefined, { signal })
    update = await installer.getUpdateStatus(agentId)
  }
  return confirm && update.apply.state === 'pending' ? submitConfirmation(confirm, signal) : update
}

async function main(): Promise<void> {
  const agentId = required('ZOOWORK_AGENT_ID')
  const author = createZooworkClient({ apiKey: required('ZOOWORK_AUTHOR_KEY') })
  const installerKey = required('ZOOWORK_INSTALLER_KEY')
  const installer = createZooworkClient({ apiKey: installerKey })

  const original = await author.getBuild(agentId)
  const first = original.effective_revision_id
  if (first === null) throw new Error('Apply the first Revision before publishing it')
  await author.publishBuild(agentId, { revision_id: first, expected_shared_revision_id: original.shared_revision_id ?? null })

  // The token grants access to the Agent's prompt and Skill source. Keep it private.
  const link = await author.createShareLink(agentId, randomUUID())
  if (!link.token) throw new Error('The creation response must include an install token')
  const preview = await installer.previewInstall(link.token)
  const copy = await installer.installSharedAgent(link.token, preview.source_revision_id, randomUUID())

  await ask('Apply a new Revision in the author Project, then press Enter. ')
  const latest = (await author.getBuild(agentId)).effective_revision_id
  if (latest === null || latest === first) throw new Error('No newer Active Revision')
  await author.publishBuild(agentId, { revision_id: latest, expected_shared_revision_id: first })

  let cursor: string | undefined
  for (;;) {
    const page = await installer.listInstalledAgents({ update_available: true, cursor })
    if (page.installs.some((item) => item.agent_id === copy.agent_id)) break
    if (page.next_cursor === null) throw new Error('No update is available for the copy')
    cursor = page.next_cursor
  }
  const local = await installer.getBuild(copy.agent_id)
  const request = { target_source_revision_id: latest, expected_local_revision_id: local.working_revision_id }
  const update = await installer.updateInstalledAgent(copy.agent_id, request, randomUUID())
  let confirmed: { key: string; input: UpdateInstalledAgentInput } | undefined
  if (update.apply.blockers.some((blocker) => blocker.acknowledgeable)) {
    const answer = await ask("Rebuilding interrupts this copy's running tasks. Continue? [y/N] ")
    if (answer.trim().toLowerCase() !== 'y') return
    confirmed = {
      key: randomUUID(),
      input: { ...request, confirm_rebuild: true, expected_config_version: update.apply.config_version },
    }
  }
  const signal = AbortSignal.timeout(300_000)
  const bounded = createZooworkClient({
    apiKey: installerKey,
    fetch: (url, init) => fetch(url, { ...init, signal }),
  })
  const confirmation = confirmed
    ? () => bounded.updateInstalledAgent(copy.agent_id, confirmed.input, confirmed.key)
    : undefined
  console.log(await trackUpdate(bounded, copy.agent_id, update, signal, confirmation))
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
