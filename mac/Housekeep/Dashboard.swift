import AppKit
import SwiftUI

/// Where the window is: the overview, or one project.
@MainActor
final class Navigator: ObservableObject {
    enum Place: Hashable {
        case overview
        case project(String)
    }

    @Published var place: Place? = .overview
    /// Set when you ask for the window, so one SwiftUI restores on its own at launch can close again.
    var requested = false
}

/// Housekeep's window, native: projects on the left, and on the right either every project as a card
/// you can scan or open, or one project with its details. Everything follows the server live.
struct DashboardView: View {
    @ObservedObject var housekeep: Housekeep
    @EnvironmentObject private var navigator: Navigator
    @EnvironmentObject private var sent: SentRequests

    private var projects: [Project] { housekeep.snapshot?.projects ?? [] }

    var body: some View {
        NavigationSplitView {
            List(selection: $navigator.place) {
                Label("Overview", systemImage: "square.grid.2x2").tag(Navigator.Place.overview)
                Section("Projects") {
                    ForEach(projects) { project in
                        HStack(spacing: 9) {
                            TierDot(tier: sent.bySlug[project.slug].map { $0.finished ? .safe : .attention } ?? project.tier).frame(width: 12)
                            Text(project.name).lineLimit(1)
                        }
                        .tag(Navigator.Place.project(project.slug))
                    }
                }
            }
            .navigationSplitViewColumnWidth(min: 200, ideal: 230, max: 320)
        } detail: {
            detail
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Palette.shell)
                .toolbar { toolbar }
        }
        .navigationTitle(title)
        .onReceive(housekeep.$snapshot) { if let snapshot = $0 { sent.update(with: snapshot) } }
        .preferredColorScheme(.dark)
        .frame(minWidth: 960, minHeight: 600)
        .background(WindowCloser(keep: navigator.requested))
    }

    private var title: String {
        if case .project(let slug) = navigator.place, let project = projects.first(where: { $0.slug == slug }) { return project.name }
        return "Overview"
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .automatic) {
            TimelineView(.periodic(from: .now, by: 30)) { context in
                HStack(spacing: 6) {
                    Circle().fill(housekeep.server == nil ? Palette.amber : Palette.green).frame(width: 6, height: 6)
                    Text(status(at: context.date)).font(.system(size: 12)).foregroundStyle(Palette.text2)
                }
                .padding(.horizontal, 6)
            }
        }
        ToolbarItem(placement: .primaryAction) {
            Button {
                Task { await housekeep.checkNow() }
            } label: {
                if housekeep.checking { ProgressView().controlSize(.small) } else { Label("Check now", systemImage: "arrow.clockwise") }
            }
            .help("Fetch from every remote and look again")
            .disabled(housekeep.server == nil || housekeep.checking)
        }
    }

    private func status(at now: Date) -> String {
        guard housekeep.server != nil else { return "Reconnecting" }
        guard let at = housekeep.snapshot?.checkedAt else { return "Live" }
        return "Live · checked \(Timestamp.ago(at, now: now))"
    }

    @ViewBuilder private var detail: some View {
        switch housekeep.phase {
        case .starting:
            ProgressView("Looking at your repos").foregroundStyle(Palette.text2)
        case .failed(let message):
            Text(message).foregroundStyle(Palette.text2).padding(40)
        case .running:
            if let error = housekeep.snapshot?.error {
                empty(error.title, error.detail)
            } else if projects.isEmpty {
                empty("Nothing active to watch", "No git projects have changed in the last \(housekeep.snapshot?.activeDays ?? 45) days.")
            } else if case .project(let slug) = navigator.place, let project = projects.first(where: { $0.slug == slug }) {
                ProjectPage(project: project)
            } else {
                Overview(projects: projects, notices: housekeep.snapshot?.notices ?? [], request: housekeep.snapshot?.request ?? "")
            }
        }
    }

    private func empty(_ title: String, _ detail: String) -> some View {
        VStack(spacing: 10) {
            Text(title).font(.system(size: 26, weight: .medium)).foregroundStyle(Palette.text)
            Text(detail).foregroundStyle(Palette.text2).multilineTextAlignment(.center).frame(maxWidth: 420)
        }
    }
}

// MARK: - Overview

private struct Overview: View {
    let projects: [Project]
    let notices: [String]
    /// The request that cleans up every project at once.
    let request: String
    @EnvironmentObject private var sent: SentRequests
    @State private var openSlug: String?
    @State private var copied = false

    private var onlyHere: [Project] { projects.filter { $0.onlyHere || sent.bySlug[$0.slug] != nil } }
    private var worthALook: [Project] { projects.filter { p in !onlyHere.contains { $0.slug == p.slug } && !p.toFix.isEmpty } }
    private var clear: [Project] { projects.filter { p in !onlyHere.contains { $0.slug == p.slug } && p.toFix.isEmpty } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .bottom, spacing: 24) {
                    VStack(alignment: .leading, spacing: 10) {
                        Text(headline).font(.system(size: 32, weight: .medium)).tracking(-0.8).foregroundStyle(Palette.text)
                        Text(subline).font(.system(size: 14)).foregroundStyle(Palette.text2)
                        ForEach(notices, id: \.self) { Text($0).font(.system(size: 12.5)).foregroundStyle(Palette.amber) }
                    }
                    Spacer(minLength: 0)
                    if !request.isEmpty { cleanUpEverything }
                }
                .padding(.bottom, 18)
                group("Not on the remote yet", onlyHere)
                group("Worth a look", worthALook)
                group("All clear", clear)
            }
            .frame(maxWidth: 1080)
            .padding(.horizontal, 36)
            .padding(.vertical, 32)
            .frame(maxWidth: .infinity)
        }
        .onAppear { if openSlug == nil { openSlug = onlyHere.first?.slug ?? worthALook.first?.slug } }
    }

    /// One request for every project, repository by repository; each card then follows its part live.
    private var cleanUpEverything: some View {
        let todo = projects.filter { !$0.toFix.isEmpty }
        return VStack(alignment: .trailing, spacing: 6) {
            Button {
                Requests.copy(request)
                for project in todo { sent.remember(project, items: project.toFix) }
                copied = true
                Task { try? await Task.sleep(for: .seconds(1.6)); copied = false }
            } label: {
                Label(copied ? "Copied" : "Clean up everything", systemImage: copied ? "checkmark" : "sparkles").padding(.vertical, 5).padding(.horizontal, 3)
            }
            .systemButton(prominent: true)
            .controlSize(.large)
            .help("Copy one request that cleans up all \(todo.count) projects, one at a time, asking before anything risky")
            Text("\(todo.count) projects, one at a time. Paste into Claude Code opened in your home folder.")
                .font(.system(size: 11.5)).foregroundStyle(Palette.text3)
        }
    }

    private var headline: String {
        if onlyHere.isEmpty && worthALook.isEmpty { return projects.count == 1 ? "Your project is safe" : "All \(projects.count) projects are safe" }
        if !onlyHere.isEmpty { return onlyHere.count == 1 ? "1 project has work only on this Mac" : "\(onlyHere.count) projects have work only on this Mac" }
        return worthALook.count == 1 ? "1 project needs a look" : "\(worthALook.count) projects need a look"
    }

    private var subline: String {
        onlyHere.isEmpty && worthALook.isEmpty ? "Everything is committed, pushed and in main. Housekeep keeps watching."
            : "Riskiest first. Open a project, pick what to fix, and copy one request for your AI assistant."
    }

    @ViewBuilder private func group(_ title: String, _ list: [Project]) -> some View {
        if !list.isEmpty {
            HStack {
                Text(title).font(.system(size: 13, weight: .medium)).foregroundStyle(Palette.text2)
                Spacer()
                Text("\(list.count)").font(.system(size: 12.5)).foregroundStyle(Palette.text3)
            }
            .padding(.horizontal, 4)
            .padding(.top, 14)
            ForEach(list) { project in
                ProjectCard(project: project, open: openSlug == project.slug) {
                    withAnimation(.easeOut(duration: 0.22)) { openSlug = openSlug == project.slug ? nil : project.slug }
                }
            }
        }
    }
}

// MARK: - One project

private struct ProjectPage: View {
    let project: Project

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .bottom) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(project.name).font(.system(size: 32, weight: .medium)).tracking(-0.8).foregroundStyle(Palette.text)
                        HStack(spacing: 10) {
                            Text(project.shownPath).font(.system(size: 12, design: .monospaced))
                            if let branch = project.head?.branch { Text("on \(branch)").font(.system(size: 12, design: .monospaced)) }
                            if let error = project.fetch?.error { Text(error).foregroundStyle(Palette.amber) }
                        }
                        .foregroundStyle(Palette.text3)
                    }
                    Spacer()
                    HStack(spacing: 8) {
                        Button { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: project.path)]) } label: {
                            Label("Show in Finder", systemImage: "folder")
                        }
                        .systemButton()
                        Button { openTerminal() } label: { Label("Open in Terminal", systemImage: "terminal") }
                            .systemButton()
                    }
                }
                .padding(.bottom, 10)
                if let error = project.error {
                    Text(error).foregroundStyle(Palette.text2)
                } else {
                    ProjectCard(project: project, open: true, pinned: true) {}
                    Details(project: project).padding(.top, 20)
                }
            }
            .frame(maxWidth: 1080)
            .padding(.horizontal, 36)
            .padding(.vertical, 32)
            .frame(maxWidth: .infinity)
        }
    }

    private func openTerminal() {
        guard let terminal = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.Terminal") else { return }
        NSWorkspace.shared.open([URL(fileURLWithPath: project.path)], withApplicationAt: terminal, configuration: NSWorkspace.OpenConfiguration())
    }
}

/// Every branch here and on the remote, and every folder the project is checked out in.
private struct Details: View {
    let project: Project

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Details").font(.system(size: 13, weight: .medium)).foregroundStyle(Palette.text2)
                Text("Every branch here and on the remote, and every folder this project is checked out in.")
                    .font(.system(size: 12.5)).foregroundStyle(Palette.text3)
            }
            section("Branches here", (project.branches ?? []).map { b in
                row(b.name, badge: b.current ? "HEAD" : nil, status: b.state.rawValue.capitalized, tier: tier(b.state), note: b.note, when: b.lastCommit)
            })
            section("Branches on \(project.hostName)", (project.remoteBranches ?? []).map { r in
                row(r.name, badge: nil, status: r.merged != nil ? "Merged" : r.kept != nil ? "Kept" : "Unmerged",
                    tier: r.merged != nil ? .safe : .attention, note: r.blockedBy ?? r.kept ?? (r.merged != nil ? "In main" : "\(r.aheadOfMain) commits not in main"), when: r.lastCommit)
            })
            section("Worktrees", (project.checkouts ?? []).map { c in
                let n = c.changed + c.untracked
                return row(c.primary ? "Main folder" : c.label, badge: nil, status: c.missing ? "Folder gone" : n > 0 ? "\(n) uncommitted" : "Clean",
                           tier: c.tier, note: c.branch.map { "on \($0)" } ?? "detached", when: nil)
            })
        }
    }

    private func tier(_ state: Branch.State) -> Tier {
        switch state {
        case .unpushed: .atRisk
        case .unmerged: .attention
        case .merged, .kept: .safe
        }
    }

    @ViewBuilder private func section(_ title: String, _ rows: [AnyView]) -> some View {
        if !rows.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                Text(title).font(.system(size: 13.5, weight: .medium)).foregroundStyle(Palette.text).padding(16)
                ForEach(rows.indices, id: \.self) { index in
                    Rectangle().fill(Palette.line).frame(height: 1)
                    rows[index]
                }
            }
            .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Palette.shell))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Palette.line, lineWidth: 1))
        }
    }

    private func row(_ name: String, badge: String?, status: String, tier: Tier, note: String, when: Double?) -> AnyView {
        AnyView(
            HStack(spacing: 14) {
                HStack(spacing: 8) {
                    Text(name).font(.system(size: 13)).foregroundStyle(Palette.text).lineLimit(1).truncationMode(.middle)
                    if let badge { Text(badge).font(.system(size: 10, weight: .semibold)).foregroundStyle(Palette.accent) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                HStack(spacing: 7) {
                    TierDot(tier: tier)
                    Text(status).font(.system(size: 12.5)).foregroundStyle(Palette.text)
                }
                .frame(width: 130, alignment: .leading)
                Text(note).font(.system(size: 12.5)).foregroundStyle(Palette.text2).lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(when.map { Timestamp.ago(Date(timeIntervalSince1970: $0)) } ?? "").font(.system(size: 12)).foregroundStyle(Palette.text3)
                    .frame(width: 90, alignment: .trailing)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 11)
        )
    }
}

/// Housekeep lives in the menu bar: its window opens when you ask for it, never on its own at launch.
/// macOS 15 and later are told so up front; before that, a window that appears unasked closes again.
private struct WindowCloser: NSViewRepresentable {
    let keep: Bool

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        guard !keep else { return view }
        DispatchQueue.main.async { view.window?.close() }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {}
}
