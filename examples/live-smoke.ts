/**
 * Live smoke test. Not a unit test — it drives a real agent through a real turn.
 *
 *   ZOOCLAW_API_KEY=zct_... AGENT_ID=agt_... pnpm exec tsx examples/live-smoke.ts
 *
 * Set ZOOCLAW_API_KEY and AGENT_ID; nothing else is required. The base URL defaults to
 * the public API.
 */
import {
  createZooclawClient,
  assistantText,
  thinkingText,
  toolCall,
  isRunFinished,
  runOutcome,
} from '../src/index.js'

const need = (n: string): string => {
  const v = process.env[n]
  if (!v) throw new Error(`missing env ${n}`)
  return v
}

// apiKey and baseUrl both resolve from the environment / the built-in default.
const zc = createZooclawClient()

const agentId = need('AGENT_ID')

const models = await zc.listModels()
console.log(`models: ${models.length}, e.g. ${models[0]?.model}`)

const agent = await zc.getAgent(agentId)
console.log(`agent: ${agentId} desired=${agent.status?.desired_state} actual=${agent.status?.actual_state}`)

const session = await zc.createSession(agentId, {
  metadata: { source: 'sdk-live-smoke' },
  initial_events: [{ type: 'user.message', content: 'In one sentence, what can you do?' }],
})
console.log(`session: ${session.session_id}`)

// Stream until the run finishes, or the window budget runs out.
const ctl = new AbortController()
const budget = setTimeout(() => ctl.abort(), 90_000)
let outcome: string | undefined
let text = ''

for await (const ev of zc.streamEvents(agentId, session.session_id, { signal: ctl.signal })) {
  const think = thinkingText(ev)
  const tool = toolCall(ev)
  if (think) console.log(`  [${ev.seq}] thinking: ${think.slice(0, 60)}…`)
  else if (tool) console.log(`  [${ev.seq}] tool ${tool.toolName} ${tool.phase}${tool.isError ? ' (error)' : ''}`)
  else console.log(`  [${ev.seq}] ${ev.eventType}`)

  text += assistantText(ev)
  if (isRunFinished(ev)) {
    outcome = runOutcome(ev)
    break
  }
}
clearTimeout(budget)
ctl.abort()

console.log(`\nrun: ${outcome}`)
console.log(`reply: ${text.trim()}`)

// Re-read the same events over REST to prove both wire shapes normalize identically.
const durable = await zc.listEvents(agentId, session.session_id)
const restText = durable.map(assistantText).join('').trim()
console.log(`\nREST replay: ${durable.length} events, text matches stream: ${restText === text.trim()}`)

if (outcome !== 'succeeded') process.exitCode = 1
if (restText !== text.trim()) process.exitCode = 1
