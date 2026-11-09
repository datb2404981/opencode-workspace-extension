import { Plugin } from '@opencode/plugin/tui'
import { MarkdownRenderable } from '@opentui/core'
import path from 'node:path'
import os from 'node:os'
import { realpath, stat, readdir } from 'node:fs/promises'
import { ROOT_KEY, resolveFolder, folderPermissions, folderSnapshot, mainAgent } from './workspace-core.ts'
import type { Context } from '@opencode/plugin/tui/context'
import { registerAttachmentUI, macFilePicker } from './attachments-ui.ts'
import { registerCompactionCards } from './compaction-view.ts'

type RecentSession = { id: string; directory: string; title: string; time?: { updated?: number }; parentID?: string; metadata?: Record<string, unknown> }

async function recentSessions(context: Context): Promise<RecentSession[]> {
  // Keep more project roots visible for users with many chats per project.
  const result = await context.client.session.list({ limit: 1000 }) as any
  if (result?.error) throw new Error('Không tải được lịch sử chat dự án')
  const sessions = Array.isArray(result) ? result : result?.data
  if (!Array.isArray(sessions)) throw new Error('Dữ liệu lịch sử chat không hợp lệ')
  return sessions.filter((s: RecentSession) => !s.parentID && (typeof s.directory === 'string' || typeof s.metadata?.[ROOT_KEY] === 'string'))
    .sort((a: RecentSession, b: RecentSession) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
}

async function checkDirectory(folder: string) {
  const target = await realpath(folder)
  if (!(await stat(target)).isDirectory()) throw new Error('Đường dẫn phải là folder')
  return target
}

async function pickProject(context: Context, input?: string): Promise<{ folder: string; sessionID?: string } | undefined> {
  if (input?.trim()) {
    const route = context.ui.router.current()
    const current = route.type === 'session' ? context.data.session.get(route.sessionID) : undefined
    const base = current?.location.directory ?? context.location?.directory ?? os.homedir()
    return { folder: await checkDirectory(resolveFolder(input, base)) }
  }
  let sessions: RecentSession[] = []
  try { sessions = await recentSessions(context) }
  catch (error: any) { context.ui.toast.show({ message: error.message, variant: 'warning' }) }
  const groups = new Map<string, RecentSession[]>()
  for (const session of sessions) {
    const raw = typeof session.metadata?.[ROOT_KEY] === 'string' ? session.metadata[ROOT_KEY] as string : session.directory
    const folder = path.normalize(raw).normalize('NFC')
    const list = groups.get(folder) ?? []
    list.push(session)
    groups.set(folder, list)
  }
  type Action = { kind: 'recent' | 'browse' | 'path'; folder?: string }
  const choice = await context.ui.dialog.select<Action>({
    title: 'Dự án và hội thoại', placeholder: 'Tìm theo tên hoặc đường dẫn dự án…',
    options: [
      ...Array.from(groups.entries()).map(([folder, list]) => ({
        title: path.basename(folder) + ' · ' + list.length + ' chat', description: folder,
        value: { kind: 'recent', folder } as Action,
      })),
      { title: 'Chọn thư mục khác trong Finder…', value: { kind: 'browse' } },
      { title: 'Nhập đường dẫn thư mục…', value: { kind: 'path' } },
    ],
  })
  if (!choice) return undefined
  if (choice.kind === 'browse') {
    const folder = await selectFolder(context)
    return folder ? { folder } : undefined
  }
  if (choice.kind === 'path') {
    const entered = await context.ui.dialog.prompt({ title: 'Đường dẫn folder dự án', value: context.location?.directory ?? os.homedir() })
    if (!entered?.trim()) return undefined
    return { folder: await checkDirectory(resolveFolder(entered, context.location?.directory ?? os.homedir())) }
  }
  const folder = choice.folder!
  let checkedFolder: string
  try { checkedFolder = await checkDirectory(folder) }
  catch { context.ui.toast.show({ message: 'Folder không còn tồn tại hoặc không thể truy cập: ' + folder, variant: 'error' }); return undefined }
  const chats = groups.get(folder) ?? []
  type ChatAction = { kind: 'resume' | 'new'; id?: string }
  const selected = await context.ui.dialog.select<ChatAction>({
    title: path.basename(folder) + ' · chọn hội thoại', placeholder: 'Tìm hội thoại…',
    options: [
      ...chats.map(s => ({ title: s.title || 'Chat chưa đặt tên',
        description: s.time?.updated ? new Date(s.time.updated).toLocaleString('vi-VN') : s.id,
        value: { kind: 'resume', id: s.id } as ChatAction })),
      { title: '+ Tạo hội thoại mới trong dự án này', description: folder, value: { kind: 'new' } },
    ],
  })
  if (!selected) return undefined
  return { folder: checkedFolder, ...(selected.kind === 'resume' ? { sessionID: selected.id } : {}) }
}

export async function selectFolder(context: Context, input?: string) {
  const route = context.ui.router.current()
  const session = route.type === 'session' ? context.data.session.get(route.sessionID) : undefined
  let folder = session?.location.directory ?? context.location?.directory ?? os.homedir()
  if (input?.trim()) {
    folder = await realpath(resolveFolder(input, folder))
    if (!(await stat(folder)).isDirectory()) throw new Error('Đường dẫn phải là folder')
    return folder
  }
  if (process.platform === 'darwin') {
    try {
      const selected = await macFilePicker(folder, 'project')
      if (!selected.length) return undefined
      const target = await realpath(selected[0])
      if (!(await stat(target)).isDirectory()) throw new Error('Đây không phải folder')
      return target
    } catch (error: any) {
      context.ui.toast.show({ message: 'Không mở được bộ chọn macOS; chuyển sang duyệt folder trong terminal: ' + error.message, variant: 'warning' })
    }
  }
  type Choice = { kind: 'open' | 'browse' | 'path'; path?: string }
  for (;;) {
    try { folder = await checkDirectory(folder) }
    catch (error: any) {
      context.ui.toast.show({ message: 'Không truy cập được folder: ' + error.message, variant: 'error' })
      folder = os.homedir()
      continue
    }
    let dirs: string[] = []
    try {
      const entries = await readdir(folder, { withFileTypes: true })
      const eligible = await Promise.all(entries.filter(d => !d.name.startsWith('.')).map(async d => {
        if (d.isDirectory()) return d.name
        if (!d.isSymbolicLink()) return undefined
        try { return (await stat(path.join(folder, d.name))).isDirectory() ? d.name : undefined }
        catch { return undefined }
      }))
      dirs = eligible.filter((name): name is string => Boolean(name)).sort((a, b) => a.localeCompare(b, 'vi'))
    } catch (error: any) {
      context.ui.toast.show({ message: 'Không đọc được danh sách thư mục: ' + error.message, variant: 'warning' })
    }
    const choice = await context.ui.dialog.select<Choice>({
      title: 'Chọn folder dự án', placeholder: 'Tìm folder con…',
      options: [
        { title: 'Mở folder này làm dự án', description: folder, value: { kind: 'open', path: folder } },
        { title: 'Nhập hoặc dán đường dẫn…', value: { kind: 'path' } },
        ...(path.dirname(folder) !== folder ? [{ title: '↑ Thư mục cha', description: path.dirname(folder), value: { kind: 'browse', path: path.dirname(folder) } as Choice }] : []),
        ...dirs.map(name => ({ title: name + '/', value: { kind: 'browse', path: path.join(folder, name) } as Choice })),
      ],
    })
    if (!choice) return undefined
    if (choice.kind === 'open') return folder
    if (choice.kind === 'browse') { folder = choice.path!; continue }
    const entered = await context.ui.dialog.prompt({ title: 'Đường dẫn folder dự án', value: folder })
    if (entered === undefined) continue
    try {
      const target = await realpath(resolveFolder(entered, folder))
      if (!(await stat(target)).isDirectory()) throw new Error('Đây không phải folder')
      folder = target
    } catch (error: any) { context.ui.toast.show({ message: error.message, variant: 'error' }) }
  }
}

export async function openProject(context: Context, input?: string, navigationBlocker?: () => string | undefined) {
  const selected = await pickProject(context, input)
  if (!selected) return
  const { folder } = selected
  const route = context.ui.router.current()
  if (selected.sessionID && route.type === 'session' && route.sessionID === selected.sessionID) return
  // Do not discard unsubmitted editor text when navigating away from a chat.
  const reason = navigationBlocker?.()
  if (reason) {
    context.ui.toast.show({ message: reason, variant: 'warning' })
    return
  }
  if (selected.sessionID) {
    await context.data.session.sync(selected.sessionID)
    if (context.ui.tabs.enabled()) context.ui.tabs.focus(selected.sessionID)
    context.ui.router.navigate({ type: 'session', sessionID: selected.sessionID })
    context.ui.toast.show({ message: 'Đã tiếp tục hội thoại: ' + path.basename(folder), variant: 'success' })
    return
  }
  const current = route.type === 'session' ? context.data.session.get(route.sessionID) : undefined
  let model = current?.model
  if (model?.providerID === 'ollama' && model.id === 'qwen3.5:9b-fast') model = { ...model, id: 'qwen3.5:9b' }
  const created = await context.client.session.create({
    agent: mainAgent(current?.agent), ...(model ? { model } : {}),
    title: path.basename(folder) + ' · dự án',
    location: { directory: folder },
    metadata: { [ROOT_KEY]: folder }, permissions: folderPermissions(folder),
  })
  try {
    await context.client.session.synthetic({ sessionID: created.id,
      text: await folderSnapshot(folder), description: 'Folder dự án đã chọn', resume: false })
  } catch { context.ui.toast.show({ message: 'Đã mở folder; chưa nạp được danh sách file ban đầu.', variant: 'warning' }) }
  await context.data.session.sync(created.id)
  if (context.ui.tabs.enabled()) context.ui.tabs.focus(created.id)
  context.ui.router.navigate({ type: 'session', sessionID: created.id })
  context.ui.toast.show({ message: 'Đã mở dự án: ' + path.basename(folder) + ' · giới hạn trong folder', variant: 'success' })
}

export default Plugin.define({
  id: 'local.project-workspace',
  setup(context) {
    const attachments=registerAttachmentUI(context)
    const compactions=registerCompactionCards(context,MarkdownRenderable)
    context.keymap.layer(() => ({
      mode: 'global', priority: 10,
      commands: [{ id: 'local.project.open', title: 'Chọn folder làm dự án', group: 'Dự án',
        palette: true, slash: { name: 'du-an', aliases: ['folder'], arguments: true },
        bind: 'ctrl+alt+o',
        run: async input => { try { await openProject(context, input, attachments.navigationBlocker) }
          catch (error: any) { context.ui.toast.show({ message: error.message, variant: 'error' }) } },
      }], bindings: ['local.project.open'],
    }))
    return ()=>{compactions();attachments.dispose()}
  },
})
