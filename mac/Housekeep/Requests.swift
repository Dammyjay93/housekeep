import AppKit
import Foundation

/// Requests for your AI assistant: one for whatever is ticked, worded as the server words `request`
/// (src/items.ts), so the app and the command line ask for the same things in the same way.
enum Requests {
    static func combined(_ project: Project, _ items: [Item]) -> String {
        guard !items.isEmpty else { return "" }
        let prefix = "In \(project.path), "
        let steps = items.enumerated().map { index, item in
            let ask = item.ask.hasPrefix(prefix) ? String(item.ask.dropFirst(prefix.count)) : item.ask
            return "\(index + 1). \(ask.prefix(1).uppercased())\(ask.dropFirst())"
        }
        return "In \(project.path), please do the following, in this order.\n\n"
            + "Before changing anything, back up: save a git bundle of every branch and a patch of any uncommitted changes, outside the repo, and tell me where they are. "
            + "Ask me before pushing to main, deleting anything on the remote, or force-pushing.\n\n"
            + steps.joined(separator: "\n\n")
            + "\n\nWhen you're done, tell me what you did and anything you left alone."
    }

    static func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}

/// Requests you copied, remembered so each card can tick items off as their changes show up in git.
/// Kept between launches, so quitting the app mid-fix loses nothing.
@MainActor
final class SentRequests: ObservableObject {
    struct Sent: Codable, Equatable {
        struct Entry: Codable, Equatable {
            let id: String
            let title: String
            let why: String
        }

        let at: Date
        let items: [Entry]
        var done: [String: Date]

        var finished: Bool { items.allSatisfy { done[$0.id] != nil } }
        var fixed: Int { items.filter { done[$0.id] != nil }.count }
    }

    private static let key = "sentRequests"
    @Published private(set) var bySlug: [String: Sent] = [:]

    init() {
        if let data = UserDefaults.standard.data(forKey: Self.key),
           let saved = try? JSONDecoder().decode([String: Sent].self, from: data) {
            bySlug = saved
        }
    }

    func remember(_ project: Project, items: [Item]) {
        bySlug[project.slug] = Sent(at: .now, items: items.map { Sent.Entry(id: $0.id, title: $0.title, why: $0.why) }, done: [:])
        save()
    }

    func forget(_ slug: String) {
        bySlug[slug] = nil
        save()
    }

    /// Anything a request covered that the latest check no longer lists has landed.
    func update(with snapshot: Snapshot) {
        var changed = false
        for project in snapshot.projects {
            guard var sent = bySlug[project.slug] else { continue }
            let still = Set(project.toFix.map(\.id))
            for entry in sent.items where !still.contains(entry.id) && sent.done[entry.id] == nil {
                sent.done[entry.id] = .now
                changed = true
            }
            bySlug[project.slug] = sent
        }
        if changed { save() }
    }

    private func save() {
        if let data = try? JSONEncoder().encode(bySlug) { UserDefaults.standard.set(data, forKey: Self.key) }
    }
}
