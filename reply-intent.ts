import path from 'node:path'

export const REPLY_INTENT = 'localReplyIntent'
type Suggestion = { kind: 'code-suggestion'; files: string[] }

function normalize(text: string) {
  return text.slice(0, 8000).normalize('NFD').replace(/\p{M}/gu, '').replaceAll('đ', 'd').replaceAll('Đ', 'D').toLowerCase()
}

function filenames(values: string[]): string[] {
  return [...new Set(values.map(value => path.basename(value.trim()))
    .filter(value => /^[\w.-]{1,120}\.(?:[cm]?[jt]sx?|vue|svelte|py|go|rs|java|cs|php|rb|sql|html|css)$/i.test(value)))].slice(0, 8)
}

export function suggestionIntent(text: string, files: { name?: string }[] = []): Suggestion | undefined {
  // Classify the live user request, never source-file contents or summaries.
  const normalized = normalize(text)
  if (!/\b(?:goi y|de xuat)\s+(?:viet\s+)?(?:code|ma nguon)\b|\b(?:code mau|sample code|code suggestion)\b/.test(normalized)) return
  if (/^(?:\s*(?:tai sao|vi sao|sao)\b)/.test(normalized)) return
  const labels = [...text.matchAll(/\[Tệp đính kèm:\s*([^\]\r\n]{1,160})\]/gu)].map(match => match[1])
  return { kind: 'code-suggestion', files: filenames([...files.map(file => file.name ?? ''), ...labels]) }
}

export function readSuggestion(metadata?: Record<string, unknown>): Suggestion | undefined {
  const value = metadata?.[REPLY_INTENT] as Partial<Suggestion> | undefined
  if (!value || value.kind !== 'code-suggestion' || !Array.isArray(value.files)) return
  return { kind: value.kind, files: filenames(value.files.filter((file): file is string => typeof file === 'string')) }
}

export async function retainSuggestion(context: any, event: any) {
  const intent = suggestionIntent(event.prompt.text, event.prompt.files)
  const session = await context.session.get({ sessionID: event.sessionID })
  if (!intent && /^(?:tiep tuc|lam tiep|gui tiep|viet tiep|continue)(?:\s+(?:di|nhe|please))?[.!?]*$/.test(normalize(event.prompt.text).trim())) return
  if (JSON.stringify(readSuggestion(session.metadata) ?? null) === JSON.stringify(intent ?? null)) return
  // Store only the requested output kind and safe basenames, not the prompt or
  // file contents. The next ordinary prompt clears it; this is per-chat UI state.
  await context.session.update({ sessionID: event.sessionID, metadata: {
    ...session.metadata, [REPLY_INTENT]: intent ?? null,
  } })
}

export function suggestionInstructions(metadata?: Record<string, unknown>): string | undefined {
  const intent = readSuggestion(metadata)
  if (!intent) return
  return 'Yêu cầu đầu ra hiện tại: GỢI Ý CODE. Trả bản code đề xuất đầy đủ theo từng file, mỗi file một khối ```typescript (hoặc ngôn ngữ phù hợp). Giải thích ngắn thay đổi so với mẫu tham chiếu. Một bản mô tả hoặc chép lại nguyên trạng chưa thay cho đề xuất. Nếu code hiện có đã phù hợp, nói rõ rồi đưa bản đề xuất tương ứng; không bịa thay đổi. Chỉ xuất code cho các file được yêu cầu; file tham chiếu chỉ để đối chiếu. Gợi ý không có nghĩa đã ghi file. Khi tóm tắt, giữ đúng dạng đầu ra này, không đổi thành "đọc/trả lại nội dung chính xác".' +
    (intent.files.length ? ' Các file đính kèm của yêu cầu: ' + JSON.stringify(intent.files) + '.' : '')
}
