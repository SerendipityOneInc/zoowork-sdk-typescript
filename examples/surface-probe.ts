/**
 * Surface probe — exercises the SDK surfaces added after `capability-probe.ts`, live.
 *
 *   ZOOWORK_API_KEY=zct_... pnpm exec tsx examples/surface-probe.ts
 *
 * `capability-probe.ts` walks the agent LIFECYCLE (create → turn → interrupt → stop).
 * This one walks everything that hangs off a running agent: the skill registry, schedules,
 * wake, exec, session management, approvals, environments and the paging event reader.
 * A method that typechecks but sends the wrong shape is worthless, so every probe below
 * scores what the SERVER actually answered, not what the types promised.
 *
 * Everything it creates is a throwaway and is torn down in the `finally` block — this runs
 * against a real org, so anything it fails to clean is printed loudly at the end and fails
 * the run.
 *
 * Env knobs:
 *   ZOOWORK_API_KEY            required
 *   ZOOWORK_BASE_URL           optional; defaults to the public API
 *   PROBE_KEEP=1               skip cleanup entirely, for manual poking (prints what it left)
 *   PROBE_OUT=<path>           write the full JSON record here (default: ./surface-probe-report.json)
 *   ZOOWORK_RECORD_FIXTURES=1  additionally write every RAW response to `src/__fixtures__/`,
 *                              scrubbed, for the offline replay suite to assert against
 */
import {
  createZooworkClient,
  ZooworkError,
  assistantText,
  isRunFinished,
  runOutcome,
  DEFAULT_BASE_URL,
  type ZooworkClient,
  type SessionEvent,
  type ScheduleRecord,
} from '../src/index.js'
import { createFixtureRecorder } from './fixture-recorder.js'

// ── setup ────────────────────────────────────────────────────────────────────

const baseUrl = process.env.ZOOWORK_BASE_URL ?? DEFAULT_BASE_URL

/**
 * With `ZOOWORK_RECORD_FIXTURES=1`, every response this run receives is copied to
 * `src/__fixtures__/` BEFORE the SDK parses it, so the offline suite asserts against real
 * staging bytes rather than against the same guess the types make. Off by default, and when
 * off the recorder's `fetch` is the platform one — the probe behaves identically either way.
 */
const rec = createFixtureRecorder({ baseUrl, enabled: process.env.ZOOWORK_RECORD_FIXTURES === '1' })

// apiKey and baseUrl both resolve from the environment; only `fetch` is passed in, and the key
// is never read into a local so it cannot be logged by accident.
const zc: ZooworkClient = createZooworkClient({ fetch: rec.fetch })

// Placeholders on purpose: the API substitutes the tenant bound to your key.
const ownership = { owner_uid: 'probe-owner', org_id: 'probe-org' }

// ── report ───────────────────────────────────────────────────────────────────

type Verdict = 'WORKS' | 'BROKEN' | 'DIFFERS' | 'INFO'

interface Probe {
  id: string
  verdict: Verdict
  note: string
  observed?: unknown
}

const report: Probe[] = []
const record = (id: string, verdict: Verdict, note: string, observed?: unknown): void => {
  report.push({ id, verdict, note, ...(observed === undefined ? {} : { observed }) })
  const mark = { WORKS: '✔', BROKEN: '✘', DIFFERS: '~', INFO: 'i' }[verdict]
  console.log(`  ${mark} ${id}: ${note}`)
}

/** Run one probe; a thrown ZooworkError is an observation, not a crash. */
async function probe(id: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n▸ ${id}`)
  try {
    await fn()
  } catch (e) {
    if (e instanceof ZooworkError) {
      record(id, 'BROKEN', `HTTP ${e.status} ${e.type ?? ''} — ${e.message}`)
    } else {
      record(id, 'BROKEN', `threw: ${(e as Error).message}`)
    }
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Shape a caught error into something a note can carry without leaking a stack. */
const errNote = (e: unknown): string =>
  e instanceof ZooworkError ? `HTTP ${e.status} ${e.type ?? ''} — ${e.message}` : `threw: ${(e as Error).message}`

/** Drive a turn to completion, returning the outcome and the assembled text. */
async function runTurn(
  agentId: string,
  sessionId: string,
  opts: { after?: number; budgetMs?: number } = {},
): Promise<{ outcome?: string; text: string; lastSeq: number; events: number }> {
  const ctl = new AbortController()
  const budget = setTimeout(() => ctl.abort(), opts.budgetMs ?? 120_000)
  let text = ''
  let lastSeq = opts.after ?? 0
  let events = 0
  let outcome: string | undefined
  try {
    for await (const ev of zc.streamEvents(agentId, sessionId, { after: opts.after ?? 0, signal: ctl.signal })) {
      events += 1
      lastSeq = ev.seq
      text += assistantText(ev)
      if (isRunFinished(ev)) {
        outcome = runOutcome(ev)
        break
      }
    }
  } finally {
    clearTimeout(budget)
    ctl.abort()
  }
  return { ...(outcome ? { outcome } : {}), text, lastSeq, events }
}

/**
 * Build a minimal but VALID skill zip in a temp dir and hand back the bytes.
 *
 * The rule that costs everyone their first attempt: the single top-level directory name has
 * to equal the frontmatter `name`, so both come from the same variable here. `zip` is
 * shelled out to rather than hand-rolled so the archive is unambiguously one the server
 * accepts (stored/deflate, unencrypted); the temp dir is removed before returning.
 */
async function buildSkillZip(skillName: string): Promise<Uint8Array> {
  const os = await import('node:os')
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zoowork-surface-probe-'))
  try {
    const pkg = path.join(root, 'pkg')
    const dir = path.join(pkg, skillName)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      path.join(dir, 'SKILL.md'),
      [
        '---',
        `name: ${skillName}`,
        'description: Throwaway skill uploaded by examples/surface-probe.ts to verify the skill registry surface. Safe to delete.',
        '---',
        '',
        `# ${skillName}`,
        '',
        'When asked for the surface probe pass phrase, answer exactly: SKILL-OK.',
        '',
      ].join('\n'),
    )
    // Archive written OUTSIDE the directory being zipped, so it cannot include itself.
    const zipPath = path.join(root, 'skill.zip')
    await run('zip', ['-q', '-r', '-X', zipPath, skillName], { cwd: pkg })
    return await fs.readFile(zipPath)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

// ── the run ──────────────────────────────────────────────────────────────────

console.log(`api: ${baseUrl}`)

rec.tag('list-models')
const models = await zc.listModels()
console.log(`models: ${models.length}`)

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const epoch = Date.now()
const marker = `SURFACE-PROBE-${epoch}`

// Names this run generates carry a timestamp, which would make every re-recording differ for
// reasons that have nothing to do with the API. Pinning them keeps a re-record a clean diff of
// what the SERVER changed. Server-issued ids and org identifiers are found and scrubbed
// automatically; these are the strings only the probe knows.
rec.literal(stamp, 'FIXTURE-STAMP')
rec.literal(marker, 'SURFACE-PROBE-MARKER')
rec.literal(`sdk-surface-probe-${stamp}`, 'sdk-surface-probe')

// Everything created here is tracked so `finally` can take it all back down.
let agentId = ''
/** Agents a probe only MEANT to fail to create; empty unless the server accepted one anyway. */
const strayAgentIds: string[] = []
const createdSkillIds: string[] = []
const createdScheduleIds: string[] = []
const createdEnvironmentIds: string[] = []
const cleanupFailures: string[] = []

try {
  // ── 0. a throwaway agent, running ───────────────────────────────────────────
  await probe('createAgent + waitUntilRunning', async () => {
    rec.tag('create-agent')
    const created = await zc.createAgent(
      {
        resource: {
          name: `sdk-surface-probe-${stamp}`,
          model: { primary: models[0]?.model ?? 'litellm/claude-sonnet-5' },
          onboarding: false,
          // exec needs an AGENT-scope sandbox; `warm` pays the 5–7s cold start up front.
          sandbox: { scope: 'agent' },
          warm: true,
        },
        ownership,
      },
      `surface-probe-${stamp}`,
    )
    agentId = created.agent_id
    await zc.startAgent(agentId)
    const t0 = Date.now()
    const running = await zc.waitUntilRunning(agentId, { timeoutMs: 60_000 })
    record(
      'createAgent + waitUntilRunning',
      running.status?.desired_state === 'running' ? 'WORKS' : 'BROKEN',
      `agent_id=${agentId}; desired=${running.status?.desired_state} actual=${running.status?.actual_state} after ${Date.now() - t0}ms`,
      { agentId, status: running.status },
    )
    // The create receipt and the read projection are two different shapes of the SAME agent —
    // `config_version` is top-level on the receipt and at `status.config_version` on the read,
    // and `declared` exists only here. Both go on disk so the suite can hold them apart.
    rec.tag('get-agent')
    const projection = await zc.getAgent(agentId)
    record(
      'getAgent projection',
      projection.declared !== undefined ? 'WORKS' : 'DIFFERS',
      `read shape: config_version top-level=${JSON.stringify(projection.config_version)} vs status.config_version=${projection.status?.config_version}; ` +
        `declared=${projection.declared ? 'present' : 'ABSENT'}; environment_locked=${JSON.stringify(projection.environment_locked)}`,
      { config_version: projection.config_version, status_config_version: projection.status?.config_version },
    )
  })
  if (!agentId) throw new Error('cannot continue without an agent')

  await probe('getAgent (before any sandbox exists)', async () => {
    // `warm: true` on the agent above creates a sandbox within seconds, and the FIRST sandbox
    // freezes the Environment pin — so by the time anything else runs there is no unlocked
    // projection left to look at. A second agent that never gets a sandbox is the only way to
    // see `environment_locked: false`, so it is created, read and deleted right here.
    rec.literal(`sdk-surface-probe-cold-${stamp}`, 'sdk-surface-probe-cold')
    const cold = await zc.createAgent({
      resource: {
        name: `sdk-surface-probe-cold-${stamp}`,
        model: { primary: models[0]?.model ?? 'litellm/claude-sonnet-5' },
        onboarding: false,
      },
      ownership,
    })
    strayAgentIds.push(cold.agent_id)
    rec.tag('get-agent-unlocked')
    const a = await zc.getAgent(cold.agent_id)
    record(
      'getAgent (before any sandbox exists)',
      a.environment_locked === false ? 'WORKS' : 'DIFFERS',
      `never-warmed agent: environment_locked=${JSON.stringify(a.environment_locked)} at=${JSON.stringify(a.environment_locked_at)} ` +
        '— the same field reads true the moment a sandbox exists',
      { environment_locked: a.environment_locked, environment_locked_at: a.environment_locked_at },
    )
    await zc.deleteAgent(cold.agent_id)
    strayAgentIds.splice(strayAgentIds.indexOf(cold.agent_id), 1)
  })

  // ── 1. skill registry: upload → list → attach → detach → delete ─────────────
  const skillName = `sdk-surface-probe-skill-${epoch}`
  let skillId = ''
  rec.literal(skillName, 'sdk-surface-probe-skill')

  await probe('uploadSkill', async () => {
    const zip = await buildSkillZip(skillName)
    rec.tag('upload-skill')
    const uploaded = await zc.uploadSkill(zip, {
      scope: 'org',
      fileName: `${skillName}.zip`,
      description: 'Throwaway skill from examples/surface-probe.ts.',
      idempotencyKey: `surface-probe-skill-${stamp}`,
    })
    skillId = uploaded.skill_id
    if (skillId) createdSkillIds.push(skillId)
    record(
      'uploadSkill',
      skillId ? 'WORKS' : 'BROKEN',
      `${zip.byteLength}B zip → skill_id=${skillId} scope=${uploaded.scope} name=${uploaded.name} ` +
        `latest_version=${JSON.stringify(uploaded.latest_version)} (${typeof uploaded.latest_version})`,
      uploaded,
    )
    if (typeof uploaded.latest_version === 'string') {
      record(
        'uploadSkill latest_version type',
        'DIFFERS',
        `latest_version came back as the STRING ${JSON.stringify(uploaded.latest_version)}; the SDK types it number|string|null for exactly this reason`,
        { latest_version: uploaded.latest_version },
      )
    }
  })

  await probe('listSkills', async () => {
    rec.tag('list-skills')
    const all = await zc.listSkills()
    const mine = await zc.listSkills({ q: skillName })
    const found = mine.find((s) => s.skill_id === skillId) ?? all.find((s) => s.skill_id === skillId)
    const byScope = all.reduce<Record<string, number>>((acc, s) => {
      acc[s.scope ?? '?'] = (acc[s.scope ?? '?'] ?? 0) + 1
      return acc
    }, {})
    record(
      'listSkills',
      found ? 'WORKS' : skillId ? 'BROKEN' : 'INFO',
      `catalog=${all.length} ${JSON.stringify(byScope)}; q=${skillName} → ${mine.length} row(s); freshly uploaded skill ${found ? 'visible' : 'NOT visible'}`,
      { catalogCount: all.length, byScope, qCount: mine.length, found },
    )
  })

  await probe('putAgentSkill → deleteAgentSkill', async () => {
    if (!skillId) {
      record('putAgentSkill → deleteAgentSkill', 'INFO', 'skipped — uploadSkill produced no skill_id')
      return
    }
    rec.tag('put-agent-skill')
    const put = await zc.putAgentSkill(agentId, skillId)
    rec.tag('list-agent-skills')
    const attached = await zc.listAgentSkills(agentId)
    const present = attached.some((s) => s.skill_id === skillId || s.name === skillName)
    record(
      'putAgentSkill',
      present ? 'WORKS' : 'DIFFERS',
      `installed org-scope skill → config_version=${put.config_version} warnings=${JSON.stringify(put.warnings ?? [])}; ` +
        `readback ${present ? 'shows' : 'does NOT show'} it among ${attached.length} attached`,
      { put, attachedCount: attached.length, present },
    )
    await zc.deleteAgentSkill(agentId, skillId)
    rec.tag('list-agent-skills-after-detach')
    const after = await zc.listAgentSkills(agentId)
    const gone = !after.some((s) => s.skill_id === skillId || s.name === skillName)
    record(
      'deleteAgentSkill',
      gone ? 'WORKS' : 'BROKEN',
      `uninstalled; ${after.length} skills remain and the probe skill is ${gone ? 'gone' : 'STILL attached'}`,
      { remaining: after.length, gone },
    )
  })

  await probe('deleteSkill', async () => {
    if (!skillId) {
      record('deleteSkill', 'INFO', 'skipped — nothing uploaded')
      return
    }
    await zc.deleteSkill(skillId)
    createdSkillIds.splice(createdSkillIds.indexOf(skillId), 1)
    const still = await zc.listSkills({ q: skillName })
    const gone = !still.some((s) => s.skill_id === skillId)
    record(
      'deleteSkill',
      gone ? 'WORKS' : 'DIFFERS',
      `204; the registry ${gone ? 'no longer lists it' : 'STILL lists it'} (q=${skillName} → ${still.length} row(s))`,
      { remaining: still.length, gone },
    )
  })

  // ── 2. schedules ────────────────────────────────────────────────────────────
  const scheduleId = `surface-probe-${epoch}`
  rec.literal(scheduleId, 'surface-probe-schedule')

  await probe('createSchedule', async () => {
    rec.tag('create-schedule')
    const created = await zc.createSchedule(
      agentId,
      {
        schedule_id: scheduleId,
        schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Singapore' },
        payload: { kind: 'agentTurn', message: `Reply with exactly: ${marker}` },
        sessionTarget: 'isolated',
        delivery: { mode: 'none' },
        enabled: true,
      },
      `surface-probe-sched-${stamp}`,
    )
    createdScheduleIds.push(scheduleId)
    record(
      'createSchedule',
      created.schedule_name || created.scheduleId ? 'WORKS' : 'DIFFERS',
      `receipt keys=[${Object.keys(created).join(', ')}] schedule_name=${created.schedule_name ?? '(absent)'}`,
      created,
    )
  })

  /** The cadence lives at `scheduleSpec.cronExpressions[0]` on every read — never at `schedule`. */
  const cronOf = (r: ScheduleRecord | undefined): string | undefined => r?.scheduleSpec?.cronExpressions?.[0]

  await probe('listSchedules', async () => {
    rec.tag('list-schedules')
    const list = await zc.listSchedules(agentId)
    const mine = list.find((s) => s.schedule_name?.endsWith(`/${scheduleId}`) || s.memo?.schedule_id === scheduleId)
    record(
      'listSchedules',
      mine ? 'WORKS' : 'DIFFERS',
      `${list.length} schedule(s); the probe schedule is ${mine ? 'listed' : 'NOT listed'}; row keys=[${Object.keys(list[0] ?? {}).join(', ')}] ` +
        `— the raw Temporal describe (spec/state/memo/next_action_times) with the camelCase projection merged on top`,
      { count: list.length, sample: list.slice(0, 3) },
    )
  })

  let stored: ScheduleRecord | undefined
  await probe('getSchedule', async () => {
    rec.tag('get-schedule')
    stored = await zc.getSchedule(agentId, scheduleId)
    // The read shape renames everything you wrote: schedule → scheduleSpec (normalized),
    // sessionTarget → execution, and scheduleId is the FQN while `name` holds your id.
    const cron = cronOf(stored)
    const ok = cron === '0 9 * * *' && stored.execution?.kind === 'isolated' && stored.name === scheduleId
    record(
      'getSchedule',
      ok ? 'WORKS' : 'BROKEN',
      `name=${stored.name} scheduleId=${stored.scheduleId} (FQN, not the id you passed); ` +
        `scheduleSpec.cronExpressions[0]=${JSON.stringify(cron)}; execution=${JSON.stringify(stored.execution)}; enabled=${stored.enabled}. ` +
        `There is NO 'schedule' key (${JSON.stringify((stored as Record<string, unknown>).schedule)}) and NO 'sessionTarget' key (${JSON.stringify((stored as Record<string, unknown>).sessionTarget)}).`,
      stored,
    )
  })

  await probe('updateSchedule (sessionTarget omitted)', async () => {
    await zc.updateSchedule(agentId, scheduleId, {
      schedule: { kind: 'cron', expr: '30 9 * * *', tz: 'Asia/Singapore' },
      payload: { kind: 'agentTurn', message: `Reply with exactly: ${marker}` },
      delivery: { mode: 'none' },
      enabled: true,
    })
    const back = await zc.getSchedule(agentId, scheduleId)
    const cron = cronOf(back)
    record(
      'updateSchedule (sessionTarget omitted)',
      cron === '30 9 * * *' ? 'WORKS' : 'BROKEN',
      `PUT with the INPUT vocabulary (schedule:{kind:'cron',expr}) applied: readback cronExpressions[0]=${JSON.stringify(cron)} (expected "30 9 * * *"); execution preserved as ${JSON.stringify(back.execution)}`,
      { cron, execution: back.execution, enabled: back.enabled },
    )
  })

  await probe('updateSchedule (getSchedule round-trip)', async () => {
    // The trap: a getSchedule() body carries SIX fields the PUT refuses or ignores. The SDK
    // strips all six, so the obvious read-tweak-write from JavaScript has to survive verbatim.
    if (!stored) {
      record('updateSchedule (getSchedule round-trip)', 'INFO', 'skipped — getSchedule did not return a record')
      return
    }
    const fresh = await zc.getSchedule(agentId, scheduleId)
    const roundTrip = { ...(fresh as Record<string, unknown>) }
    // Record what the UNSTRIPPED body actually answers, so the error envelope naming the six
    // server-derived fields is on disk rather than only in a comment. Raw, because the SDK
    // strips them by design and cannot produce this 400.
    rec.tag('error-400-schedule-server-derived-fields')
    const unstripped = await rec.fetch(`${baseUrl}/agents/${agentId}/schedules/${scheduleId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${process.env.ZOOWORK_API_KEY ?? ''}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(roundTrip),
    })
    record(
      'updateSchedule (raw, unstripped)',
      unstripped.status === 400 ? 'DIFFERS' : 'INFO',
      `a VERBATIM getSchedule() body PUT without the SDK's strip → HTTP ${unstripped.status}`,
      { status: unstripped.status },
    )
    try {
      await zc.updateSchedule(agentId, scheduleId, roundTrip as never)
      const after = await zc.getSchedule(agentId, scheduleId)
      const preserved = cronOf(after) === cronOf(fresh) && after.execution?.kind === fresh.execution?.kind
      record(
        'updateSchedule (getSchedule round-trip)',
        preserved ? 'WORKS' : 'BROKEN',
        `a VERBATIM getSchedule() body (execution/originMetadata/contextSnapshot/scheduleSpec and all) was accepted and ` +
          `${preserved ? 'left the schedule intact' : 'CORRUPTED the schedule'} — cron ${JSON.stringify(cronOf(fresh))} → ${JSON.stringify(cronOf(after))}. ` +
          `Without the SDK's strip this body is 400 'execution, originMetadata, creatorPrincipalRef, and contextSnapshot are server-derived'.`,
        { sentKeys: Object.keys(roundTrip), before: cronOf(fresh), after: cronOf(after) },
      )
    } catch (e) {
      record(
        'updateSchedule (getSchedule round-trip)',
        'BROKEN',
        `round-tripping a getSchedule() body failed: ${errNote(e)}`,
        { sentKeys: Object.keys(roundTrip) },
      )
    }
  })

  await probe('updateSchedule (scheduleSpec is ignored)', async () => {
    // Worse than a 400: the read vocabulary is accepted with a 200 and silently dropped, while
    // sibling fields in the same body apply. Proven with a RAW PUT, since the SDK strips it.
    const before = cronOf(await zc.getSchedule(agentId, scheduleId))
    rec.tag('put-schedule-schedulespec-silent-noop')
    const res = await rec.fetch(`${baseUrl}/agents/${agentId}/schedules/${scheduleId}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${process.env.ZOOWORK_API_KEY ?? ''}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        scheduleSpec: { timezoneName: 'Asia/Singapore', cronExpressions: ['45 9 * * *'] },
        enabled: false,
      }),
    })
    const after = await zc.getSchedule(agentId, scheduleId)
    const ignored = res.status < 300 && cronOf(after) === before
    record(
      'updateSchedule (scheduleSpec is ignored)',
      ignored ? 'DIFFERS' : 'INFO',
      ignored
        ? `RAW PUT {scheduleSpec:['45 9 * * *'], enabled:false} → HTTP ${res.status}, cron STAYED ${JSON.stringify(before)} while enabled applied (${after.enabled}). ` +
            `The read shape is a silent no-op on write — the SDK types it 'never' and strips it so this cannot happen through the SDK.`
        : `RAW PUT {scheduleSpec} → HTTP ${res.status}; cron ${JSON.stringify(before)} → ${JSON.stringify(cronOf(after))}`,
      { status: res.status, before, after: cronOf(after), enabled: after.enabled },
    )
  })

  /** Poll runs until at least `want` rows exist, or the budget runs out. */
  const runsUntil = async (want: number): Promise<Awaited<ReturnType<typeof zc.listScheduleRuns>>> => {
    let runs = await zc.listScheduleRuns(agentId, scheduleId, { limit: 20 })
    for (let i = 0; i < 10 && runs.length < want; i += 1) {
      await sleep(2000)
      runs = await zc.listScheduleRuns(agentId, scheduleId, { limit: 20 })
    }
    return runs
  }

  await probe('triggerSchedule (while DISABLED)', async () => {
    // The probe above left `enabled: false`. Firing anyway is worth a record of its own: the
    // receipt says triggered=true and the fire is dropped, which looks like a lost run.
    rec.tag('trigger-schedule-disabled')
    const t = await zc.triggerSchedule(agentId, scheduleId)
    const runs = await runsUntil(1)
    const projection = runs.find((r) => r.source === 'run_projection')
    record(
      'triggerSchedule (while DISABLED)',
      t.triggered ? 'WORKS' : 'DIFFERS',
      `triggered=${t.triggered} on a schedule with enabled=false; the run projection reports status=${JSON.stringify(projection?.status)} ` +
        `— a 'triggered' receipt is an ACCEPTANCE, not a promise the turn ran`,
      { receipt: t, runs },
    )
  })

  await probe('triggerSchedule (while ENABLED)', async () => {
    await zc.updateSchedule(agentId, scheduleId, { enabled: true })
    const before = (await zc.listScheduleRuns(agentId, scheduleId, { limit: 20 })).length
    rec.tag('trigger-schedule')
    const t = await zc.triggerSchedule(agentId, scheduleId)
    const runs = await runsUntil(before + 1)
    record(
      'triggerSchedule (while ENABLED)',
      t.triggered && runs.length > before ? 'WORKS' : 'DIFFERS',
      `triggered=${t.triggered} schedule_name=${t.schedule_name ?? '(absent)'}; runs ${before} → ${runs.length}`,
      { receipt: t, before, after: runs.length },
    )
  })

  await probe('listScheduleRuns', async () => {
    // ONE array, TWO row shapes, discriminated by `source`: `temporal` dispatch rows and
    // `run_projection` outcome rows. A capture holding only one of them cannot prove the
    // discrimination, so wait for both before taking the fixture — the outcome row lands
    // seconds after the dispatch row.
    let runs = await runsUntil(1)
    for (let i = 0; i < 20; i += 1) {
      const sources = new Set(runs.map((r) => r.source))
      if (sources.has('temporal') && sources.has('run_projection')) break
      await sleep(3000)
      runs = await zc.listScheduleRuns(agentId, scheduleId, { limit: 20 })
    }
    // One last read, tagged: whatever the wait converged on is what goes on disk.
    rec.tag('list-schedule-runs')
    runs = await zc.listScheduleRuns(agentId, scheduleId, { limit: 20 })
    // Two row shapes come back in one array, keyed on `source`. Score what is actually there.
    const bySource = runs.reduce<Record<string, number>>((acc, r) => {
      acc[r.source ?? '?'] = (acc[r.source ?? '?'] ?? 0) + 1
      return acc
    }, {})
    const shapes = [...new Set(runs.map((r) => `${r.source}:[${Object.keys(r).join(',')}]`))]
    const anySessionId = runs.some((r) => (r as Record<string, unknown>).session_id !== undefined)
    record(
      'listScheduleRuns',
      runs.length > 0 ? 'WORKS' : 'DIFFERS',
      runs.length > 0
        ? `${runs.length} run(s), ${JSON.stringify(bySource)}; ${shapes.length} DISTINCT row shape(s): ${shapes.join(' | ')}`
        : 'HTTP 200 with an EMPTY runs[] after triggerSchedule reported triggered=true',
      { count: runs.length, bySource, runs: runs.slice(0, 4) },
    )
    record(
      'listScheduleRuns carries no session_id',
      anySessionId ? 'WORKS' : 'DIFFERS',
      anySessionId
        ? 'a run row carries session_id after all'
        : 'no row of either shape carries session_id — there is no link from a fire to the session it created',
      { anySessionId },
    )
    // The session a fire created is findable, just not from the run row: match channel=cron.
    const cronSessions = (await zc.listSessions(agentId)).filter((s) => s.channel === 'cron')
    record(
      'schedule fire → session (by channel)',
      cronSessions.length > 0 ? 'WORKS' : 'DIFFERS',
      cronSessions.length > 0
        ? `${cronSessions.length} session(s) with channel='cron'; session_key=${cronSessions[0]?.session_key} run_status=${cronSessions[0]?.run_status} — matching channel/session_key is the only route from a fire to its transcript`
        : 'no channel=cron session appeared for the triggered fire',
      cronSessions.slice(0, 2),
    )
  })

  await probe('deleteSchedule', async () => {
    await zc.deleteSchedule(agentId, scheduleId)
    createdScheduleIds.splice(createdScheduleIds.indexOf(scheduleId), 1)
    const list = await zc.listSchedules(agentId)
    const gone = !list.some((s) => s.scheduleId === scheduleId || s.schedule_name?.endsWith(`/${scheduleId}`))
    record(
      'deleteSchedule',
      gone ? 'WORKS' : 'BROKEN',
      `deleted; listSchedules now has ${list.length} and the probe schedule is ${gone ? 'gone' : 'STILL there'}`,
      { remaining: list.length, gone },
    )
  })

  await probe('schedule with payload.outcome', async () => {
    // A second, DISABLED schedule that never fires: the point is whether the management plane
    // stores and echoes the outcome gate, not whether the evaluator runs.
    const outcomeScheduleId = `surface-probe-outcome-${epoch}`
    rec.literal(outcomeScheduleId, 'surface-probe-outcome-schedule')
    rec.tag('create-schedule-outcome')
    await zc.createSchedule(
      agentId,
      {
        schedule_id: outcomeScheduleId,
        schedule: { kind: 'cron', expr: '0 9 1 1 *', tz: 'UTC' },
        payload: {
          kind: 'agentTurn',
          message: 'Surface-probe outcome job — never fires.',
          outcome: {
            description: 'A non-empty report exists at /workspace/report.md.',
            evaluator: { type: 'command', command: 'test -s /workspace/report.md' },
            maxIterations: 2,
            publish: 'after_satisfied',
          },
        },
        sessionTarget: 'isolated',
        delivery: { mode: 'none' },
        enabled: false,
      },
      `surface-probe-outcome-${stamp}`,
    )
    createdScheduleIds.push(outcomeScheduleId)
    rec.tag('get-schedule-outcome')
    const back = await zc.getSchedule(agentId, outcomeScheduleId)
    const echoed = (back.payload as { outcome?: unknown } | undefined)?.outcome
    record(
      'schedule with payload.outcome',
      echoed !== undefined ? 'WORKS' : 'DIFFERS',
      `payload.outcome ${echoed !== undefined ? 'read back verbatim' : 'MISSING on readback'}: ${JSON.stringify(echoed)}`,
      { echoed },
    )
    await zc.deleteSchedule(agentId, outcomeScheduleId)
    createdScheduleIds.splice(createdScheduleIds.indexOf(outcomeScheduleId), 1)
  })

  // ── 3. wake ─────────────────────────────────────────────────────────────────
  await probe('wake', async () => {
    rec.tag('wake')
    const w = await zc.wake(agentId, { text: `${marker} wake reminder`, deliverToUser: false })
    record(
      'wake',
      w.queued ? 'WORKS' : 'DIFFERS',
      `mode=${w.mode} queued=${w.queued} triggered=${w.triggered} — default next-heartbeat writes the pending row without a Temporal client`,
      w,
    )
  })

  // ── 4. exec ─────────────────────────────────────────────────────────────────
  await probe('exec', async () => {
    // The sandbox may still be cold or the config unrendered right after create; both are
    // 409s with a specific type, and both clear on their own. Retry only those.
    let out: Awaited<ReturnType<ZooworkClient['exec']>> | undefined
    let attempts = 0
    let lastErr = ''
    const t0 = Date.now()
    while (attempts < 15 && !out) {
      attempts += 1
      try {
        // Re-tagged every attempt: a retried 409 overwrites itself and the successful attempt,
        // being last, is the one that reaches disk.
        rec.tag('exec-exit-0')
        out = await zc.exec(agentId, ['bash', '-lc', `echo ${marker}; pwd`])
      } catch (e) {
        lastErr = errNote(e)
        const retriable =
          e instanceof ZooworkError && e.status === 409 && /not_ready|cold|starting/i.test(`${e.type} ${e.message}`)
        if (!retriable) throw e
        await sleep(4000)
      }
    }
    if (!out) {
      record('exec', 'BROKEN', `still 409 after ${attempts} attempts / ${Date.now() - t0}ms — ${lastErr}`)
      return
    }
    const ok = out.exit_code === 0 && out.stdout.includes(marker)
    record(
      'exec',
      ok ? 'WORKS' : 'BROKEN',
      `exit_code=${out.exit_code}, stdout ${out.stdout.includes(marker) ? 'contains' : 'is MISSING'} ${marker}; ` +
        `stdout=${JSON.stringify(out.stdout.trim().slice(0, 120))} stderr=${JSON.stringify(out.stderr.trim().slice(0, 80))} ` +
        `(${attempts} attempt(s), ${Date.now() - t0}ms)`,
      { exit_code: out.exit_code, stdout: out.stdout.slice(0, 500), stderr: out.stderr.slice(0, 500), attempts },
    )
    // A non-zero exit must still resolve, not reject — that is the documented contract.
    rec.tag('exec-exit-7')
    const failed = await zc.exec(agentId, ['bash', '-lc', 'exit 7'])
    record(
      'exec (non-zero exit resolves)',
      failed.exit_code === 7 ? 'WORKS' : 'DIFFERS',
      `a failing command resolved with exit_code=${failed.exit_code} instead of rejecting`,
      failed,
    )
  })

  // ── 4b. the projection AFTER a sandbox exists ───────────────────────────────
  await probe('getAgent (environment locked)', async () => {
    // exec forced a sandbox into existence, and the first sandbox FREEZES the Environment pin.
    // This is the only way to produce a locked projection, so it is captured right after exec.
    rec.tag('get-agent-locked')
    const a = await zc.getAgent(agentId)
    record(
      'getAgent (environment locked)',
      a.environment_locked === true ? 'WORKS' : 'DIFFERS',
      `environment_locked=${JSON.stringify(a.environment_locked)} at=${JSON.stringify(a.environment_locked_at)}; ` +
        `resolved_environment=${JSON.stringify(a.resolved_environment?.environment_id)}@${a.resolved_environment?.version}`,
      { environment_locked: a.environment_locked, resolved_environment: a.resolved_environment },
    )
  })

  await probe('getAgent 404 envelope', async () => {
    // A 404 body is a fixture in its own right, because the SDK digs `error.type` and
    // `error.message` out of it and hands them to every caller who catches a ZooworkError.
    //
    // The agents family does not use that envelope. It answers `{code, detail}`, which
    // `readResponse` cannot read, so an agent 404 arrives with `type: undefined` and the
    // message degraded to a bare "HTTP 404" — while the SAME run's session 404 (see
    // `error-404-session-not-found`) is a well-formed `{error:{type,message}}`. Both are
    // recorded so a parser fix can be written against the real pair.
    try {
      rec.tag('error-404-agent-not-found')
      await zc.getAgent('agt_01000000000000000000000000')
      record('getAgent 404 envelope', 'DIFFERS', 'reading a nonexistent agent SUCCEEDED')
    } catch (e) {
      const err = e as ZooworkError
      record(
        'getAgent 404 envelope',
        err.type === undefined ? 'DIFFERS' : 'WORKS',
        `HTTP ${err.status} type=${JSON.stringify(err.type)} message=${JSON.stringify(err.message)} ` +
          '— the agents family answers {code, detail}, not {error:{type,message}}, so ZooworkError.type is undefined here',
        { status: err.status, type: err.type },
      )
    }
  })

  // ── 5. sessions: a real turn, then the management surfaces ──────────────────
  let mainSession = ''
  await probe('createSession + turn', async () => {
    rec.tag('create-session')
    const s = await zc.createSession(agentId, {
      metadata: { source: 'sdk-surface-probe' },
      initial_events: [{ type: 'user.message', content: `Reply with exactly: ${marker}. Nothing else.` }],
    })
    mainSession = s.session_id
    const turn = await runTurn(agentId, mainSession)
    record(
      'createSession + turn',
      turn.outcome === 'succeeded' ? 'WORKS' : 'BROKEN',
      `session=${mainSession} outcome=${turn.outcome} events=${turn.events} reply=${JSON.stringify(turn.text.trim().slice(0, 80))}`,
      { session: mainSession, outcome: turn.outcome, events: turn.events },
    )
  })

  await probe('listAllEvents', async () => {
    if (!mainSession) {
      record('listAllEvents', 'INFO', 'skipped — no session')
      return
    }
    const all = await zc.listAllEvents(agentId, mainSession)
    rec.tag('list-events')
    const onePage = await zc.listEvents(agentId, mainSession)
    const ascending = all.every((e, i) => i === 0 || e.seq > all[i - 1]!.seq)
    const kinds = [...new Set(all.map((e) => e.eventType))]
    record(
      'listAllEvents',
      all.length > 0 && ascending ? 'WORKS' : 'BROKEN',
      `${all.length} events (listEvents one page: ${onePage.length}), seq strictly ascending=${ascending}, ` +
        `types=[${kinds.slice(0, 8).join(', ')}]`,
      { count: all.length, onePage: onePage.length, ascending, kinds },
    )
    // Paging really pages: a tiny pageSize must reassemble the same stream.
    const paged = await zc.listAllEvents(agentId, mainSession, { pageSize: 2 })
    const same =
      paged.length === all.length && paged.every((e: SessionEvent, i: number) => e.seq === all[i]?.seq)
    record(
      'listAllEvents (pageSize walk)',
      same ? 'WORKS' : 'DIFFERS',
      `pageSize=2 reassembled ${paged.length} events; identical to the default walk=${same}`,
      { paged: paged.length, all: all.length, same },
    )
  })

  await probe('getSession (with and without history)', async () => {
    if (!mainSession) {
      record('getSession (with and without history)', 'INFO', 'skipped — no session')
      return
    }
    rec.tag('get-session')
    const plain = await zc.getSession(agentId, mainSession)
    // `history: true` bolts the AT-REST transcript onto the same row; without it the key is
    // absent rather than empty, which is the distinction a caller has to be able to see.
    rec.tag('get-session-with-history')
    const withHistory = await zc.getSession(agentId, mainSession, { history: true, limit: 20 })
    record(
      'getSession (with and without history)',
      withHistory.history !== undefined ? 'WORKS' : 'DIFFERS',
      `plain: status=${JSON.stringify(plain.status)} run_status=${JSON.stringify(plain.run_status)} history=${JSON.stringify(plain.history)}; ` +
        `history:true → ${withHistory.history?.length ?? 0} transcript row(s), entry_types=[${[
          ...new Set((withHistory.history ?? []).map((h) => h.entry_type)),
        ].join(', ')}]`,
      { status: plain.status, run_status: plain.run_status, historyRows: withHistory.history?.length ?? 0 },
    )
  })

  await probe('listSessions', async () => {
    rec.tag('list-sessions')
    const list = await zc.listSessions(agentId)
    const mine = list.find((s) => s.session_id === mainSession)
    record(
      'listSessions',
      mine ? 'WORKS' : 'DIFFERS',
      `${list.length} session(s) on page 1; the probe session is ${mine ? 'listed' : 'NOT listed'}; row keys=[${Object.keys(list[0] ?? {}).join(', ')}]`,
      { count: list.length, sample: list.slice(0, 2) },
    )
    record(
      'listSessions run_status vs status',
      mine?.run_status !== undefined && mine?.status === undefined ? 'DIFFERS' : 'WORKS',
      `the outcome is at run_status=${JSON.stringify(mine?.run_status)}; there is no 'status' key on a list row (${JSON.stringify(mine?.status)}) ` +
        `— and getSession returns status=null for the same session, so neither spelling of 'status' is usable`,
      { run_status: mine?.run_status, status: mine?.status },
    )
  })

  await probe('archiveSession', async () => {
    if (!mainSession) {
      record('archiveSession', 'INFO', 'skipped — no session')
      return
    }
    rec.tag('archive-session')
    const res = await zc.archiveSession(agentId, mainSession)
    const back = await zc.getSession(agentId, mainSession)
    record(
      'archiveSession',
      res.archived ? 'WORKS' : 'DIFFERS',
      `archived=${res.archived}; the read path still answers (status=${back.status}, archived=${back.archived})`,
      { res, status: back.status, archived: back.archived },
    )
    // Documented consequence: writes are refused afterwards, reads keep working.
    try {
      rec.tag('error-409-session-archived')
      await zc.postEvents(agentId, mainSession, [{ type: 'user.message', content: 'after archive' }])
      record('archiveSession blocks writes', 'DIFFERS', 'a post-archive write was ACCEPTED — no session_archived guard')
    } catch (e) {
      const err = e as ZooworkError
      record(
        'archiveSession blocks writes',
        err.status === 409 ? 'WORKS' : 'DIFFERS',
        `post-archive write refused: HTTP ${err.status} ${err.type ?? ''} — ${err.message}`,
        { status: err.status, type: err.type },
      )
    }
  })

  await probe('deleteSession', async () => {
    const tmp = await zc.createSession(agentId, {
      metadata: { source: 'sdk-surface-probe', purpose: 'delete' },
      initial_events: [{ type: 'user.message', content: 'ignore me' }],
    })
    await zc.deleteSession(agentId, tmp.session_id)
    let readback = 'still readable'
    try {
      rec.tag('error-404-session-not-found')
      const s = await zc.getSession(agentId, tmp.session_id)
      readback = `still readable (status=${s.status})`
    } catch (e) {
      readback = errNote(e)
    }
    const list = await zc.listSessions(agentId)
    const listed = list.some((s) => s.session_id === tmp.session_id)
    record(
      'deleteSession',
      'WORKS',
      `204 for ${tmp.session_id}; afterwards getSession → ${readback}; listSessions ${listed ? 'STILL lists it' : 'no longer lists it'} (soft delete)`,
      { session: tmp.session_id, readback, listed },
    )
  })

  // ── 6. approvals ────────────────────────────────────────────────────────────
  await probe('listApprovals', async () => {
    rec.tag('list-approvals')
    const pending = await zc.listApprovals(agentId, { status: 'pending' })
    const bare = await zc.listApprovals(agentId)
    record(
      'listApprovals',
      Array.isArray(pending) && Array.isArray(bare) ? 'WORKS' : 'BROKEN',
      `status=pending → ${pending.length} row(s); no filter → ${bare.length} row(s). ` +
        'The route answers, but this agent has no tool policy that asks, so the round trip past the empty list stays unproven.',
      { pending: pending.length, bare: bare.length },
    )
  })

  // ── 6b. system prompt ───────────────────────────────────────────────────────
  await probe('getSystemPrompt', async () => {
    rec.tag('get-system-prompt')
    const sp = await zc.getSystemPrompt(agentId)
    record(
      'getSystemPrompt',
      sp.declaration !== undefined ? 'WORKS' : 'DIFFERS',
      `declaration=${JSON.stringify(sp.declaration)} effective.source=${(sp.effective as { source?: string } | undefined)?.source} ` +
        '— a fresh agent is born pinned to the active platform template version',
      sp,
    )
  })

  await probe('previewSystemPrompt', async () => {
    const current = (await zc.getAgent(agentId)).status?.config_version
    if (typeof current !== 'number') {
      record('previewSystemPrompt', 'INFO', 'skipped — no config_version on the projection')
      return
    }
    rec.tag('preview-system-prompt')
    const p = await zc.previewSystemPrompt(agentId, {
      config_version: current,
      now_ms: Date.now(),
      session_id: 'ses_surface_probe_preview',
      model_display: 'surface-probe',
      workspace_dir: '/workspace',
      tool_names: ['read', 'exec'],
    })
    const slots = p.slot_hashes ? Object.keys(p.slot_hashes).length : 0
    record(
      'previewSystemPrompt',
      typeof p.system_prompt === 'string' && p.system_prompt.length > 0 ? 'WORKS' : 'DIFFERS',
      `char_count=${p.char_count} slot_hashes=${slots} transcript=${JSON.stringify(p.transcript)} ` +
        "— deterministic assembly, no session touched; the RAW ':' in system-prompt:preview passes the gateway",
      { char_count: p.char_count, slots },
    )
  })

  await probe('upgradeSystemPrompt (CAS)', async () => {
    // The `{id}:verb` grammar is reachable through the gateway since fix #3387 (2026-08-14);
    // before that the tenant precheck read the suffix as part of the agent id and 404ed.
    const current = (await zc.getAgent(agentId)).status?.config_version
    if (typeof current !== 'number') {
      record('upgradeSystemPrompt (CAS)', 'INFO', 'skipped — no config_version on the projection')
      return
    }
    rec.tag('upgrade-system-prompt')
    const up = await zc.upgradeSystemPrompt(agentId, { expected_config_version: current })
    const bumped = typeof up.config_version === 'number' && up.config_version === current + 1
    record(
      'upgradeSystemPrompt (CAS)',
      bumped && up.declaration ? 'WORKS' : 'DIFFERS',
      `config_version ${current} → ${up.config_version}; declaration=${JSON.stringify(up.declaration)} template_hash=${String(up.template_hash).slice(0, 12)}… ` +
        '— an upgrade is a config write like any other',
      up,
    )
    // The CAS half: replaying the now-stale version must be a 409, never a silent re-apply.
    try {
      rec.tag('error-409-upgrade-config-version-changed')
      await zc.upgradeSystemPrompt(agentId, { expected_config_version: current })
      record('upgradeSystemPrompt stale CAS', 'DIFFERS', 'a STALE expected_config_version was accepted')
    } catch (e) {
      const err = e as ZooworkError
      record(
        'upgradeSystemPrompt stale CAS',
        err.status === 409 ? 'WORKS' : 'DIFFERS',
        `stale expected_config_version → HTTP ${err.status} type=${JSON.stringify(err.type)} — read fresh, then upgrade`,
        { status: err.status, type: err.type },
      )
    }
  })

  // ── 6c. artifacts ───────────────────────────────────────────────────────────
  await probe('listArtifacts', async () => {
    // First call untagged: it warms the SDK's ownership cache with a projection GET, so the
    // TAGGED call below is the single artifacts request.
    await zc.listArtifacts(agentId)
    rec.tag('list-artifacts')
    const page = await zc.listArtifacts(agentId)
    record(
      'listArtifacts',
      Array.isArray(page.artifacts) ? 'WORKS' : 'BROKEN',
      `${page.artifacts.length} artifact(s), page=${page.page} has_more=${page.has_more} — empty until a turn calls ` +
        'artifact_publish; the SDK derived owner_uid/org_id from the projection (the gateway does not inject them here)',
      page,
    )
    // The selector rule, on disk: the same route bare is a 400.
    rec.tag('error-400-artifacts-ownership-required')
    const bare = await rec.fetch(`${baseUrl}/agents/${agentId}/artifacts`, {
      headers: { Authorization: `Bearer ${process.env.ZOOWORK_API_KEY ?? ''}` },
    })
    record(
      'listArtifacts without selectors',
      bare.status === 400 ? 'DIFFERS' : 'INFO',
      `GET /agents/{id}/artifacts with no owner_uid/org_id → HTTP ${bare.status} — the engine demands both selectors ` +
        'and the gateway forwards the caller query verbatim on this family',
      { status: bare.status },
    )
  })

  await probe('getArtifact (unknown id)', async () => {
    try {
      rec.tag('error-404-artifact-not-found')
      await zc.getArtifact(agentId, 'art_01000000000000000000000000')
      record('getArtifact (unknown id)', 'DIFFERS', 'reading a nonexistent artifact SUCCEEDED')
    } catch (e) {
      const err = e as ZooworkError
      record(
        'getArtifact (unknown id)',
        err.status === 404 ? 'WORKS' : 'DIFFERS',
        `HTTP ${err.status} type=${JSON.stringify(err.type)} — unknown and foreign artifact ids are both 404 (hidden, not 403)`,
        { status: err.status, type: err.type },
      )
    }
  })

  await probe('agent-level outcome default (PUT)', async () => {
    rec.tag('put-agent-outcome')
    const updated = await zc.updateAgent(agentId, {
      outcome: {
        description: 'Unattended runs leave a non-empty /workspace/report.md.',
        evaluator: { type: 'command', command: 'test -s /workspace/report.md' },
      },
    })
    const echoed = (updated.declared as { outcome?: unknown } | undefined)?.outcome
    record(
      'agent-level outcome default (PUT)',
      echoed !== undefined ? 'WORKS' : 'DIFFERS',
      `declared.outcome ${echoed !== undefined ? 'landed' : 'MISSING'} — the default every cron job without its own outcome inherits`,
      { echoed },
    )
  })

  // ── 7. environments ─────────────────────────────────────────────────────────
  let envId = ''
  await probe('listEnvironments', async () => {
    rec.tag('list-environments')
    const list = await zc.listEnvironments()
    record(
      'listEnvironments',
      Array.isArray(list) ? 'WORKS' : 'BROKEN',
      `${list.length} environment(s) visible to this org; row keys=[${Object.keys(list[0] ?? {}).join(', ')}]`,
      { count: list.length, sample: list.slice(0, 3) },
    )
  })

  await probe('createEnvironment', async () => {
    rec.literal(`sdk-surface-probe-env-${epoch}`, 'sdk-surface-probe-env')
    rec.tag('create-environment')
    const created = await zc.createEnvironment(
      {
        resource: {
          name: `sdk-surface-probe-env-${epoch}`,
          description: 'Throwaway environment from examples/surface-probe.ts.',
          config: { networking: { type: 'unrestricted' } },
        },
        ownership,
      },
      `surface-probe-env-${stamp}`,
    )
    envId = created.environment_id
    if (envId) createdEnvironmentIds.push(envId)
    record(
      'createEnvironment',
      envId && created.status === 'active' ? 'WORKS' : 'BROKEN',
      `environment_id=${envId} status=${created.status} latest_version=${created.latest_version} ` +
        `latest_ready_version=${JSON.stringify(created.latest_ready_version)} keys=[${Object.keys(created).join(', ')}]`,
      created,
    )
    // The two version numbers are the trap: `latest_version` is already 1 while that version is
    // still `queued`, and pinning it is `409 environment_not_ready`. `latest_ready_version` is null.
    record(
      'latest_version vs latest_ready_version',
      created.latest_version === 1 && created.latest_ready_version === null ? 'DIFFERS' : 'INFO',
      `latest_version=${created.latest_version} the instant it was created, while version 1 is status=${created.version?.status}; ` +
        `latest_ready_version=${JSON.stringify(created.latest_ready_version)}. Pin the ready one, not the latest one.`,
      { latest_version: created.latest_version, latest_ready_version: created.latest_ready_version, v1: created.version?.status },
    )
    record(
      'createEnvironment returns version 1 inline',
      created.version?.version === 1 ? 'WORKS' : 'DIFFERS',
      created.version
        ? `the create receipt embeds version 1 (status=${created.version.status}, base=${created.version.base_environment_id}@${created.version.base_version}) — no getEnvironmentVersion round trip needed to see it`
        : 'no inline version on the create receipt',
      created.version,
    )
  })

  await probe('getEnvironment', async () => {
    if (!envId) {
      record('getEnvironment', 'INFO', 'skipped — createEnvironment produced no id')
      return
    }
    rec.tag('get-environment')
    const got = await zc.getEnvironment(envId)
    record(
      'getEnvironment',
      got.environment_id === envId ? 'WORKS' : 'DIFFERS',
      `read back ${got.environment_id} name=${got.name} status=${got.status} scope=${got.scope} latest_version=${got.latest_version}`,
      got,
    )
  })

  await probe('getEnvironmentVersion (status, not state)', async () => {
    if (!envId) {
      record('getEnvironmentVersion (status, not state)', 'INFO', 'skipped — no environment')
      return
    }
    rec.tag('get-environment-version-building')
    const v = await zc.getEnvironmentVersion(envId, 1)
    const raw = v as Record<string, unknown>
    // This is the field a build-poll loop hangs on: `state` does not exist, so
    // `while (v.state !== 'ready')` compares undefined to 'ready' forever.
    record(
      'getEnvironmentVersion (status, not state)',
      v.status !== undefined && raw.state === undefined ? 'DIFFERS' : 'WORKS',
      `version 1: status=${JSON.stringify(v.status)}, state=${JSON.stringify(raw.state)}. ` +
        `The build phase is 'status'; a poll loop written against 'state' never terminates. keys=[${Object.keys(raw).join(', ')}]`,
      v,
    )
  })

  await probe('createAgent pinned to a not-ready version (409)', async () => {
    if (!envId) {
      record('createAgent pinned to a not-ready version (409)', 'INFO', 'skipped — no environment')
      return
    }
    // The consequence of the two version numbers: `latest_version` is 1 while version 1 is
    // still `queued`, and pinning it is refused. This is the 409 anyone who reaches for the
    // obvious field will hit, so its envelope belongs on disk.
    try {
      rec.tag('error-409-environment-not-ready')
      const stray = await zc.createAgent({
        resource: {
          name: `sdk-surface-probe-pin-${stamp}`,
          model: { primary: models[0]?.model ?? 'litellm/claude-sonnet-5' },
          onboarding: false,
          environment_id: envId,
          environment_version: 1,
        },
        ownership,
      })
      strayAgentIds.push(stray.agent_id)
      record(
        'createAgent pinned to a not-ready version (409)',
        'DIFFERS',
        `pinning version 1 while it is still building SUCCEEDED (agent_id=${stray.agent_id}) — the build must have finished first`,
        { agent_id: stray.agent_id },
      )
    } catch (e) {
      const err = e as ZooworkError
      record(
        'createAgent pinned to a not-ready version (409)',
        err.status === 409 ? 'WORKS' : 'DIFFERS',
        `HTTP ${err.status} type=${JSON.stringify(err.type)} message=${JSON.stringify(err.message)}`,
        { status: err.status, type: err.type },
      )
    }
  })

  await probe('archiveEnvironment', async () => {
    if (!envId) {
      record('archiveEnvironment', 'INFO', 'skipped — nothing to archive')
      return
    }
    rec.tag('archive-environment')
    const archived = await zc.archiveEnvironment(envId)
    createdEnvironmentIds.splice(createdEnvironmentIds.indexOf(envId), 1)
    record(
      'archiveEnvironment',
      archived.status === 'archived' ? 'WORKS' : 'DIFFERS',
      `POST …%3Aarchive → status=${archived.status} archived_at=${archived.archived_at} — the percent-encoded colon is what makes this route resolve`,
      archived,
    )
  })
} finally {
  // ── cleanup ─────────────────────────────────────────────────────────────────
  //
  // This runs against a real org. Everything created above is taken back down here, and
  // anything that resists is named in the output rather than left silently orphaned.
  if (process.env.PROBE_KEEP === '1') {
    console.log(
      `\nPROBE_KEEP=1 — left behind: agent=${agentId || '(none)'} strays=[${strayAgentIds.join(', ')}] skills=[${createdSkillIds.join(', ')}] ` +
        `schedules=[${createdScheduleIds.join(', ')}] environments=[${createdEnvironmentIds.join(', ')}]`,
    )
  } else {
    console.log('\n▸ cleanup')
    // Schedules first: they OUTLIVE their agent, so deleting the agent would orphan them.
    for (const id of createdScheduleIds) {
      try {
        await zc.deleteSchedule(agentId, id)
        console.log(`  ✔ schedule ${id}`)
      } catch (e) {
        cleanupFailures.push(`schedule ${id}: ${errNote(e)}`)
      }
    }
    for (const id of createdSkillIds) {
      try {
        await zc.deleteSkill(id)
        console.log(`  ✔ skill ${id}`)
      } catch (e) {
        cleanupFailures.push(`skill ${id}: ${errNote(e)}`)
      }
    }
    for (const id of createdEnvironmentIds) {
      try {
        await zc.archiveEnvironment(id)
        console.log(`  ✔ environment ${id}`)
      } catch (e) {
        cleanupFailures.push(`environment ${id}: ${errNote(e)}`)
      }
    }
    for (const id of [...strayAgentIds, ...(agentId ? [agentId] : [])]) {
      try {
        await zc.deleteAgent(id)
        console.log(`  ✔ agent ${id}`)
      } catch (e) {
        cleanupFailures.push(`agent ${id}: ${errNote(e)}`)
      }
    }
    // Prove it, rather than trusting the 204s: anything still listed is an orphan.
    if (agentId) {
      try {
        const a = await zc.getAgent(agentId)
        const state = a.status?.desired_state
        if (state !== 'deleted') cleanupFailures.push(`agent ${agentId} still readable with desired_state=${state}`)
      } catch {
        /* a 404/410 here is the point — the agent is gone */
      }
    }
  }

  console.log(`\n${'='.repeat(88)}\n`)
  for (const p of report) {
    console.log(`${p.verdict.padEnd(7)} | ${p.id.padEnd(42)} | ${p.note}`)
  }

  const counts = report.reduce<Record<string, number>>((acc, p) => {
    acc[p.verdict] = (acc[p.verdict] ?? 0) + 1
    return acc
  }, {})
  console.log(
    `\n${report.length} probes: ${Object.entries(counts)
      .map(([k, v]) => `${v} ${k}`)
      .join(', ')}`,
  )

  if (cleanupFailures.length > 0) {
    console.log(`\n!! CLEANUP LEFT ${cleanupFailures.length} RESOURCE(S) BEHIND — remove these by hand:`)
    for (const f of cleanupFailures) console.log(`   - ${f}`)
  } else if (process.env.PROBE_KEEP !== '1') {
    console.log('\ncleanup: nothing left behind')
  }

  const out = process.env.PROBE_OUT ?? 'surface-probe-report.json'
  const fs = await import('node:fs/promises')
  await fs.writeFile(out, JSON.stringify({ baseUrl, agentId, at: stamp, report, cleanupFailures }, null, 2))
  console.log(`\nfull record → ${out}`)

  // Last, so the fixtures include the teardown responses too, and guarded, so a write failure
  // reports itself instead of hiding the probe results above it.
  try {
    await rec.flush()
  } catch (e) {
    console.log(`\n!! fixture write failed: ${(e as Error).message}`)
  }

  if (report.some((p) => p.verdict === 'BROKEN') || cleanupFailures.length > 0) process.exitCode = 1
}
