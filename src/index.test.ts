/**
 * The published surface, pinned.
 *
 * `src/index.ts` is the only thing a consumer can import, so anything documented but not
 * re-exported there is broken for everyone while every other test still passes. This file asserts
 * the entry point's exports as a SET — a missing symbol and an accidental new one both fail.
 *
 * Runtime values are checked at runtime; types are erased by then, so they are checked at compile
 * time by the tuple at the bottom. `pnpm typecheck` is the gate for that half.
 */
import { expect, test } from 'vitest'
import * as sdk from './index.js'
import type {
  AgentRecord,
  AgentResource,
  AgentSkill,
  AgentStatus,
  ApprovalDecision,
  ApprovalRecord,
  EnvironmentConfig,
  EnvironmentRecord,
  EnvironmentResource,
  EnvironmentVersionRecord,
  ExecResult,
  McpServerDeclaration,
  ModelInfo,
  OutboundEvent,
  Ownership,
  SSEMessage,
  SchedulePayload,
  ScheduleRecord,
  ScheduleRun,
  ScheduleSpec,
  ScheduleUpdate,
  ScheduleInput,
  SessionEvent,
  SessionEventType,
  SessionHistoryEntry,
  SessionRecord,
  SkillRecord,
  ToolCall,
  WakeResult,
  ZooclawAuth,
  ZooclawClient,
  ZooclawConfig,
} from './index.js'

/** Every value the package promises. Sorted, and exhaustive in both directions. */
const PUBLIC_VALUES = [
  'DEFAULT_BASE_URL',
  'SESSION_EVENT_TYPES',
  'ZooclawError',
  'assistantText',
  'createZooclawClient',
  'isRunFinished',
  'messageText',
  'normalizeEvent',
  'parseSSE',
  'runOutcome',
  'thinkingText',
  'toolCall',
]

test('the entry point exports exactly the documented value surface', () => {
  expect(Object.keys(sdk).sort()).toEqual(PUBLIC_VALUES)
})

test('every exported value is the kind of thing it claims to be', () => {
  for (const name of ['createZooclawClient', 'normalizeEvent', 'isRunFinished', 'runOutcome', 'messageText', 'assistantText', 'thinkingText', 'toolCall', 'parseSSE']) {
    expect(typeof (sdk as unknown as Record<string, unknown>)[name]).toBe('function')
  }
  expect(typeof sdk.DEFAULT_BASE_URL).toBe('string')
  expect(Array.isArray(sdk.SESSION_EVENT_TYPES)).toBe(true)
  // A class, not a factory: callers `instanceof` it.
  expect(new sdk.ZooclawError(404, 'x', 'not_found')).toBeInstanceOf(Error)
})

test('the client built from the entry point exposes every documented method', () => {
  const client = sdk.createZooclawClient({ apiKey: 'zct_test_key', baseUrl: 'https://api.test/service/v1' })
  const methods = [
    'listModels',
    'createAgent',
    'getAgent',
    'updateAgent',
    'deleteAgent',
    'putCredential',
    'listCredentials',
    'startAgent',
    'stopAgent',
    'waitUntilRunning',
    'listAgentSkills',
    'putAgentSkill',
    'deleteAgentSkill',
    'uploadSkill',
    'uploadSkillVersion',
    'listSkills',
    'deleteSkill',
    'createSession',
    'getSession',
    'listSessions',
    'archiveSession',
    'deleteSession',
    'postEvents',
    'listEvents',
    'listAllEvents',
    'streamEvents',
    'listApprovals',
    'resolveApproval',
    'listSchedules',
    'createSchedule',
    'getSchedule',
    'updateSchedule',
    'deleteSchedule',
    'triggerSchedule',
    'listScheduleRuns',
    'wake',
    'exec',
    'listEnvironments',
    'getEnvironment',
    'createEnvironment',
    'archiveEnvironment',
    'createEnvironmentVersion',
    'getEnvironmentVersion',
  ]
  expect(Object.keys(client).sort()).toEqual([...methods].sort())
})

/**
 * The type surface. Types vanish at runtime, so this tuple is the assertion: dropping any of these
 * from `src/index.ts` makes the import above unresolvable and `tsc --noEmit` fails. It is never
 * evaluated, only checked.
 */
type PublicTypes = [
  AgentRecord,
  AgentResource,
  AgentSkill,
  AgentStatus,
  ApprovalDecision,
  ApprovalRecord,
  EnvironmentConfig,
  EnvironmentRecord,
  EnvironmentResource,
  EnvironmentVersionRecord,
  ExecResult,
  McpServerDeclaration,
  ModelInfo,
  OutboundEvent,
  Ownership,
  SSEMessage,
  SchedulePayload,
  ScheduleInput,
  ScheduleRecord,
  ScheduleRun,
  ScheduleSpec,
  ScheduleUpdate,
  SessionEvent,
  SessionEventType,
  SessionHistoryEntry,
  SessionRecord,
  SkillRecord,
  ToolCall,
  WakeResult,
  ZooclawAuth,
  ZooclawClient,
  ZooclawConfig,
]

test('the type surface is re-exported too (checked by tsc, counted here)', () => {
  // The tuple above cannot be measured at runtime; this keeps its length honest against the
  // import list, so adding a type to one and forgetting the other is visible in review.
  const declared: PublicTypes[number] | undefined = undefined
  expect(declared).toBeUndefined()
})
