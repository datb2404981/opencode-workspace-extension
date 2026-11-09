# Định hướng kiến trúc cho OpenCode workspace extension

Ngày rà soát: 10/11/2026. Phạm vi gồm extension được sao chép vào repository này, OpenCode v2.2.5 và những thiết lập chạy đã kiểm tra trên máy phát triển. So sánh với **harness** của Claude Code và Codex dựa trên tài liệu công khai. Các phần bên trong sản phẩm đóng mã nguồn của Claude Code không được coi là thông tin đã xác minh.

### Tiến độ sau bản 1.9.1

| Hạng mục | Đã kiểm tra | Còn cần xác minh |
| --- | --- | --- |
| Đăng ký plugin | Đã cài vào cấu hình CLI `~/.opencode/opencode.json` và `opencode.bin plugin list --standalone` có hiển thị extension. Có lệnh `doctor.py` chỉ đọc để kiểm tra cấu hình. | Kiểm tra toàn bộ hook trong phiên TUI mới, riêng launcher VS Code và những cấu hình runtime ghi đè. |
| Nạp mã nguồn | Nhận diện tối đa ba tệp có tên Unicode hoặc dấu cách, giới hạn source theo lượt, bỏ project map khi đã có nội dung file và giữ lại phần đã đọc của file không thay đổi sau edit. | Đo số token/prefill và tính đúng đắn trên dự án thực tế. |
| Kiểm định | 11 bài unit test và cú pháp installer/doctor đã đạt; `npm run bench` đo p50/p95 I/O không gọi model, CI kiểm tra push/PR. | Chưa có benchmark A/B về TTFT và thời gian hoàn thành yêu cầu với cùng model local. |
| Chính sách launcher | Đã phát hiện compaction tự động và LSP bị wrapper vô hiệu hóa. | Chưa tự thay đổi wrapper để tránh tác động ngầm đến độ trễ, RAM hoặc workflow đang chạy. |

Bảng hiện trạng và backlog bên dưới là đánh giá ban đầu trước các sửa đổi 1.9.1; dùng bảng tiến độ này khi xác định mục đã hoàn thành.

## 1. Kết quả kiểm tra hiện trạng

| Thành phần | Quan sát xác thực | Ý nghĩa |
| --- | --- | --- |
| Nguồn khởi động | Launcher `~/.opencode/bin/opencode` chọn `~/.opencode/opencode.json`, nhưng extension workspace được đăng ký ở `~/.config/opencode/opencode.json`. Launcher VS Code cũng chọn cấu hình `~/.opencode`. | Plugin có thể không được nạp trong các phiên khởi động từ launcher này. Phải kiểm tra cấu hình hiệu lực và danh sách plugin trước khi đo hiệu năng. |
| Context và compaction | File `~/.opencode/opencode.json` có `compaction.auto: true`, nhưng launcher mặc định có `OPENCODE_CONFIG_CONTENT` ghi đè thành `compaction.auto: false`, `buffer: 1%`. | File cấu hình trên đĩa không mô tả đầy đủ hành vi runtime. Cần gỡ trùng lặp cấu hình và khôi phục chính sách compaction phù hợp với cửa sổ context. |
| Code intelligence | Launcher ghi đè `lsp: false`, `formatter: false`, `snapshots: false`. | Phần trợ giúp điều hướng định nghĩa/tham chiếu và một số cơ chế kiểm chứng/phục hồi chưa được tận dụng trong cách khởi động này. |
| Giới hạn tool | `workspace-server.ts` chỉ quảng bá `read`, `read_focus`, `glob`, `grep`, `skill`, `websearch`, `webfetch`, và `edit`/`write` cho Build. | Hạn chế vòng lặp, nhưng cũng khiến agent khó tự chạy kiểm thử, kiểm tra Git, chẩn đoán lỗi hoặc dùng patch/LSP. |
| Bản đồ mã nguồn | `context-index.ts` dùng giới hạn quét 80 ms, 80 thư mục, 900 file, tối đa 1.800 ký tự, cache TTL 60 giây. | Hữu ích để định hướng nhanh. Bản đồ có thể thiếu module trong repository lớn, không biểu diễn quan hệ import/symbol. |
| Nạp context tệp | `code-freshness.ts` chọn tối đa 2 tệp mỗi lượt, dựa trên đường dẫn trong prompt và phiên bản file (`ino`, `size`, `mtime`, `ctime`). | Tránh lặp dữ liệu khi không đổi, nhưng nhận diện đường dẫn có Unicode/dấu cách còn hạn chế và không theo dõi quan hệ phụ thuộc. |
| Chống lặp | `tool-loop-guard.ts` chặn lỗi trùng công cụ/đầu vào lần thứ ba và chặn lần đọc giống hệt thứ tư. | Cơ chế hữu ích. Cần đo số lần chặn hợp lệ, lỗi bị chặn nhầm và trạng thái sau khi file thay đổi ngoài agent. |
| Độ tin cậy | Các bài test đơn vị cho `code-freshness` và `tool-loop-guard` đã đạt 8/8. | Chứng minh logic tập trung, chưa chứng minh hiệu quả end-to-end hoặc độ trễ thực tế với model local. |

**Giới hạn bằng chứng.** Đây là source của extension và cấu hình máy phát triển, không phải source toàn bộ OpenCode. Tài liệu kiến trúc của Claude Code/Codex dùng để so sánh các cơ chế đã công bố, không có kết quả benchmark A/B giữa ba công cụ trên cùng phần cứng.

## 2. Đối chiếu các lớp hạ tầng, không xét model

| Lớp | Claude Code | Codex | Cơ hội cho extension |
| --- | --- | --- | --- |
| Agent loop | Thu thập context → thao tác → kiểm chứng, cho phép điều hướng giữa lượt. | Agent harness quản lý lượt, công cụ, trạng thái và kiểm chứng. | Giữ các bước `discover → inspect → change → verify` và chỉ cấp tool cần cho loại nhiệm vụ. |
| Context dài hạn | `CLAUDE.md`/`AGENTS.md`, memory và `/compact`, nạp rules theo phạm vi. | Lưu trạng thái hội thoại, checkpoints/compaction và tiếp tục công việc. | Bật lại compaction của OpenCode, giữ `goal`, `files_changed`, `tests`, `pending`, `limitations` ở checkpoint. Tránh tự viết trình tóm tắt thứ hai. |
| Truy xuất mã | Các công cụ tìm file, code intelligence và subagent cho tác vụ đọc nhiều. | Công cụ đọc/tìm, điều hướng source và công cụ chạy lệnh có kiểm soát. | Bổ sung truy vấn theo symbol/import qua LSP khi cần, sửa nhận diện path Unicode và giới hạn lượng text trả về. |
| Prompt caching | Dựa trên **prefix ổn định**, hạn chế đổi phần đầu prompt. | Harness giữ và quản lý context/compaction để có thể tái sử dụng phần phù hợp. | Giữ instruction/metadata tĩnh, chèn kết quả linh động ở phần sau; đo lại khi provider local thực sự hỗ trợ prefix/KV caching. |
| Tool execution | Hooks và quyền theo hành động, cho phép format/test sau khi edit. | Tool dispatch, hỗ trợ gọi song song với ràng buộc tương tranh, cancellation và trace. | Parallel read-only có giới hạn, retry lỗi tạm thời có backoff, không retry write mù. Thêm `test`, `git diff/status` theo allowlist và kiểm soát quyền. |
| Phân quyền/khôi phục | Hooks, chế độ phân quyền và cơ chế tiếp tục session. | Sandbox/approval, patch, trạng thái task và cancellation. | Duy trì giới hạn workspace; dùng sandbox hệ điều hành/worktree cho tác vụ build, checkpoint và diff trước/ sau sửa. |
| Quan sát hệ thống | Có công cụ xem context và lượng cache. | Event streaming, trace và thời gian gọi công cụ. | Thêm số đo runtime theo lượt và công cụ, với nội dung redacted. Không log mã nguồn hoặc token bí mật. |
| Công việc song song | Subagent giữ các lần đọc nặng khỏi context chính. | Context độc lập cho agent con và phối hợp công việc. | Trước tiên song song hóa thao tác đọc I/O, chỉ thử subagent sau khi đo CPU/RAM/tokens. |

### Chú ý khả năng đã có trong OpenCode

OpenCode đã có công cụ `grep`, `glob`, `apply_patch`, `lsp` (tùy chế độ), permission, compaction, sự kiện session và server/plugin API. Nên khôi phục và cấu hình đúng công cụ lõi trước khi viết phiên bản tự triển khai. Với các bản OpenCode khác v2.2.5, kiểm tra tính tương thích API trước khi áp dụng.

## 3. Backlog cải tiến có thứ tự

| Ưu tiên | Đề xuất tối thiểu | Vị trí dự kiến | Điều kiện hoàn thành |
| --- | --- | --- | --- |
| **P0.1** | Chọn **một nguồn cấu hình runtime**, kiểm tra plugin đã nạp và báo rõ config nào đang hiệu lực. | Launcher, `opencode.json`, kiểm tra startup | TUI/VS Code cùng thấy extension và cùng quyền tool; không còn override ngầm giữa hai file. |
| **P0.2** | Đo `time_to_first_token`, tổng thời gian lượt, token input/output, số lần gọi tool, thời gian đọc file, số lần compaction, RAM, số lần chặn guard. | `workspace-server.ts` hooks, benchmark script | Có baseline ít nhất 3 loại tác vụ và báo p50/p95 với cùng model, context và repository. |
| **P0.3** | Cấu hình lại compaction có giới hạn và thử chính sách giữ context gần nhất. | Launcher / OpenCode core config | 1 phiên dài tiếp tục được task, tệp đổi và phần chưa xong sau compaction, không tràn context ở bài test. |
| **P0.4** | Cho Build dùng lệnh xác minh theo allowlist (`git diff/status`, lệnh test/build xác định) hoặc cơ chế tool được sandbox hóa. Xử lý `apply_patch` đúng contract khi bật. | `workspace-core.ts`, `workspace-server.ts` | Agent thực hiện được chuỗi sửa → test → đối chiếu diff, đồng thời vẫn không sửa ngoài workspace. |
| **P1.1** | Nhận diện đường dẫn Unicode, dấu cách và nhiều tệp, có test input cụ thể. Không ép nạp nguyên file. | `code-freshness.ts` | Truy vấn về file `ĐăngNhập.vue`, `My View.vue`, và cùng lúc 3 file đều tìm được nội dung cần thiết. |
| **P1.2** | `grep/glob → read` theo vùng liên quan và giới hạn đầu ra; LSP cho symbol/definitions/references trên yêu cầu. | Context layer, quyền LSP | Tìm đúng function/caller trong bài thử mà không phải đọc toàn repository; đo số token giảm. |
| **P1.3** | Kết hợp watcher/invalidation sau sửa file, xử lý yêu cầu huỷ và lỗi tạm thời theo từng call; log kết quả guard. | `context-index.ts`, `code-freshness.ts`, `tool-loop-guard.ts` | Cập nhật từ editor bên ngoài được nhận đúng, không có dữ liệu stale; retry/cancel có test. |
| **P1.4** | Khôi phục/hiển thị diff và test status trước khi chốt câu trả lời. | Session state, TUI, công cụ build | Trả lời phân biệt rõ `đã sửa`, `đã test`, `chưa test`, và có thể tiếp tục phiên bị gián đoạn. |
| **P2.1** | Caching theo file version và symbol (chỉ khi đo chứng minh trễ ở I/O), giữ index có kích thước giới hạn. | `context-index.ts` | Cache hit/invalidation có thống kê, tải CPU/RAM không tăng đáng kể. |
| **P2.2** | Hỗ trợ song song những lần đọc độc lập theo concurrency cap và áp dụng deadline. | Tool orchestration | p95 đọc nhiều file giảm, output vẫn đúng thứ tự và an toàn. |
| **P2.3** | Thử subagent đọc/review ở context tách biệt **sau** khi P0–P1 được đo. | Cấu hình agent/công cụ | Tổng thời gian và RAM tốt hơn baseline trên cùng bộ bài test, không xung đột edit. |

## 4. Ba phép kiểm chứng quan trọng

**Bài A — hỏi về code.** Trên cùng repository và model, hỏi tìm điểm gọi một hàm qua 3 file, đo số bước `glob/grep/read`, tổng byte đọc, token gửi lên model, TTFT và độ chính xác file/vị trí. Có phiên bản file Unicode và dấu cách.

**Bài B — sửa mã và chạy test.** Đưa lỗi có test tái hiện sẵn, đo từ lúc bắt đầu đến khi test pass và diff sạch. Đảm bảo Ask chỉ đọc, Build có thể kiểm thử trong giới hạn và error được báo đúng.

**Bài C — phiên dài và file thay đổi.** Đọc file, chỉnh sửa từ editor bên ngoài, kéo dài hội thoại đến khi compaction, rồi hỏi về phiên bản mới. Kiểm tra không hồi tưởng bản cũ và không mất mục tiêu cần hoàn thành.

Khởi đầu bằng baseline rồi thử từng thay đổi độc lập. Không gán phần trăm cải thiện tùy ý hoặc kết luận model local nhanh hơn chỉ vì một lượt trả lời ngắn hơn.

## 5. Phản biện trước khi xây thêm hạ tầng

1. Đang ưu tiên **câu trả lời đầu tiên nhanh** hay **hoàn thành tác vụ có test**? Hai mục tiêu cần bộ đo khác nhau.
2. Phiên người dùng đang chạy bằng `~/.opencode` hay `~/.config/opencode`? Không xác nhận điểm này thì thay đổi extension có thể không có hiệu lực.
3. Độ chậm đến từ GPU inference, thời gian nạp prompt, context quá dài hay vòng lặp tool? Cần trace trước khi thêm cache/vector DB.
4. Có cần các agent dùng shell/mạng không? Nếu cần hãy dùng allowlist, quyền thực thi và sandbox; mở tất cả sẽ làm sai kỳ vọng về an toàn workspace.
5. Máy có đủ RAM cho nhiều context inference song song không? Ưu tiên song song thao tác I/O nhẹ và tránh nhiều phiên model nặng cạnh tranh bộ nhớ.

**Quyết định định hướng.** Ưu tiên P0.1–P0.4, sau đó P1.1 và P1.2. Trì hoãn vector database, indexing toàn repository và multi-agent nhiều model cho đến khi có bằng chứng thực tế. Hiệu năng và chất lượng phải được đo trên cùng model và bộ bài test, vì harness không thể bù mọi giới hạn của năng lực suy luận hoặc tốc độ inference.

## 6. Tài liệu tham khảo

- [Claude Code — agentic loop](https://code.claude.com/docs/en/how-claude-code-works)
- [Claude Code — context window](https://code.claude.com/docs/en/context-window)
- [Claude Code — prompt caching](https://code.claude.com/docs/en/prompt-caching)
- [Claude Code — subagents](https://code.claude.com/docs/en/sub-agents)
- [Claude Code — hooks](https://code.claude.com/docs/en/hooks-guide)
- [Codex — harness architecture](https://developers.openai.com/blog/codex-as-a-platform)
- [Codex — compaction implementation](https://github.com/openai/codex/blob/main/codex-rs/core/src/tasks/compact.rs)
- [Codex — parallel tool execution](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/parallel.rs)
- [OpenCode — compaction](https://opencode.ai/docs/compaction)
- [OpenCode — tool permissions and core tools](https://opencode.ai/docs/permissions)
- [OpenCode — server plugin hooks](https://opencode.ai/docs/build/plugins/server)
