// Normalize presentation-only <br> in prose, preserving fenced/inline code verbatim.
export function cleanMarkdown(source: string, final = true) {
  let out = '', i = 0, fence = '', fenceSize = 0, inline = 0, atStart = true, indent = 0, indented = false
  while (i < source.length) {
    const char = source[i]
    if (atStart && indent >= 4 && char !== ' ' && char !== '\n') indented = true
    if (char === '\\' && !fence) {
      if (i + 1 === source.length && !final) break
      out += source.slice(i, i + 2); i += 2; atStart = false; continue
    }
    if (char === '`' || char === '~') {
      let end = i + 1
      while (source[end] === char) end++
      if (end === source.length && !final) break
      const size = end - i
      if (atStart && indent <= 3 && size >= 3 && !inline) {
        if (!fence) { fence = char; fenceSize = size }
        else if (fence === char && size >= fenceSize) { fence = ''; fenceSize = 0 }
      } else if (!fence && char === '`') {
        if (!inline) inline = size
        else if (inline === size) inline = 0
      }
      out += source.slice(i, end); i = end; atStart = false; continue
    }
    if (!fence && !inline && !indented && char === '<') {
      const tail = source.slice(i)
      const br = /^<br\s*\/?>/i.exec(tail)
      if (br) { out += '\n'; i += br[0].length; atStart = true; indent = 0; indented = false; continue }
      if (!final && /^<(?:b(?:r(?:\s*\/?)?)?)?$/i.test(tail)) break
    }
    out += char; i++
    if (char === '\n') { atStart = true; indent = 0; indented = false }
    else if (atStart && char === ' ') indent++
    else atStart = false
  }
  return out
}

export function normalizeChatSSE(response: Response) {
  if (!response.body) return response
  const states = new Map<number, { source: string; emitted: string }>()
  let pending = ''
  let last: any = {}
  const finishPending = () => {
    const choices: any[] = []
    for (const [index, state] of states) {
      const final = cleanMarkdown(state.source)
      const addition = final.slice(state.emitted.length)
      if (addition) choices.push({ index, delta: { content: addition }, finish_reason: null })
      state.emitted = final
    }
    return choices.length ? 'data: ' + JSON.stringify({ id: last.id, object: last.object,
      created: last.created, model: last.model, choices }) + '\n\n' : ''
  }
  const convert = (block: string) => {
    const data = block.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n')
    if (!data) return block + '\n\n'
    if (data === '[DONE]') return finishPending() + block + '\n\n'
    let value: any
    try { value = JSON.parse(data) } catch { return block + '\n\n' }
    if (!Array.isArray(value.choices)) return block + '\n\n'
    last = value
    for (const choice of value.choices) {
      const state = states.get(choice.index ?? 0) ?? { source: '', emitted: '' }
      if (typeof choice.delta?.content === 'string') state.source += choice.delta.content
      const cleaned = cleanMarkdown(state.source, choice.finish_reason != null)
      if (!cleaned.startsWith(state.emitted)) throw new Error('Markdown stream prefix changed')
      const addition = cleaned.slice(state.emitted.length)
      if (typeof choice.delta?.content === 'string' || addition) {
        choice.delta ??= {}; choice.delta.content = addition
      }
      state.emitted = cleaned; states.set(choice.index ?? 0, state)
    }
    return 'data: ' + JSON.stringify(value) + '\n\n'
  }
  const text = response.body.pipeThrough(new TextDecoderStream()).pipeThrough(new TransformStream<string, string>({
    transform(chunk, controller) {
      pending += chunk
      for (;;) {
        const match = /\r?\n\r?\n/.exec(pending)
        if (!match) break
        const block = pending.slice(0, match.index)
        pending = pending.slice(match.index + match[0].length)
        controller.enqueue(convert(block))
      }
    },
    flush(controller) {
      if (pending.trim()) controller.enqueue(convert(pending))
      const remaining = finishPending()
      if (remaining) controller.enqueue(remaining)
    },
  })).pipeThrough(new TextEncoderStream())
  const headers = new Headers(response.headers)
  headers.delete('content-length'); headers.delete('content-encoding')
  return new Response(text, { status: response.status, statusText: response.statusText, headers })
}
