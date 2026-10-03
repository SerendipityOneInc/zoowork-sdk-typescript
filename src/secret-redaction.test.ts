import { expect, test } from 'vitest'
import { redactApiKeys } from './secret-redaction.js'

test('fixtures redact both key namespaces even when echoed inside JSON text', () => {
  expect(redactApiKeys('{"old":"zct_synthetic123","new":"zwp_live_synthetic456"}'))
    .toBe('{"old":"zct_REDACTED","new":"zwp_live_REDACTED"}')
  expect(redactApiKeys('Bearer synthetic123456')).toBe('Bearer REDACTED')
  expect(redactApiKeys('custom-synthetic-key', 'custom-synthetic-key')).toBe('REDACTED')
  expect(redactApiKeys('agt_public')).toBe('agt_public')
})
