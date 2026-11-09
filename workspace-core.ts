import path from 'node:path'
import os from 'node:os'
import { realpath, lstat, readdir } from 'node:fs/promises'
import { resolveFolderAlias } from './folder-aliases.ts'

export const ROOT_KEY = 'localWorkspaceRoot'
export const scopedAgents = new Set(['ask', 'plan', 'build', 'project', 'project-build', 'fast'])
export function mainAgent(agent?: string) {
  if (agent === 'plan') return 'plan'
  if (agent === 'build' || agent === 'project-build') return 'build'
  return 'ask'
}
const readTools = new Set(['read', 'glob', 'grep', 'read_focus'])
const writeTools = new Set(['edit', 'write'])

const memoryReaders = new Set(['memory_query', 'memory_read_page', 'memory_recent', 'memory_status', 'memory_briefing'])
export function isMemoryReader(tool: string) {
  const match = /^ai-memory_(.+)$/.exec(tool)
  return match !== null && memoryReaders.has(match[1])
}

export function isInside(root: string, file: string) {
  const rel = path.relative(root.normalize('NFC'), file.normalize('NFC'))
  return rel === '' || (!rel.startsWith('../') && rel !== '..' && !path.isAbsolute(rel))
}

export function resolveFolder(input: string, cwd: string) {
  let value = input.trim()
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
  if (value === '~') value = os.homedir()
  else if (value.startsWith('~/')) value = path.join(os.homedir(), value.slice(2))
  return path.resolve(cwd, value)
}

// Resolve the nearest existing ancestor too, so writes through a directory symlink cannot escape.
async function physicalPath(target: string): Promise<string> {
  try { return await realpath(target) }
  catch (error: any) {
    if (error.code !== 'ENOENT') throw error
    // Reject dangling links rather than treating them as an ordinary missing file.
    try { if ((await lstat(target)).isSymbolicLink()) throw new Error('Symlink không hợp lệ') }
    catch (statError: any) { if (statError.code !== 'ENOENT') throw statError }
    const parent = path.dirname(target)
    if (parent === target) throw error
    return path.join(await physicalPath(parent), path.basename(target))
  }
}

export async function checkedPath(rootInput: string, input: string) {
  const root = await realpath(rootInput)
  const lexical = resolveFolder(input, root)
  if (!isInside(root, lexical)) throw new Error('Ngoài folder dự án đã chọn: ' + input)
  const target = await physicalPath(lexical)
  if (!isInside(root, target)) throw new Error('Symlink trỏ ra ngoài folder dự án: ' + input)
  const parts = path.relative(root, target).split(path.sep)
  if (parts.some(p => ['.git','.ssh','.aws'].includes(p) || (p === '.env' || p.startsWith('.env.')) && p !== '.env.example') ||
      ['id_rsa','id_ed25519','credentials.json'].includes(path.basename(target))) {
    throw new Error('Không truy cập file cấu hình nhạy cảm hoặc dữ liệu .git trong chế độ dự án')
  }
  return target
}

export async function checkedReadPath(root: string, input: string, folders: string[] = []) {
  let error: unknown
  for(const allowed of [root,...folders]){
    try{return await checkedPath(allowed,input)}catch(e){error??=e}
  }
  throw error
}

export async function guardTool(root: string, agent: string, tool: string, input: any, location = root, folders: string[] = []) {
  if (tool === 'websearch' || tool === 'webfetch') {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Web input không hợp lệ')
    if (tool === 'websearch') {
      const q = input.query ?? input.q
      if (typeof q !== 'string' || !q.trim() || q.length > 350 || /(?:\/Users\/|\/home\/|\.env\b|api[_-]?key|bearer\s+|sk-[A-Za-z0-9]{12,})/i.test(q)) throw new Error('Web search cần câu hỏi công khai, không chứa thông tin dự án riêng tư')
    } else {
      const url = input.url
      if (typeof url !== 'string' || url.length > 2048) throw new Error('URL web không hợp lệ')
      let parsed: URL
      try { parsed = new URL(url) } catch { throw new Error('URL web không hợp lệ') }
      const host = parsed.hostname.toLowerCase()
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || /(?:^localhost$|\.local$|\.internal$|\.localhost$|^\d+\.\d+\.\d+\.\d+$|^\[|^0x|^0\d)/i.test(host) || host.includes(':') || host === 'metadata.google.internal' || /(?:\/Users\/|\/home\/|\.env\b|api[_-]?key|bearer\s+|sk-[A-Za-z0-9]{12,})/i.test(url)) throw new Error('Chỉ cho phép HTTPS tới hostname công khai; URL nội bộ hoặc chứa dữ liệu nhạy cảm bị chặn')
    }
    return input
  }
  if(tool==='skill'||isMemoryReader(tool)){
    if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Input công cụ không hợp lệ')
    return input
  }
  const canWrite = agent === 'project-build' || agent === 'build'
  if (!readTools.has(tool) && !(canWrite && writeTools.has(tool))) {
    throw new Error('Công cụ bị khóa trong workspace folder: ' + tool)
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Input công cụ không hợp lệ')
  const searching = tool === 'glob' || tool === 'grep'
  if (!searching && typeof input.path !== 'string') throw new Error('Cần đường dẫn file')
  if(typeof input.path==='string'&&input.path.startsWith('@folder/')&&!readTools.has(tool))
    throw new Error('Folder tham khảo chỉ được đọc, không được sửa qua alias')
  const alias=readTools.has(tool)?resolveFolderAlias(input.path??'.',folders):undefined
  const requested=resolveFolder(input.path??'.',root)
  const target = alias?await checkedPath(alias.root,alias.target):readTools.has(tool)?await checkedReadPath(root,requested,folders):await checkedPath(root,requested)
  if (searching) {
    // Keep search paths relative, as required by OpenCode's glob/grep schema.
    return { ...input, path: path.relative(location, target) || '.',
      ...(tool === 'glob' ? { hidden: false } : !input.include ? { include: '!{**/.env,**/.env.*,**/.git/**}' } : {}) }
  }
  return { ...input, path: target }
}

export function folderPermissions(root: string) {
  const rules: Array<{ action: string; resource: string; effect: 'deny' | 'allow' }> = [
    { action: 'external_directory', resource: '*', effect: 'deny' },
  ]
  for (const alias of new Set([root, root.normalize('NFC'), root.normalize('NFD')])) {
    rules.push({ action: 'external_directory', resource: path.join(alias, '*'), effect: 'allow' })
  }
  for (const action of ['bash', 'shell', 'task', 'mcp']) {
    rules.push({ action, resource: '*', effect: 'deny' })
  }
  return rules
}

export async function folderSnapshot(root: string) {
  const entries = (await readdir(root, { withFileTypes: true }))
    .filter(e => !e.name.startsWith('.')).slice(0, 60)
  return 'Folder dự án đang mở: ' + root + '\n' +
    'Các mục ở cấp gốc (chỉ là danh sách, chưa kiểm tra nội dung code):\n' +
    entries.map(e => '- ' + e.name + (e.isDirectory() ? '/' : e.isSymbolicLink() ? ' (symlink)' : '')).join('\n') +
    '\nCó công cụ read/glob/grep để tự tìm và đọc các file liên quan. Không yêu cầu người dùng đưa đường dẫn khi có thể tìm trong folder. Công cụ ra ngoài folder và shell đã bị khóa.'
}
