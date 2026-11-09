// Advertise one focused skill, not the full installed catalog. Native OpenCode
// sends only its description; content is loaded by the skill tool when relevant.
export const AUTO_SKILL_ID = 'express-ts-clean'
export const shouldAutoInvoke = (id: string): boolean => id === AUTO_SKILL_ID

export const skillToolDescription = 'Nạp skill bằng id chính xác có trong hướng dẫn skills hoặc do người dùng chọn; không đoán id. Tự dùng express-ts-clean khi viết/sửa/review backend Express + TypeScript; không cần nạp khi câu hỏi chỉ giải thích một dòng code hoặc không liên quan. Đọc file thông thường dùng read, tìm file dùng glob/grep. Không liệt kê toàn bộ catalog.'
