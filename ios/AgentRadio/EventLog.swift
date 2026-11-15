import Foundation

/// Ring buffer of the last 200 diagnostic events.
@MainActor
final class EventLog: ObservableObject {
    @Published private(set) var entries: [String] = []
    private let limit = 200
    private let formatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd HH:mm:ss.SSS"
        return f
    }()

    func add(_ message: String) {
        entries.append("\(formatter.string(from: Date())) \(message)")
        if entries.count > limit { entries.removeFirst(entries.count - limit) }
    }

    var text: String { entries.joined(separator: "\n") }
}
