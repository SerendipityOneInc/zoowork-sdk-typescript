/**
 * Capability probe — exercises the SDK surfaces that ship but have never been run.
 *
 *   ZOOWORK_API_KEY=zct_... pnpm exec tsx examples/capability-probe.ts
 *
 * Unlike `live-smoke.ts` (which drives one pre-existing agent through one turn),
 * this creates a THROWAWAY agent from zero, walks its whole lifecycle, and deletes
 * it. Every probe records what actually came back, so the capability docs can cite
 * an observation instead of a reading of the server source.
 *
 * Env knobs:
 *   ZOOWORK_API_KEY     required
 *   ZOOWORK_BASE_URL    optional; defaults to the public API
 *   PROBE_KEEP=1        leave the agent alive (skips stop/delete) for manual poking
 *   PROBE_OUT=<path>    write the full JSON record here (default: ./probe-report.json)
 */
import {
  createZooworkClient,
  ZooworkError,
  assistantText,
  isRunFinished,
  runOutcome,
  type SessionEvent,
  type ZooworkClient,
  type ZooworkConfig,
  DEFAULT_BASE_URL,
} from '../src/index.js'

// ── setup ────────────────────────────────────────────────────────────────────

const need = (n: string): string => {
  const v = process.env[n]
  if (!v) throw new Error(`missing env ${n}`)
  return v
}

const bearer = need('ZOOWORK_API_KEY')
const baseUrl = process.env.ZOOWORK_BASE_URL ?? DEFAULT_BASE_URL
const config: ZooworkConfig = { baseUrl, apiKey: bearer }

// Placeholders on purpose: the API substitutes the tenant bound to your key.
const ownership = { owner_uid: 'probe-owner', org_id: 'probe-org' }

const zc: ZooworkClient = createZooworkClient(config)

/** Escape hatch for routes the SDK does not expose yet (agent skills, skill catalog). */
async function raw(path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${bearer}` },
  })
  const text = await res.text()
  try {
    return { status: res.status, body: text ? JSON.parse(text) : null }
  } catch {
    return { status: res.status, body: text.slice(0, 400) }
  }
}

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

/** Drive a turn to completion, returning the outcome and the assembled text. */
async function runTurn(
  agentId: string,
  sessionId: string,
  opts: { after?: number; budgetMs?: number; onEvent?: (ev: SessionEvent) => void } = {},
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
      opts.onEvent?.(ev)
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

// ── the run ──────────────────────────────────────────────────────────────────

console.log(`api: ${baseUrl}`)

const models = await zc.listModels()
console.log(`models: ${models.length}`)

let agentId = ''
const stamp = new Date().toISOString().replace(/[:.]/g, '-')

try {
  // ── 1. create → is it running? ──────────────────────────────────────────────
  await probe('createAgent (from zero)', async () => {
    const created = await zc.createAgent(
      {
        resource: {
          name: `sdk-capability-probe-${stamp}`,
          model: { primary: models[0]?.model ?? 'litellm/claude-sonnet-5' },
          onboarding: false,
        },
        ownership,
      },
      `probe-${stamp}`,
    )
    agentId = created.agent_id
    record('createAgent (from zero)', 'WORKS', `agent_id=${agentId} config_version=${created.config_version}`, {
      ownership: created.ownership,
      status: created.status,
    })
  })
  if (!agentId) throw new Error('cannot continue without an agent')

  await probe('create response vs read projection', async () => {
    const a = await zc.getAgent(agentId)
    record(
      'create response vs read projection',
      a.config_version === undefined && a.status?.config_version !== undefined ? 'DIFFERS' : 'WORKS',
      `POST returns a flat receipt (top-level config_version); GET returns a projection with keys=[${Object.keys(a).join(', ')}] and the version at status.config_version=${a.status?.config_version}`,
      { getKeys: Object.keys(a), statusConfigVersion: a.status?.config_version, topLevel: a.config_version },
    )
  })

  await probe('desired_state after create', async () => {
    const a = await zc.getAgent(agentId)
    const desired = a.status?.desired_state
    record(
      'desired_state after create',
      desired === 'running' ? 'WORKS' : 'DIFFERS',
      `desired=${desired} actual=${a.status?.actual_state} — ${desired === 'running' ? 'auto-started' : 'caller must call startAgent()'}`,
      a.status,
    )
  })

  await probe('startAgent → desired_state', async () => {
    const t0 = Date.now()
    const { warnings } = await zc.startAgent(agentId)
    let desired: string | undefined
    let actual: string | undefined
    for (let i = 0; i < 30; i += 1) {
      const a = await zc.getAgent(agentId)
      desired = a.status?.desired_state
      actual = a.status?.actual_state
      if (desired === 'running') break
      await sleep(1000)
    }
    const ms = Date.now() - t0
    record(
      'startAgent → desired_state',
      desired === 'running' ? 'WORKS' : 'BROKEN',
      `desired=${desired} after ${ms}ms; warnings=${JSON.stringify(warnings)}`,
      { ms, desired, actual, warnings },
    )
    // actual_state tracks CHANNEL routes, not API readiness. An API-only agent has
    // no channels, so it never leaves `activating` — polling it would hang forever.
    record(
      'actual_state as a readiness gate',
      actual === 'active' ? 'WORKS' : 'DIFFERS',
      `actual=${actual} while desired=running — ${actual === 'active' ? 'usable' : 'NOT a readiness signal for API-only agents; gate on desired_state'}`,
      { actual },
    )
  })

  // ── 2. updateAgent + no-op version churn ────────────────────────────────────
  const cfgVersion = async (): Promise<number | undefined> => {
    const a = await zc.getAgent(agentId)
    return a.status?.config_version ?? a.config_version
  }

  await probe('updateAgent (declared section)', async () => {
    const before = await cfgVersion()
    await zc.updateAgent(agentId, { labels: { probe: stamp } })
    const first = await cfgVersion()
    await zc.updateAgent(agentId, { labels: { probe: stamp } })
    const second = await cfgVersion()
    const after = await zc.getAgent(agentId)
    const applied = (after.declared as { labels?: Record<string, string> } | undefined)?.labels?.probe === stamp
    record(
      'updateAgent (declared section)',
      applied ? 'WORKS' : 'BROKEN',
      `config_version ${before} → ${first} → ${second}; declared.labels.probe ${applied ? 'applied' : 'NOT applied'}`,
      { before, first, second, declaredLabels: (after.declared as { labels?: unknown } | undefined)?.labels },
    )
    record(
      'updateAgent no-op detection',
      second === first ? 'WORKS' : 'DIFFERS',
      second === first
        ? 'an identical re-PUT does not bump config_version'
        : `every PUT bumps config_version, including an identical one (${first} → ${second}); Claude de-dupes no-ops`,
      { first, second },
    )
  })

  await probe('updateAgent merge vs replace', async () => {
    // The PUT above sent ONLY `labels`. If `name`/`model` survive in `declared`,
    // PUT merges sections rather than replacing the whole declared document.
    const declared = ((await zc.getAgent(agentId)).declared ?? {}) as Record<string, unknown>
    const nameSurvived = typeof declared.name === 'string' && declared.name.includes('sdk-capability-probe')
    record(
      'updateAgent merge vs replace',
      'INFO',
      nameSurvived
        ? `sections omitted from the PUT body are PRESERVED (per-section merge); declared keys=[${Object.keys(declared).join(', ')}]`
        : 'omitted sections were dropped (whole-document replace)',
      { declaredKeys: Object.keys(declared), name: declared.name, labels: declared.labels },
    )
  })

  // ── 3. skills ───────────────────────────────────────────────────────────────
  await probe('skill catalog + install + readback', async () => {
    const cat = await raw(`/skills?owner_uid=${encodeURIComponent(ownership.owner_uid)}&org_id=${encodeURIComponent(ownership.org_id)}`)
    const skills = (cat.body as { skills?: { skill_id: string; name?: string; scope?: string }[] })?.skills ?? []
    record(
      'GET /skills (catalog)',
      cat.status === 200 ? 'WORKS' : 'BROKEN',
      `HTTP ${cat.status}, ${skills.length} visible: ${skills.map((s) => `${s.name ?? s.skill_id}[${s.scope}]`).slice(0, 8).join(', ') || '(none)'}`,
      { status: cat.status, skills: skills.slice(0, 20) },
    )
    const byScope = skills.reduce<Record<string, number>>((acc, s) => {
      acc[s.scope ?? '?'] = (acc[s.scope ?? '?'] ?? 0) + 1
      return acc
    }, {})
    record('skill scopes visible', 'INFO', JSON.stringify(byScope), byScope)
    if (skills.length === 0) {
      record('putAgentSkill', 'INFO', 'skipped — no skill visible to this token to install')
      return
    }
    // Prefer a non-global skill: the gateway only forwards org/personal scopes.
    const target = skills.find((s) => s.scope !== 'global') ?? skills[0]!
    try {
      const put = await zc.putAgentSkill(agentId, target.skill_id)
      record(
        'putAgentSkill',
        'WORKS',
        `installed ${target.name ?? target.skill_id} [${target.scope}] → config_version=${put.config_version}`,
        put,
      )
    } catch (e) {
      const err = e as ZooworkError
      record(
        'putAgentSkill',
        'DIFFERS',
        target.scope === 'global'
          ? `HTTP ${err.status} on a [global] skill — the catalog lists ${byScope.global ?? 0} global skills that this token CANNOT install (gateway forwards org/personal scopes only)`
          : `HTTP ${err.status} ${err.type ?? ''} installing a [${target.scope}] skill — ${err.message}`,
        { scope: target.scope, status: err.status, type: err.type, byScope },
      )
      return
    }
    const back = await zc.listAgentSkills(agentId)
    record(
      'listAgentSkills (readback)',
      back.some((s) => s.skill_id === target.skill_id || s.name === target.name) ? 'WORKS' : 'DIFFERS',
      `${back.length} attached; the freshly installed skill is ${back.some((s) => s.skill_id === target.skill_id || s.name === target.name) ? 'visible' : 'NOT visible'}`,
      back.slice(0, 5),
    )
    await zc.deleteAgentSkill(agentId, target.skill_id)
    const afterDelete = await zc.listAgentSkills(agentId)
    record('deleteAgentSkill', 'WORKS', `uninstalled; ${afterDelete.length} skills remain`, { count: afterDelete.length })
  })

  await probe('listAgentSkills (independent of install)', async () => {
    const attached = await zc.listAgentSkills(agentId)
    const scopes = attached.reduce<Record<string, number>>((acc, s) => {
      acc[s.scope ?? '?'] = (acc[s.scope ?? '?'] ?? 0) + 1
      return acc
    }, {})
    record(
      'listAgentSkills (independent of install)',
      'WORKS',
      `${attached.length} skills attached by default: ${JSON.stringify(scopes)}`,
      { count: attached.length, scopes, names: attached.map((s) => s.name).slice(0, 30) },
    )
  })

  // ── 4. a normal turn, then the session read surfaces ────────────────────────
  const session = await zc.createSession(agentId, {
    metadata: { source: 'sdk-capability-probe' },
    initial_events: [{ type: 'user.message', content: 'Reply with exactly: PROBE-ONE. Nothing else.' }],
  })
  console.log(`\nsession: ${session.session_id}`)
  const turn1 = await runTurn(agentId, session.session_id)
  console.log(`turn 1: ${turn1.outcome}, ${turn1.events} events, reply=${JSON.stringify(turn1.text.trim().slice(0, 80))}`)
  record(
    'sessions work while actual_state=activating',
    turn1.outcome === 'succeeded' ? 'WORKS' : 'BROKEN',
    `a full turn completed (${turn1.outcome}) on an agent that never reports actual_state=active — confirms desired_state is the only gate that matters`,
    { outcome: turn1.outcome, events: turn1.events },
  )

  await probe('getSession (no history)', async () => {
    const s = await zc.getSession(agentId, session.session_id)
    record(
      'getSession (no history)',
      'WORKS',
      `status=${s.status} session_key=${s.session_key} keys=[${Object.keys(s).join(', ')}]`,
      s,
    )
  })

  await probe('getSession({history:true})', async () => {
    const s = await zc.getSession(agentId, session.session_id, { history: true, limit: 20 })
    const h = s.history ?? []
    const kinds = [...new Set(h.map((e) => e.entry_type))]
    record(
      'getSession({history:true})',
      Array.isArray(s.history) ? 'WORKS' : 'BROKEN',
      `${h.length} entries, entry_type=[${kinds.join(', ')}], first entry keys=[${Object.keys(h[0]?.entry ?? {}).join(', ')}]`,
      { count: h.length, kinds, sample: h.slice(0, 3) },
    )
  })

  // ── 5. user.interrupt with no run in flight ─────────────────────────────────
  await probe('user.interrupt (no run in flight)', async () => {
    const r = await zc.postEvents(agentId, session.session_id, [{ type: 'user.interrupt' }])
    const accepted = r.events[0]?.accepted
    record(
      'user.interrupt (no run in flight)',
      accepted === false ? 'WORKS' : 'DIFFERS',
      `HTTP 202 with accepted=${accepted} — ${accepted === false ? 'a no-op, not an error (as documented)' : 'unexpectedly accepted'}`,
      r,
    )
  })

  // ── 6. system.message: accepted, and does the model actually see it? ────────
  await probe('system.message', async () => {
    const secret = 'Zephyrine Quillsworth'
    const r = await zc.postEvents(agentId, session.session_id, [
      { type: 'system.message', text: `Operator note: the user's display name is ${secret}. Use it if asked.` },
    ])
    record('system.message (accepted)', r.events[0]?.accepted ? 'WORKS' : 'BROKEN', `accepted=${r.events[0]?.accepted}`, r)

    const before = turn1.lastSeq
    await zc.postEvents(agentId, session.session_id, [
      { type: 'user.message', content: 'What is my display name? Answer with the name only.' },
    ])
    const turn2 = await runTurn(agentId, session.session_id, { after: before })
    const sawIt = turn2.text.includes('Zephyrine')
    record(
      'system.message reaches the model',
      sawIt ? 'WORKS' : 'DIFFERS',
      sawIt
        ? 'the note was in context on the next turn'
        : `the next turn did not use it — reply=${JSON.stringify(turn2.text.trim().slice(0, 120))}`,
      { outcome: turn2.outcome, reply: turn2.text.trim().slice(0, 300) },
    )
  })

  // ── 7. user.interrupt against a live run ────────────────────────────────────
  await probe('user.interrupt (live run)', async () => {
    const s2 = await zc.createSession(agentId, {
      initial_events: [
        {
          type: 'user.message',
          content: 'Write a detailed 2000-word essay on the history of the printing press. Do not stop early.',
        },
      ],
    })
    let sent = false
    let accepted: boolean | undefined
    const t0 = Date.now()
    const result = await runTurn(agentId, s2.session_id, {
      budgetMs: 180_000,
      onEvent: (ev) => {
        // Fire once the run is demonstrably in flight, not merely created.
        if (sent || !ev.eventType.startsWith('agent.')) return
        sent = true
        void zc
          .postEvents(agentId, s2.session_id, [{ type: 'user.interrupt' }])
          .then((r) => {
            accepted = r.events[0]?.accepted
          })
          .catch(() => {
            accepted = undefined
          })
      },
    })
    record(
      'user.interrupt (live run)',
      result.outcome === 'aborted' ? 'WORKS' : 'DIFFERS',
      `accepted=${accepted}, run.finished status=${result.outcome} after ${Date.now() - t0}ms — ${
        result.outcome === 'aborted' ? 'interrupt aborts the run' : `expected aborted, got ${result.outcome}`
      }`,
      { accepted, outcome: result.outcome, events: result.events },
    )
  })

  // ── 8. stopAgent, and what it does to session creation ──────────────────────
  await probe('stopAgent', async () => {
    const { warnings } = await zc.stopAgent(agentId)
    const a = await zc.getAgent(agentId)
    record(
      'stopAgent',
      a.status?.desired_state === 'stopped' ? 'WORKS' : 'DIFFERS',
      `desired=${a.status?.desired_state} actual=${a.status?.actual_state} warnings=${JSON.stringify(warnings)}`,
      { warnings, status: a.status },
    )
  })

  await probe('createSession on a stopped agent', async () => {
    try {
      await zc.createSession(agentId, { initial_events: [{ type: 'user.message', content: 'hello' }] })
      record('createSession on a stopped agent', 'DIFFERS', 'succeeded — no running-agent precondition after all')
    } catch (e) {
      const err = e as ZooworkError
      record(
        'createSession on a stopped agent',
        err.status === 409 && err.type === 'agent_not_running' ? 'WORKS' : 'DIFFERS',
        `HTTP ${err.status} ${err.type ?? ''} — ${err.message}`,
        { status: err.status, type: err.type, message: err.message },
      )
    }
  })
} finally {
  // ── cleanup ─────────────────────────────────────────────────────────────────
  if (agentId && process.env.PROBE_KEEP !== '1') {
    try {
      await zc.deleteAgent(agentId)
      console.log(`\ncleaned up agent ${agentId}`)
    } catch (e) {
      console.log(`\ncleanup FAILED for agent ${agentId}: ${(e as Error).message}`)
    }
  } else if (agentId) {
    console.log(`\nPROBE_KEEP=1 — agent ${agentId} left running`)
  }

  console.log(`\n${'='.repeat(72)}\n`)
  for (const p of report) {
    console.log(`${p.verdict.padEnd(7)} | ${p.id.padEnd(38)} | ${p.note}`)
  }

  const out = process.env.PROBE_OUT ?? 'probe-report.json'
  const fs = await import('node:fs/promises')
  await fs.writeFile(out, JSON.stringify({ baseUrl, agentId, at: stamp, report }, null, 2))
  console.log(`\nfull record → ${out}`)
}
