import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { realpath, stat, open } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { scanFolder, sensitivePath, attachedFolders, folderAccess, ADMITTED_FOLDERS } from './folder-attachments.ts'

export const PENDING_FILES = 'localPendingAttachments'
export const ATTACHED_IDS = 'localAttachmentIds'
export const MAX_FILES = 32
export const MAX_BYTES = 20 * 1024 * 1024
export type PickedFile = { id: string; path: string; name: string; size: number; kind?: 'folder'; preview?: string; entries?: number; skipped?: number; truncated?: boolean }

function localPath(token: string) {
  if (token.startsWith('file:')) return fileURLToPath(new URL(token))
  if (token.startsWith('~/')) return path.join(os.homedir(), token.slice(2))
  if (!path.isAbsolute(token)) throw new Error('Not a dropped file path')
  return token
}

function existingPath(token: string) {
  try { const info = statSync(localPath(token)); return info.isFile() || info.isDirectory() }
  catch { return false }
}

// Parse Finder's escaped paths and file: URI lists, never shell-evaluate input.
export function parseFilePaths(text: string) {
  const input = text.trim()
  if (!input || input.length > 65536 || input.includes('\0')) return []
  if (existsSync(input) && (statSync(input).isFile()||statSync(input).isDirectory())) return [path.resolve(input)]
  const tokens: string[] = []
  let word = '', quote = '', escape = false
  const source = input.split(/\r?\n/).filter(l => !l.startsWith('#')).join('\n')
  for (let i = 0; i < source.length; i++) {
    const char = source[i]
    if (escape) { word += char; escape = false; continue }
    if (char === '\\' && quote !== "'") { escape = true; continue }
    if (quote) {
      if (char === quote) {
        quote = ''
        // IDE terminals sometimes concatenate separately quoted Finder paths.
        // Split only when both complete paths exist; retain ordinary shell
        // quoting such as '/project/'"file.ts" as one filename.
        const nextQuote = source[i + 1]
        if (nextQuote === "'" || nextQuote === '"') {
          const end = source.indexOf(nextQuote, i + 2)
          if (end > i + 2 && existingPath(word) && existingPath(source.slice(i + 2, end))) {
            tokens.push(word); word = ''
          }
        }
      } else word += char
      continue
    }
    if (char === '"' || char === "'") { quote = char; continue }
    if (/\s/.test(char)) { if (word) tokens.push(word); word = ''; continue }
    word += char
  }
  if (quote || escape) return []
  if (word) tokens.push(word)
  if (!tokens.length || tokens.length > MAX_FILES) return []
  try {
    return tokens.map(localPath)
  } catch { return [] }
}

export function droppedFilesNow(text: string) {
  try {
    const files = parseFilePaths(text)
    // A bare slash opens the command menu. Never turn a filesystem root typed
    // or pasted into the composer into an automatic folder attachment.
    if(files.some(file=>path.dirname(path.resolve(file))===path.resolve(file)))return []
    return files.length && files.every(f => {const s=statSync(f);return s.isFile()||s.isDirectory()}) ? files : []
  } catch { return [] }
}

// Send-time fallback for quoted paths mixed with the user's actual request.
// Preserve that request rather than replacing it with a generic analysis task.
export function droppedFileReferences(text: string) {
  if (!text || text.length > 65536 || text.includes('\0')) return { paths: [] as string[], text }
  const paths: string[] = []
  const rewritten = text.replace(/'(?:\/|~\/|file:)[^'\r\n]+'|"(?:\/|~\/|file:)(?:\\.|[^"\\\r\n])*"/g, quoted => {
    const found = droppedFilesNow(quoted)
    if (found.length !== 1) return quoted
    paths.push(found[0])
    return ' [Tệp đính kèm: ' + path.basename(found[0]) + '] '
  })
  return { paths, text: rewritten }
}

export function pendingFiles(metadata: Record<string, any> | undefined): PickedFile[] {
  const list = metadata?.[PENDING_FILES]
  return Array.isArray(list) ? list.filter(f => f && typeof f.id === 'string' && typeof f.path === 'string' && typeof f.name === 'string' && typeof f.size === 'number') : []
}

export async function validatePickedFiles(paths: string[], existing: PickedFile[] = []) {
  if (!paths.length) return existing
  const files = new Map(existing.map(f => [f.path, f]))
  for (const input of paths) {
    const file = await realpath(input)
    const name = path.basename(file)
    const previous = files.get(file) ?? files.get(input)
    // macOS may resolve /var/... to /private/var/... for the same file.
    // Replace the staged alias instead of attaching both paths.
    if (input !== file) files.delete(input)
    if (sensitivePath(file)) throw new Error('Không đính kèm tệp chứa cấu hình nhạy cảm: ' + name)
    const info = await stat(file)
    if(info.isDirectory()){
      if(path.dirname(file)===file)throw new Error('Hãy chọn folder dự án cụ thể, không đính kèm thư mục gốc /')
      const summary=await scanFolder(file)
      files.set(file,{id:previous?.id??randomUUID(),path:file,name,size:Buffer.byteLength(summary.preview),
        kind:'folder',preview:summary.preview,entries:summary.entries.length,skipped:summary.skipped,truncated:summary.truncated})
      continue
    }
    if (!info.isFile()) throw new Error('Hãy chọn file hoặc folder thông thường')
    if (info.size > MAX_BYTES) throw new Error('Tệp vượt giới hạn 20 MiB: ' + name)
    const ext = path.extname(file).toLowerCase()
    if (!['.png','.jpg','.jpeg','.webp','.gif','.avif','.pdf'].includes(ext)) {
      const handle = await open(file, 'r')
      try {
        const bytes = Buffer.alloc(4096), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
        if (bytes.subarray(0, bytesRead).includes(0)) throw new Error('Định dạng nhị phân chưa được hỗ trợ: ' + name)
      } finally { await handle.close() }
    }
    files.set(file, { id: previous?.id ?? randomUUID(), path: file, name, size: info.size })
  }
  const result = [...files.values()]
  if (result.length > MAX_FILES) throw new Error('Tối đa 32 tệp mỗi tin nhắn')
  if (result.reduce((sum,f)=>sum+f.size,0) > MAX_BYTES) throw new Error('Tổng tệp đính kèm vượt 20 MiB')
  return result
}

export async function attachToPrompt(context: any, event: any) {
  const session = await context.session.get({ sessionID: event.sessionID })
  const staged = pendingFiles(session.metadata)
  // Fallback for terminals that insert a dropped path as ordinary text, not a paste event.
  const rawPaths = droppedFilesNow(event.prompt.text)
  const dropped = rawPaths.length
    ? { paths: rawPaths, text: 'Phân tích các tệp/folder đính kèm.' }
    : droppedFileReferences(event.prompt.text)
  const paths = [...new Set([...staged.map(file => file.path), ...dropped.paths])]
  if (!paths.length) return
  let fresh: PickedFile[]
  try {
    // Revalidate staged files at send time. One pass also checks newly dropped
    // files, avoiding a second open/stat for every attachment.
    fresh = await validatePickedFiles(paths, staged)
  } catch (error) {
    // A stale, changed or oversized attachment must not abort a normal chat
    // request with HTTP 500. Tell the model the attachment was not provided.
    const reason = error instanceof Error ? error.message : 'Tệp đính kèm không hợp lệ'
    if (reason.startsWith('Không đính kèm tệp chứa cấu hình nhạy cảm:')) throw error
    event.prompt.text += '\n\n[Lỗi đính kèm: ' + reason + '. Không có nội dung file được gửi từ thao tác đính kèm này. Hãy báo người dùng chọn lại tệp cần thiết.]'
    if (staged.length) {
      await context.session.update({
        sessionID: event.sessionID,
        metadata: { ...session.metadata, [PENDING_FILES]: [] },
      })
    }
    return
  }
  const known = new Set((event.prompt.files ?? []).map((f:any)=>f.uri))
  event.prompt.files ??= []
  for (const file of fresh) {
    const uri = file.kind==='folder'
      ? 'data:text/plain;base64,'+Buffer.from('Folder được người dùng đính kèm: '+file.path+'\n'+
          'Đây là danh sách cấu trúc, chưa phải nội dung toàn bộ file. Dùng read/glob/grep để đọc file liên quan khi cần. Folder đính kèm chỉ cấp quyền đọc; không sửa ngoài folder dự án.\n'+
          'Đã bỏ qua dependencies, build, secrets và symlink.\n'+file.preview+(file.truncated?'\n… Danh sách được rút gọn; có thể tìm đọc thêm trong folder.':'')).toString('base64')
      : pathToFileURL(file.path).href
    if (known.has(uri)) continue
    event.prompt.files.push({ uri, name:file.name+(file.kind==='folder'?'/':''), description:file.kind==='folder'?'Folder do người dùng đính kèm; đọc file liên quan theo nhu cầu':'Tệp do người dùng chọn hoặc kéo thả trực tiếp' })
    known.add(uri)
  }
  if (dropped.paths.length){
    event.prompt.text = dropped.text
    await context.session.update({sessionID:event.sessionID,metadata:{...session.metadata,[PENDING_FILES]:fresh}})
  }
  event.metadata = { ...event.metadata, [ATTACHED_IDS]:fresh.map(f=>f.id),
    [ADMITTED_FOLDERS]:fresh.filter(f=>f.kind==='folder').map(f=>f.path) }
}

export async function clearAdmittedAttachments(context: any, sessionID: string) {
  const session = await context.session.get({sessionID})
  const staged = pendingFiles(session.metadata)
  if (!staged.length) return
  const messages = await context.session.context({sessionID})
  const lastUser = [...messages].reverse().find((m:any)=>m.type==='user')
  const admitted = new Set(lastUser?.metadata?.[ATTACHED_IDS] ?? [])
  if (!staged.some(f=>admitted.has(f.id))) return
  // Refresh metadata so a newly selected file is not accidentally cleared with the previous batch.
  const latest = await context.session.get({sessionID})
  const remaining = pendingFiles(latest.metadata).filter(f=>!admitted.has(f.id))
  const roots=[...new Set([...attachedFolders(latest.metadata),...(lastUser?.metadata?.[ADMITTED_FOLDERS]??[])])]
  const access=folderAccess(latest,roots)
  await context.session.update({sessionID,...access,metadata:{...access.metadata,[PENDING_FILES]:remaining}})
}
