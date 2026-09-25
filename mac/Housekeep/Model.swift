import Foundation

/// The part of Housekeep's state the menu shows. The server's JSON has much more (src/model.ts); this
/// decodes only what the menu reads, so new fields on the server never break the app.
struct Snapshot: Decodable, Sendable {
    let generatedAt: String
    let projects: [Project]
    let error: SnapshotError?

    var needy: [Project] { projects.filter { $0.tier != .safe } }
    var clean: [Project] { projects.filter { $0.tier == .safe } }
    var worst: Tier { projects.map(\.tier).min() ?? .safe }
    var checkedAt: Date? { Timestamp.parse(generatedAt) }
}

struct SnapshotError: Decodable, Sendable {
    let title: String
    let detail: String
}

struct Project: Decodable, Identifiable, Sendable {
    let name: String
    let slug: String
    let path: String
    let tier: Tier
    let next: NextStep?
    /// What to fix, in plain words (src/items.ts). Missing from servers older than 0.2.
    let items: [Item]?
    /// One request covering every item, backing up first.
    let request: String?

    var id: String { path }

    var toFix: [Item] { items ?? [] }

    /// Work that exists only on this computer: the reason a project is listed first.
    var onlyHere: Bool { toFix.contains { $0.lane == .mac } }

    /// The request to copy: everything at once, or the next step from an older server.
    var ask: String? {
        if let request, !request.isEmpty { return request }
        guard let next, next.tier != .safe, !next.ask.isEmpty else { return nil }
        return next.ask
    }

    /// What's wrong, in a line: the names of the first few things to fix.
    var line: String {
        let titles = toFix.map(\.title)
        guard !titles.isEmpty else { return next?.title ?? tier.verdict }
        let shown = titles.prefix(2).joined(separator: " · ")
        return titles.count > 2 ? "\(shown) · +\(titles.count - 2)" : shown
    }
}

struct Item: Decodable, Identifiable, Sendable {
    enum Lane: String, Decodable, Sendable {
        case mac, check, tidy
    }

    let id: String
    let lane: Lane
    let title: String
}

struct NextStep: Decodable, Sendable {
    let tier: Tier
    let title: String
    let why: String
    let ask: String
}

/// Worst first, so `min()` is the worst of several.
enum Tier: String, Decodable, Sendable, Comparable {
    case atRisk = "at-risk"
    case attention
    case safe

    private var rank: Int {
        switch self {
        case .atRisk: 0
        case .attention: 1
        case .safe: 2
        }
    }

    static func < (a: Tier, b: Tier) -> Bool { a.rank < b.rank }

    var verdict: String {
        switch self {
        case .atRisk: "Could lose work"
        case .attention: "Needs attention"
        case .safe: "All clear"
        }
    }
}

enum Timestamp {
    static func parse(_ iso: String) -> Date? {
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return withFraction.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    }

    /// "just now", "4 min ago", "2 h ago", as the terminal report and the map say it.
    static func ago(_ date: Date, now: Date = .now) -> String {
        let s = max(0, Int(now.timeIntervalSince(date)))
        if s < 60 { return "just now" }
        if s < 3600 { return "\(s / 60) min ago" }
        if s < 86_400 { return "\(s / 3600) h ago" }
        let days = s / 86_400
        return days == 1 ? "1 day ago" : "\(days) days ago"
    }
}
