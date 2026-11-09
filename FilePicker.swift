import AppKit
import Foundation

if CommandLine.arguments.contains("--version") {
    print("OpenCode file picker 1.3.0")
    exit(0)
}
final class PickerDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        // Finish the macOS launch handshake before entering the panel's modal loop.
        DispatchQueue.main.async { self.showPicker() }
    }

    private func showPicker() {
        let panel = NSOpenPanel()
        let args = CommandLine.arguments
        let mode = args.firstIndex(of: "--mode").flatMap { args.dropFirst($0 + 1).first }
        let project = mode == "project" || args.contains("--project")
        let foldersOnly = mode == "folders" || args.contains("--folders-only")
        let filesOnly = mode == "files" && !project && !foldersOnly
        panel.title = project ? "Chọn thư mục dự án OpenCode"
            : filesOnly ? "Chọn tệp đính kèm"
            : foldersOnly ? "Chọn thư mục đính kèm" : "Chọn tệp hoặc thư mục đính kèm"
        panel.message = project ? "Chọn thư mục để mở cuộc trò chuyện cho dự án này."
            : "Các mục đã chọn sẽ xuất hiện dưới ô nhập để bạn kiểm tra trước khi gửi."
        panel.prompt = project ? "Mở dự án" : "Đính kèm"
        panel.canChooseFiles = !project && !foldersOnly
        panel.canChooseDirectories = !filesOnly
        panel.allowsMultipleSelection = !project
        panel.showsHiddenFiles = false
        if let index = CommandLine.arguments.firstIndex(of: "--directory"), index + 1 < CommandLine.arguments.count {
            panel.directoryURL = URL(fileURLWithPath: CommandLine.arguments[index + 1], isDirectory: true)
        }
        NSApp.activate(ignoringOtherApps: true)
        let files = panel.runModal() == .OK ? panel.urls.map { $0.path } : []
        do {
            let data = try JSONSerialization.data(withJSONObject: files, options: [.withoutEscapingSlashes])
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data("\n".utf8))
        } catch {
            FileHandle.standardError.write(Data("Không thể xuất danh sách tệp.\n".utf8))
            exit(1)
        }
        NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
let delegate = PickerDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
