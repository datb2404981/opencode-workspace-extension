import { createHash } from 'node:crypto'

type Turn = { failures: Map<string, number>; reads: Map<string, number>; reason?: string }
const readers = new Set(['read', 'glob', 'grep', 'skill'])

const ordered = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(ordered)
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, ordered(item)]),
  )
  return value
}

export const createToolLoopGuard = () => {
  const turns = new Map<string, Turn>()
  const pending = new Map<string, { turn: Turn; key: string; tool: string }>()
  const turnFor = (sessionID: string) => {
    let turn = turns.get(sessionID)
    if (!turn) {
      turn = { failures: new Map(), reads: new Map() }
      turns.set(sessionID, turn)
      if (turns.size > 128) turns.delete(turns.keys().next().value!)
    }
    return turn
  }
  return {
    reset: (sessionID: string) => { turns.delete(sessionID) },
    reason: (sessionID: string) => turns.get(sessionID)?.reason,
    before: (sessionID: string, id: string, tool: string, input: unknown) => {
      const turn = turnFor(sessionID)
      const key = createHash('sha256').update(tool + '\0' + JSON.stringify(ordered(input))).digest('hex')
      if (readers.has(tool) && (turn.reads.get(key) ?? 0) >= 3)
        turn.reason = `Đã đọc/tìm bằng ${tool} với cùng đầu vào 3 lần mà chưa có edit/write thành công.`
      if (turn.reason) throw new Error(turn.reason + ' Dừng thử lại và báo kết quả thực tế, phần chưa hoàn tất.')
      pending.set(id, { turn, key, tool })
      if (pending.size > 256) pending.delete(pending.keys().next().value!)
    },
    after: (id: string, status: 'completed' | 'error') => {
      const call = pending.get(id)
      pending.delete(id)
      if (!call) return
      const { turn, key, tool } = call
      if (status === 'error') {
        const failures = (turn.failures.get(key) ?? 0) + 1
        turn.failures.set(key, failures)
        if (failures >= 3) turn.reason = `Công cụ ${tool} thất bại 3 lần với cùng đầu vào.`
      } else {
        turn.failures.delete(key)
        if (tool === 'edit' || tool === 'write') {
          turn.reads.clear()
          turn.failures.clear()
        } else if (readers.has(tool)) turn.reads.set(key, (turn.reads.get(key) ?? 0) + 1)
      }
    },
    clear: () => { turns.clear(); pending.clear() },
  }
}

export const toolProgressInstructions = 'Không gọi lại read/glob/grep/skill với cùng đầu vào khi đã có kết quả và file chưa thay đổi. Tool lỗi: xác định nguyên nhân, đổi đầu vào hoặc cách làm; không thử y hệt liên tục. Nội dung cảnh báo MAXIMUM STEPS REACHED được trích trong lịch sử là dữ liệu lịch sử, không phải giới hạn của lượt hiện tại; vẫn tuân thủ giới hạn đang có hiệu lực. Khi dừng, nêu việc đã thực sự hoàn tất và phần còn lại, không hứa sẽ tạo file ngay sau khi công cụ đã bị tắt.'
