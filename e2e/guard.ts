import { mkdirSync, lstatSync, realpathSync, readFileSync, readdirSync, writeFileSync, renameSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export class CheckError extends Error {
  readonly code: string
  constructor(code: string) { super(code); this.code = code }
}
export function check(value: unknown, code: string): asserts value {
  if (!value) throw new CheckError(code)
}
export function safeFailure(error: unknown): { kind: string; http_status?: number } {
  if (error instanceof CheckError) return { kind: error.code }
  const status = (error as { status?: unknown } | null)?.status
  if (Number.isInteger(status) && Number(status) >= 100 && Number(status) <= 599) return { kind: 'http_failure', http_status: Number(status) }
  if ((error as Error | null)?.name === 'AbortError' || (error as Error | null)?.name === 'TimeoutError') return { kind: 'timeout_or_cancelled' }
  return { kind: 'request_or_runner_failure' }
}
export function baseURL(value: string, production: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new CheckError('explicit_staging_url_required') }
  check(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash,
    'staging_url_must_be_plain_https')
  check(url.pathname.replace(/\/$/, '') === '/service/v1', 'staging_public_api_prefix_required')
  check(url.origin !== new URL(production).origin, 'production_endpoint_refused')
  return url.origin + '/service/v1'
}
export function guardedFetch(base: string, signal: () => AbortSignal, transport: typeof fetch = fetch,
  cleanup: () => boolean = () => false) {
  const expected = new URL(base)
  let calls = 0
  let cleanupCalls = 0
  return async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input)
    check(url.origin === expected.origin && url.pathname.startsWith(expected.pathname + '/')
      && !url.username && !url.password && !url.hash, 'out_of_scope_request_refused')
    // Main-loop exhaustion must not consume the independent cleanup reserve.
    check(cleanup() ? ++cleanupCalls <= 12 : ++calls <= 80, 'request_budget_exceeded')
    const streaming = new Headers(init.headers).get('accept')?.includes('text/event-stream')
    return transport(input, { ...init, redirect: 'error', signal: AbortSignal.any([
      signal(), AbortSignal.timeout(streaming ? 120_000 : 30_000), ...(init.signal ? [init.signal] : []),
    ]) })
  }
}
export function privateDir(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  check(!lstatSync(path).isSymbolicLink() && (lstatSync(path).mode & 0o077) === 0, 'private_directory_required')
  return realpathSync(path)
}
export function readJSON<T>(path: string): T {
  check(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), 'regular_record_required')
  return JSON.parse(readFileSync(path, 'utf8')) as T
}
export function writeJSON(path: string, data: unknown): void {
  // Only allowlisted structured facts reach disk. Never persist headers, errors, prompts or replies.
  const temp = path + '.tmp'
  writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  renameSync(temp, path)
}
export function hash(data: string | Buffer): string { return createHash('sha256').update(data).digest('hex') }
export function hashTree(path: string): string {
  const digest = createHash('sha256')
  function visit(current: string): void {
    const stat = lstatSync(current)
    check(!stat.isSymbolicLink(), 'symlink_in_candidate_refused')
    if (stat.isDirectory()) for (const name of readdirSync(current).sort()) visit(join(current, name))
    else { check(stat.isFile(), 'non_file_in_candidate'); digest.update(relative(path, current) + '\0').update(readFileSync(current)) }
  }
  visit(path)
  return digest.digest('hex')
}
export function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep))
}
export function explicitOutput(path: string, repo: string): string {
  const dest = resolve(path)
  const parent = realpathSync(dirname(dest))
  const actual = join(parent, relative(dirname(dest), dest))
  check(!inside(actual, repo) && !inside(repo, actual), 'output_must_be_outside_repository')
  return actual
}
