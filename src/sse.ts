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

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const raw = buf.slice(0, i)
      buf = buf.slice(i + 1)
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
      if (line === '') {
        const m = flush()
        if (m) yield m
        continue
      }
      if (line.startsWith(':')) continue
      const c = line.indexOf(':')
      const field = c === -1 ? line : line.slice(0, c)
      const val = c === -1 ? '' : line.slice(c + 1).replace(/^ /, '')
      if (field === 'event') event = val
      else if (field === 'data') dataLines.push(val)
      else if (field === 'id') id = val
    }
  }
  const m = flush()
  if (m) yield m
}
