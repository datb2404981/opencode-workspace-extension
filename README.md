# OpenCode workspace extension

Extension cho **OpenCode 2.2.5** hỗ trợ chọn dự án, đính kèm tệp/thư mục, tìm và đọc mã nguồn theo phạm vi, quản lý context và hạn chế vòng lặp gọi công cụ. Giao diện và hướng dẫn hiện sử dụng tiếng Việt.

> **Tương thích:** Extension được phát triển trên OpenCode **v2.2.5** có API plugin/TUI đang sử dụng ở máy tác giả. API này có thể thay đổi giữa các bản OpenCode. Chưa xác minh khả năng hoạt động với tất cả bản phát hành OpenCode khác. Trình chọn tệp đồ họa cần **macOS**.

## Tính năng

| Tính năng | Mô tả |
| --- | --- |
| Chuyển dự án | `/du-an` hoặc `Ctrl+Option+O`, tìm các chat gần đây theo folder hoặc duyệt folder qua Finder |
| Đính kèm tệp | `/tep`, `Ctrl+Option+A`, chọn nhiều tệp và kéo thả đường dẫn vào terminal |
| Đính kèm thư mục | `/thu-muc`, gửi sơ đồ thư mục trước; đọc file cụ thể khi cần |
| Giới hạn truy cập | Kiểm tra workspace, folder tham khảo, symlink và đường dẫn nhạy cảm trước khi chạy công cụ |
| Tối ưu context | Lập bản đồ cấu trúc dự án có cache, nhận diện tệp đang được hỏi và không nạp lại đoạn mã giống hệt |
| Chống gọi tool lặp | Dừng các lần đọc y hệt hoặc lỗi công cụ lặp lại quá ngưỡng trong một lượt |
| Skill và giao diện TUI | Menu skill, các phím tắt thao tác ô nhập, thông tin phiên và chuẩn hóa Markdown |

Extension giữ nguyên cấu hình model và các agent đã thiết lập. Các agent `ask`, `plan`, `build` được extension hỗ trợ theo quyền có sẵn trong cấu hình OpenCode. Extension không tự tạo ba agent này trên máy mới.

## Yêu cầu

- **macOS** để sử dụng toàn bộ tính năng chọn tệp bằng Finder. Bộ chọn tệp được biên dịch từ `FilePicker.swift` trong lúc cài, không yêu cầu tải binary từ bên thứ ba.
- **OpenCode v2.2.5** tương thích với API `@opencode/plugin` và `@opencode/plugin/tui` được sử dụng trong source.
- `git`, `python3`, và **Xcode Command Line Tools** (cung cấp `xcrun swiftc`).
- Một file cấu hình `opencode.json`. Installer có thể tạo file mới nếu chưa có.

Cài công cụ biên dịch Swift trên macOS khi cần:

```bash
xcode-select --install
```

## Cài đặt tự động

```bash
git clone https://github.com/datb2404981/opencode-workspace-extension.git
cd opencode-workspace-extension
bash scripts/install.sh
```

Installer thực hiện các bước sau.

1. Sao chép mã TypeScript vào `~/.config/opencode/workspace-plugin/`.
2. Biên dịch `OpenCodeFilePicker.app` từ Swift source, phù hợp với máy đang cài.
3. Thêm đường dẫn extension vào mảng `plugins` trong file `opencode.json`, giữ các trường cấu hình khác. Nếu file đã tồn tại, tạo bản sao lưu có timestamp.
4. Sao lưu thư mục plugin cũ khi bạn cài lại vào cùng vị trí.

**Khởi động lại OpenCode** sau khi cài.

### Chọn đúng file cấu hình

Nếu có cả `~/.config/opencode/opencode.json` và `~/.opencode/opencode.json`, installer ưu tiên file đầu tiên. Để chỉ định bản OpenCode bạn đang chạy:

```bash
OPENCODE_CONFIG="$HOME/.opencode/opencode.json" bash scripts/install.sh
```

Muốn cài mã extension ở đường dẫn khác:

```bash
OPENCODE_PLUGIN_DIR="$HOME/.opencode/extensions/workspace-plugin" \
OPENCODE_CONFIG="$HOME/.opencode/opencode.json" \
bash scripts/install.sh
```

Kiểm tra đúng file cấu hình bằng cách xem `OPENCODE_CONFIG` của launcher, nếu bạn đang dùng launcher tùy biến. Installer không chỉnh các launcher hoặc biến môi trường khác.

### Cài thủ công

Bạn có thể tự đặt các tệp TypeScript và `package.json` trong một thư mục rồi biên dịch helper từ source:

```bash
mkdir -p OpenCodeFilePicker.app/Contents/MacOS
cp macos/Info.plist OpenCodeFilePicker.app/Contents/Info.plist
xcrun swiftc -O FilePicker.swift -o OpenCodeFilePicker.app/Contents/MacOS/OpenCodeFilePicker
```

Thêm đường dẫn tuyệt đối của thư mục chứa `package.json` vào mảng `plugins` của `opencode.json`:

```json
{
  "plugins": ["/absolute/path/to/opencode-workspace-extension"]
}
```

Đoạn JSON trên minh họa khóa `plugins`, hãy thêm khóa này vào file cấu hình hiện có của bạn thay vì ghi đè toàn bộ file. Thư mục plugin phải chứa cả `workspace-server.ts` và `workspace-tui.ts`.

## Dùng thử

1. Mở phiên OpenCode TUI mới và nhập `/du-an` để chọn một thư mục dự án.
2. Dùng `/tep` chọn tệp, hoặc `/thu-muc` chọn thư mục tham khảo.
3. Gửi câu hỏi về tệp vừa gắn. OpenCode có thể dùng các công cụ đọc theo phạm vi đã cấp.
4. Dùng `/skills` nếu muốn chọn skill theo tên.

Lệnh tương đương `/attach` cho tệp và `/ky-nang` cho danh sách skill cũng được hỗ trợ. Trên macOS có thể dùng `Ctrl+Option+I` để đưa focus về ô nhập.

## Kiểm tra mã nguồn

Chạy các bài kiểm tra tập trung trong thư mục repo:

```bash
node --test tool-loop-guard.test.ts code-freshness.test.ts
```

Kiểm tra bản helper đã biên dịch:

```bash
"$HOME/.config/opencode/workspace-plugin/OpenCodeFilePicker.app/Contents/MacOS/OpenCodeFilePicker" --version
```

Để xác nhận tích hợp vào OpenCode, khởi động TUI bằng bản OpenCode 2.2.5 của bạn và thử `/du-an`. Các bài kiểm tra Node riêng lẻ chỉ kiểm chứng một phần logic của extension.

## Cập nhật và gỡ cài đặt

Để cập nhật:

```bash
git pull --ff-only
bash scripts/install.sh
```

Khi gỡ, xóa chính xác đường dẫn extension khỏi mảng `plugins` trong cấu hình bạn đã sử dụng, rồi xóa thư mục extension đã cài nếu không còn cần. Các bản backup có hậu tố `.backup-...` được giữ để bạn tự khôi phục khi cần.

## Lưu ý bảo mật và giới hạn

Đây là **kiểm soát phạm vi công cụ ở cấp plugin**, không phải sandbox bảo mật của hệ điều hành. Extension giới hạn các thao tác read/edit theo workspace và folder tham khảo, chặn một số đường dẫn nhạy cảm, và lọc kết quả tìm kiếm. Folder tham khảo chỉ cấp quyền đọc. Không dùng cơ chế này làm biện pháp cách ly tuyệt đối cho dữ liệu bí mật.

Mỗi lượt chọn hỗ trợ tối đa **32 mục**, tổng dung lượng tệp khoảng **20 MiB**. Việc đọc PDF/ảnh sau đính kèm còn tùy thuộc OpenCode và model. Các phần UI phụ thuộc API OpenTUI, nên có thể cần chỉnh sửa nếu nâng cấp OpenCode. Bản cài đặt tự động hiện nhắm đến macOS; khả năng chạy đầy đủ trên Linux/Windows chưa được xác nhận.

## English quick start

This extension targets **OpenCode 2.2.5** and adds workspace navigation, file/folder attachments, bounded context indexing, code freshness checks and repeated-tool-call guards. Full installation is currently supported on **macOS**.

```bash
git clone https://github.com/datb2404981/opencode-workspace-extension.git
cd opencode-workspace-extension
bash scripts/install.sh
```

The installer compiles the macOS file picker locally and registers the plugin in your OpenCode JSON config. Use `OPENCODE_CONFIG=/absolute/path/to/opencode.json` to select a specific config file. Restart OpenCode, then try `/du-an`, `/tep` and `/thu-muc`.

## Giấy phép

[MIT](LICENSE) © 2026 datb2404981.
