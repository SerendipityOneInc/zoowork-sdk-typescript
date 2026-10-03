/** Fixture safety only; authentication treats keys as opaque values. */
export function redactApiKeys(text: string, knownKey?: string): string {
  let clean = text
  if (knownKey && knownKey.length >= 8) clean = clean.split(knownKey).join('REDACTED')
  return clean
    .replace(/zwp_live_[A-Za-z0-9_-]{8,}/g, 'zwp_live_REDACTED')
    .replace(/zct_[A-Za-z0-9_-]{8,}/g, 'zct_REDACTED')
    .replace(/(Bearer )[A-Za-z0-9._~+/-]{8,}=*/g, '$1REDACTED')
}
