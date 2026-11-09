import { TextareaRenderable } from '@opentui/core'
import type { CliRenderer, KeyEvent } from '@opentui/core'
import { droppedFilesNow } from './attachments-core.ts'

// IDE terminals send dropped paths with sendText, without a bracketed-paste event.
// Recognize only a newly inserted, file-only burst; leave the existing question intact.
export function insertedFiles(before: string, after: string) {
  if (after.length <= before.length || after.length > 131072) return
  let start = 0
  while (start < before.length && before[start] === after[start]) start++
  let oldEnd = before.length, end = after.length
  while (oldEnd > start && before[oldEnd - 1] === after[end - 1]) { oldEnd--; end-- }
  if (oldEnd !== start) return
  const fragment = after.slice(start, end), paths = droppedFilesNow(fragment)
  return paths.length ? { start, end, fragment, paths } : undefined
}

type Prompt = { sessionID?: string; mode: 'normal' | 'shell' }
type Burst = { editor: TextareaRenderable; before: string; sessionID?: string }
export type PromptDraft = {text:string;cursor:number}

export function registerIDEDrops(options: {
  renderer: CliRenderer
  prompt: () => Prompt | undefined
  stage: (paths: string[], sessionID?: string, draft?:PromptDraft) => Promise<void>
  error: (error: unknown) => void
  submit?: () => Promise<void>
  waiting?: () => boolean
  isComposer?: (editor:TextareaRenderable) => boolean
}) {
  let burst: Burst | undefined, timer: ReturnType<typeof setTimeout> | undefined, disposed = false
  const jobs = new Set<Promise<void>>()
  const clearTimer = () => { if (timer) clearTimeout(timer); timer = undefined }
  const candidate = () => {
    const state = options.prompt(), value = burst
    if (!value || state?.mode !== 'normal' || state.sessionID !== value.sessionID ||
        value.editor.isDestroyed || options.renderer.currentFocusedRenderable !== value.editor ||
        options.isComposer&&!options.isComposer(value.editor)) return
    const inserted = insertedFiles(value.before, value.editor.plainText)
    return inserted ? { ...value, ...inserted } : undefined
  }
  const flush = async () => {
    clearTimer()
    const drop = candidate(); burst = undefined
    if (drop && !disposed) {
      const job = (async () => {
        const original=drop.editor.plainText,metrics=drop.editor.editBuffer
        const startOffset=metrics.measureText(original.slice(0,drop.start)),endOffset=metrics.measureText(original.slice(0,drop.end))
        const oldCursor=drop.editor.cursorOffset
        await options.stage(drop.paths, drop.sessionID,{text:original.slice(0,drop.start)+original.slice(drop.end),
          cursor:oldCursor>=endOffset?oldCursor-(endOffset-startOffset):Math.min(oldCursor,startOffset)})
        if (disposed || drop.editor.isDestroyed || options.renderer.currentFocusedRenderable !== drop.editor) return
        const text = drop.editor.plainText
        // Keep later typing, and never remove text that the user has edited while files were being staged.
        if (!text.startsWith(drop.before.slice(0, drop.start)) || text.slice(drop.start, drop.end) !== drop.fragment) return
        const buffer = drop.editor.editBuffer
        const start = buffer.measureText(text.slice(0, drop.start)), end = buffer.measureText(text.slice(0, drop.end))
        const from = buffer.offsetToPosition(start), to = buffer.offsetToPosition(end)
        if (!from || !to) return
        const cursor = drop.editor.cursorOffset
        drop.editor.deleteRange(from.row, from.col, to.row, to.col)
        drop.editor.cursorOffset = cursor >= end ? cursor - (end - start) : Math.min(cursor, start)
        if (burst?.editor === drop.editor && burst.before.slice(drop.start, drop.end) === drop.fragment) {
          burst.before = burst.before.slice(0, drop.start) + burst.before.slice(drop.end)
        }
      })()
      jobs.add(job)
      try { await job } finally { jobs.delete(job) }
    }
    await Promise.all([...jobs])
  }
  const onKey = (event: KeyEvent) => {
    if (event.eventType === 'release') return
    const state = options.prompt(), editor = options.renderer.currentFocusedRenderable
    if (disposed || state?.mode !== 'normal' || !(editor instanceof TextareaRenderable) ||
        options.isComposer&&!options.isComposer(editor)) {
      clearTimer(); burst = undefined; return
    }
    if (['return','enter'].includes(event.name)) {
      if (!event.ctrl && !event.meta && !event.super && !event.shift && options.submit &&
          (candidate() || jobs.size || options.waiting?.())) {
        event.preventDefault(); event.stopPropagation()
        void options.submit().catch(options.error)
      }
      return
    }
    if (event.ctrl || event.meta || event.super || event.option || ['escape','tab','up','down','left','right','backspace','delete'].includes(event.name)) {
      clearTimer(); burst = undefined; return
    }
    if (!burst || burst.editor !== editor || burst.sessionID !== state.sessionID) {
      burst = { editor, before: editor.plainText, sessionID: state.sessionID }
    }
    clearTimer()
    timer = setTimeout(() => { void flush().catch(options.error) }, 120)
  }
  options.renderer.keyInput.prependListener('keypress', onKey)
  return {
    pending: () => Boolean(candidate() || jobs.size), flush,
    dispose: () => { disposed = true; clearTimer(); burst = undefined; options.renderer.keyInput.removeListener('keypress', onKey) },
  }
}
