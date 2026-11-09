// Presentation only: never change the stored summary, conversation or tokens.
const headings: Record<string, string> = {
  Objective: '## ◎ Mục tiêu', Requirements: '## ◇ Yêu cầu',
  Decisions: '## ◆ Quyết định', 'Work State': '## Tiến độ',
  Completed: '### ✓ Đã hoàn thành', Active: '### → Đang thực hiện',
  Blocked: '### ! Vướng mắc', 'Next Move': '## → Bước tiếp theo',
  'Relevant Files': '## Tệp liên quan',
  'Important Context': '## Ghi chú', 'Additional Context': '## Ghi chú bổ sung',
}

export function formatCompactionSummary(source: string): string {
  let fence = '', fenceSize = 0
  return source.split('\n').map(line => {
    const ending = line.endsWith('\r') ? '\r' : ''
    const body = ending ? line.slice(0, -1) : line
    const marker = /^\s*(`{3,}|~{3,})/.exec(body)?.[1]
    if (marker) {
      if (!fence) { fence = marker[0]; fenceSize = marker.length }
      else if (marker[0] === fence && marker.length >= fenceSize) fence = ''
      return line
    }
    if (fence) return line
    const title = body.trim().replace(/^#{1,6}\s+/, '').replace(/\*\*/g, '').replace(/:$/, '')
    if (headings[title]) return headings[title] + ending
    return body.replace(/^(\s*(?:[-*]\s+)?)(?:\(none\)|none)\s*$/i, '$1Không có.') + ending
  }).join('\n')
}

export function formatCompactionMetrics(source: string): string {
  return source.replace(/\bin\b/g, 'vào').replace(/\bout\b/g, 'ra')
}

type Node = any
type Change = { node: Node; key: string; before: unknown; after: unknown }
type Card = { root: Node; label: Node; summary: Node; view?: Node; formatted: string; changes: Change[] }
const children = (node: Node): Node[] => node?.getChildren?.() ?? []
const text = (node: Node): string => typeof node?.plainText === 'string' ? node.plainText : ''
const markdown = (node: Node) => typeof node?.content === 'string' && 'renderNode' in node && 'syntaxStyle' in node

function descendants(root: Node, limit = 1200): Node[] {
  const result: Node[] = [], pending = [root]
  while (pending.length && result.length < limit) {
    const node = pending.pop()
    if (!node || node.isDestroyed || node.visible === false) continue
    result.push(node); pending.push(...children(node))
  }
  return result
}

export function createCompactionStyler(theme: () => any, createView: (original: Node, content: string) => Node) {
  const cards = new Map<Node, Card>()
  function restore(card: Card) {
    for (const item of [...card.changes].reverse()) {
      if (!item.node.isDestroyed) {
        try { item.node[item.key] = item.before } catch { /* a host node may already be disposing */ }
      }
    }
  }
  function change(card: Card, node: Node, key: string, value: unknown) {
    if (node[key] === value) return
    const old = card.changes.find(item => item.node === node && item.key === key)
    if (old) old.after = value
    else card.changes.push({ node, key, before: key === 'content' && typeof node.plainText === 'string' ? node.plainText : node[key], after: value })
    node[key] = value
  }
  function discover(label: Node): Card | undefined {
    if (text(label) !== 'Compaction') return
    const center = label.parent, row = center?.parent, root = row?.parent
    // Guard the exact native 2.2 header shape; unrelated Markdown is untouched.
    if (!root || children(row).length !== 3 || children(root)[0] !== row || !children(row).includes(center)) return
    const metrics = children(center).find(child => /\d[\d.,KMBkmb]* in\s*·\s*[\d.,KMBkmb]+ out/.test(text(child)))
    if (!metrics) return // Leave running/failed compaction and its spinner native.
    const summary = children(root).slice(1).flatMap(node => descendants(node, 30)).find(markdown)
    if (!summary || !/^(?:#{1,6}\s+)?(?:Objective|Requirements|Work State)\s*$/m.test(summary.content)) return
    const card: Card = { root, label, summary, formatted: '', changes: [] }
    const colors = theme()
    try {
    change(card, root, 'border', true)
    change(card, root, 'borderStyle', 'rounded')
    change(card, root, 'borderColor', colors.border.base)
    change(card, root, 'backgroundColor', colors.background.raised.base)
    change(card, root, 'paddingLeft', 1); change(card, root, 'paddingRight', 1)
    change(card, root, 'paddingBottom', 1)
    change(card, label, 'content', 'Tóm tắt ngữ cảnh')
    change(card, label, 'fg', colors.text.base)
    change(card, metrics, 'content', formatCompactionMetrics(text(metrics)))
    for (const line of children(row).filter(child => child !== center)) change(card, line, 'border', false)
    for (const body of children(root).slice(1)) change(card, body, 'paddingLeft', 1)
    } catch { restore(card); return }
    cards.set(root, card)
    return card
  }
  function apply(root: Node) {
    for (const [node] of cards) if (node.isDestroyed) cards.delete(node)
    for (const node of descendants(root)) {
      if (cards.size >= 32) break
      if (text(node) === 'Compaction') discover(node)
    }
    for (const card of cards.values()) {
      if (card.summary.isDestroyed) continue
      const formatted = formatCompactionSummary(card.summary.content)
      if (!card.view || card.view.isDestroyed || formatted !== card.formatted) {
        let replacement: Node
        try {
          replacement = createView(card.summary, formatted)
          card.summary.parent.add(replacement)
          if (card.view && !card.view.isDestroyed) card.view.destroyRecursively()
          card.view = replacement
          change(card, card.summary, 'visible', false)
          card.formatted = formatted
        } catch {
          if (replacement && !replacement.isDestroyed) replacement.destroyRecursively()
          if (card.view && !card.view.isDestroyed) card.view.destroyRecursively()
          restore(card); cards.delete(card.root)
        }
      }
    }
  }
  function dispose() {
    for (const card of cards.values()) {
      if (card.view && !card.view.isDestroyed) card.view.destroyRecursively()
      restore(card)
    }
    cards.clear()
  }
  return { apply, dispose }
}

export function registerCompactionCards(context: any, Markdown: new (renderer: any, options: any) => Node) {
  // Native transcript blocks have no public replacement slot in 2.2. Guard the
  // inspected version/layout, and fall back to the native presentation otherwise.
  if (!/^v?2\.2\./.test(context.app.version)) return () => {}
  let sequence = 0
  const styler = createCompactionStyler(() => context.theme, (original, content) => new Markdown(context.renderer, {
    id: 'local-compaction-summary-' + ++sequence, content,
    syntaxStyle: original.syntaxStyle, renderNode: original.renderNode,
    fg: original.fg, bg: context.theme.background.raised.base,
    conceal: original.conceal, streaming: true, internalBlockMode: 'top-level',
    tableOptions: { style: 'grid', cellPaddingX: 1 },
  }))
  const refresh = () => {
    if (context.ui.router.current().type !== 'session') return
    try { styler.apply(context.renderer.root) } catch { /* retain native UI on incompatible shapes */ }
  }
  const initial = setTimeout(refresh, 0)
  const timer = setInterval(refresh, 500)
  return () => { clearTimeout(initial); clearInterval(timer); styler.dispose() }
}
