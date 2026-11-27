/**
 * SSE line parser for the /events/stream endpoint.
 * Preserve id as an opaque string: unified events use it as a resume cursor, while the
 * legacy lane can send numeric ids. Web Streams + TextDecoder only.
 */

export interface SSEMessage {
  event: string
  /** The SSE id field, unchanged. Do not parse an opaque resume cursor as a number. */
  id?: string
  data: unknown
}

export const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object'

export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEMessage> {
  const reader = body.getReader()
  const dec = new TextDecoder('utf-8')
  let buf = ''
  let skipLF = false
  let event = 'message'
  let id: string | undefined
  let dataLines: string[] = []

  const flush = (): SSEMessage | null => {
    if (!dataLines.length && event === 'message' && id === undefined) return null
    const s = dataLines.join('\n')
    let data: unknown = s
    if (s) {
      try {
        data = JSON.parse(s)
      } catch {
        /* not JSON — keep the raw string */
      }
    }
    const msg: SSEMessage = { event, data, ...(id !== undefined ? { id } : {}) }
    event = 'message'
    id = undefined
    dataLines = []
    return msg
  }

  const readLine = (line: string): SSEMessage | null => {
    if (line === '') return flush()
    if (line.startsWith(':')) return null
    const c = line.indexOf(':')
    const field = c === -1 ? line : line.slice(0, c)
    const val = c === -1 ? '' : line.slice(c + 1).replace(/^ /, '')
    if (field === 'event') event = val
    else if (field === 'data') dataLines.push(val)
    else if (field === 'id' && !val.includes('\0')) id = val
    return null
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      buf += done ? dec.decode() : dec.decode(value, { stream: true })
      while (buf.length > 0) {
        if (skipLF) {
          if (buf.startsWith('\n')) buf = buf.slice(1)
          skipLF = false
        }
        const end = buf.search(/[\r\n]/)
        if (end < 0) break
        const line = buf.slice(0, end)
        skipLF = buf[end] === '\r'
        buf = buf.slice(end + 1)
        const msg = readLine(line)
        if (msg) yield msg
      }
      if (done) break
    }
    if (buf) readLine(buf)
    const m = flush()
    if (m) yield m
  } finally {
    // A session stream outlives each turn. Closing the generator must close its HTTP body.
    try { await reader.cancel() } catch { /* Preserve the original parse/transport failure. */ }
    reader.releaseLock()
  }
}
