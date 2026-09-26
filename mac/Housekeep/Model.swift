import Foundation

/// Housekeep's state as the server sends it (src/model.ts): what the menu and the window read. Fields
/// newer servers add are optional, so an older or newer server never breaks the app.
struct Snapshot: Decodable, Sendable {
    let generatedAt: String
    let projects: [Project]
    let error: SnapshotError?
    let notices: [String]?
    let activeDays: Int?
    /// One request that cleans up every project with something to fix, one repository at a time.
    let request: String?

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
    let displayPath: String?
    let host: String?
    let error: String?
    let tier: Tier
    let next: NextStep?
    /// What to fix, in plain words (src/items.ts). Missing from servers older than 0.2.
    let items: [Item]?
    /// Worth knowing, nothing to do: work safe on the remote, waiting for a pull request.
    let notes: [String]?
    /// One request covering every item, backing up first.
    let request: String?
    let main: MainFacts?
    let head: Head?
    let fetch: FetchInfo?
    let branches: [Branch]?
    let remoteBranches: [RemoteBranch]?
    let checkouts: [Checkout]?

    var id: String { path }
    var shownPath: String { displayPath ?? path }
    var hostName: String { host ?? "the remote" }

    /// What to fix. An older server sends no items: its next step stands in, so nothing looks clear that isn't.
    var toFix: [Item] {
        if let items { return items }
        guard let next, next.tier != .safe, !next.ask.isEmpty else { return [] }
        return [Item(id: "next", lane: tier == .atRisk ? .mac : .check, title: next.title, why: next.why, where: "", step: next.title, ask: next.ask)]
    }

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

struct Item: Decodable, Identifiable, Sendable, Hashable {
    enum Lane: String, Decodable, Sendable, CaseIterable {
        case mac, check, tidy
    }

    let id: String
    let lane: Lane
    let title: String
    let why: String
    let `where`: String
    let step: String
    let ask: String
}

struct MainFacts: Decodable, Sendable {
    let name: String
    let local: Bool
    let remoteMain: Bool
    let remoteRef: String?
    let ahead: Int?
    let behind: Int?
}

struct Head: Decodable, Sendable {
    let branch: String?
}

struct FetchInfo: Decodable, Sendable {
    let hasRemote: Bool
    let at: String?
    let error: String?
}

struct Branch: Decodable, Sendable, Identifiable {
    enum State: String, Decodable, Sendable {
        case unpushed, unmerged, merged, kept
    }

    let name: String
    let state: State
    let note: String
    let localOnly: Int
    let aheadOfMain: Int
    let behindUpstream: Int
    let upstreamGone: Bool
    let lastCommit: Double?
    let worktree: String?
    let current: Bool

    var id: String { name }
}

struct RemoteBranch: Decodable, Sendable, Identifiable {
    let name: String
    let merged: String?
    let kept: String?
    let blockedBy: String?
    let deletable: Bool
    let aheadOfMain: Int
    let lastCommit: Double?

    var id: String { name }
}

struct Checkout: Decodable, Sendable, Identifiable {
    let path: String
    let label: String
    let branch: String?
    let primary: Bool
    let missing: Bool
    let changed: Int
    let untracked: Int
    let tier: Tier

    var id: String { path }
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
