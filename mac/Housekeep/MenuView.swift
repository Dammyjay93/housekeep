import AppKit
import SwiftUI

/// What opens from the menu bar: the verdict, each project that needs you with its next step and the
/// request to copy for your AI assistant, and the way into the map. The map's materials and type, with
/// the system's own controls on top.
struct MenuView: View {
    @ObservedObject var housekeep: Housekeep
    @ObservedObject var login: LoginItem
    @ObservedObject var updates: Updates
    let openMap: (URL) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Rectangle().fill(Palette.line).frame(height: 1)
            content
            Rectangle().fill(Palette.line).frame(height: 1)
            footer
        }
        .frame(width: 340)
        .background(Palette.shell)
        .environment(\.colorScheme, .dark)
        .onAppear { login.refresh() }
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 8) {
            Image(nsImage: StatusIcon.image(tier: housekeep.phase == .running ? housekeep.snapshot?.worst : nil, height: 10))
            Text("Housekeep").font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.text)
            Spacer()
            Text(summary).font(.system(size: 12)).foregroundStyle(Palette.text2)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
    }

    private var summary: String {
        switch housekeep.phase {
        case .starting: return "Starting"
        case .failed: return "Stopped"
        case .running:
            guard let snapshot = housekeep.snapshot, snapshot.error == nil else { return "" }
            let n = snapshot.needy.count
            if snapshot.projects.isEmpty { return "No projects yet" }
            return n == 0 ? "All clear" : "\(n) need\(n == 1 ? "s" : "") you"
        }
    }

    // MARK: - Content

    @ViewBuilder private var content: some View {
        switch housekeep.phase {
        case .starting:
            note(title: "Looking at your repos", detail: "The first check takes a few seconds.", busy: true)
        case .failed(let message):
            VStack(alignment: .leading, spacing: 10) {
                Text(message).font(.system(size: 12.5)).foregroundStyle(Palette.text2).fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 6) {
                    Button("Try Again") { housekeep.start() }.systemButton(prominent: true).accessibilityLabel("Try again")
                    Button("Show Log") { NSWorkspace.shared.activateFileViewerSelecting([Housekeep.logFile]) }.systemButton()
                        .accessibilityLabel("Show log")
                }
                .controlSize(.small)
            }
            .padding(14)
        case .running:
            if let snapshot = housekeep.snapshot { projects(snapshot) }
        }
    }

    @ViewBuilder private func projects(_ snapshot: Snapshot) -> some View {
        if let error = snapshot.error {
            note(title: error.title, detail: error.detail)
        } else if snapshot.projects.isEmpty {
            note(title: "No projects to watch yet",
                 detail: "Housekeep watches the git repos you've worked on in the last 45 days. Commit to one and it shows up here.")
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 6) {
                    if let version = updates.waiting { updateCard(version) }
                    if !login.answered && !login.enabled { loginCard }
                    ForEach(snapshot.needy) { project in
                        ProjectCard(project: project) { if let url = housekeep.mapURL(slug: project.slug) { openMap(url) } }
                    }
                    if !snapshot.clean.isEmpty { allClear(snapshot.clean, alone: snapshot.needy.isEmpty) }
                }
                .padding(8)
            }
            .frame(maxHeight: 440)
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func allClear(_ clean: [Project], alone: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 9) {
            TierDot(tier: .safe)
            VStack(alignment: .leading, spacing: 2) {
                Text(alone ? "Everything is committed, pushed and in sync." : "All clear")
                    .font(.system(size: 12.5, weight: .medium)).foregroundStyle(alone ? Palette.text : Palette.text2)
                Text(clean.map(\.name).joined(separator: ", "))
                    .font(.system(size: 12)).foregroundStyle(Palette.text3).lineLimit(2)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
    }

    private var loginCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Keep the light on").font(.system(size: 13, weight: .medium)).foregroundStyle(Palette.text)
                Text("Housekeep can start when you log in, so it's always watching.")
                    .font(.system(size: 12)).foregroundStyle(Palette.text2).fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 6) {
                Button("Start at Login") { login.set(true) }.systemButton(prominent: true).accessibilityLabel("Start at login")
                Button("Not Now") { login.answer() }.systemButton().accessibilityLabel("Not now")
            }
            .controlSize(.small)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
    }

    private func updateCard(_ version: String) -> some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Housekeep \(version) is ready").font(.system(size: 13, weight: .medium)).foregroundStyle(Palette.text)
                Text("It installs in a few seconds and reopens.").font(.system(size: 12)).foregroundStyle(Palette.text2)
            }
            Spacer(minLength: 8)
            Button("Install") { updates.check() }.systemButton(prominent: true).controlSize(.small).accessibilityLabel("Install the update")
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
    }

    private func note(title: String, detail: String, busy: Bool = false) -> some View {
        HStack(alignment: .top, spacing: 10) {
            if busy { ProgressView().controlSize(.small) }
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 13, weight: .medium)).foregroundStyle(Palette.text)
                Text(detail).font(.system(size: 12)).foregroundStyle(Palette.text2).fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Footer

    private var footer: some View {
        HStack(spacing: 6) {
            TimelineView(.periodic(from: .now, by: 30)) { context in
                Text(checked(at: context.date)).font(.system(size: 11.5)).foregroundStyle(Palette.text3)
            }
            Spacer()
            Button {
                Task { await housekeep.checkNow() }
            } label: {
                if housekeep.checking {
                    ProgressView().controlSize(.mini)
                } else {
                    Image(systemName: "arrow.clockwise")
                }
            }
            .systemButton()
            .help("Check now: fetch from every remote and look again")
            .accessibilityLabel("Check now")
            .disabled(housekeep.server == nil || housekeep.checking)

            Button("Open Map") { if let url = housekeep.mapURL() { openMap(url) } }
                .systemButton(prominent: true)
                .accessibilityLabel("Open map")
                .disabled(housekeep.server == nil)

            Menu {
                Toggle("Start at Login", isOn: Binding(get: { login.enabled }, set: { login.set($0) }))
                if login.needsApproval { Button("Allow in System Settings…") { login.openSettings() } }
                Divider()
                Button("Check for Updates…") { updates.check() }.disabled(!updates.canCheck)
                Divider()
                Button("How Housekeep Works") { open("https://housekeep.pages.dev") }
                Button("Housekeep on GitHub") { open("https://github.com/Dammyjay93/housekeep") }
                Divider()
                Button("Quit Housekeep") { NSApp.terminate(nil) }.keyboardShortcut("q")
            } label: {
                Image(systemName: "ellipsis")
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .padding(.leading, 4)
        }
        .controlSize(.small)
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
    }

    private func checked(at now: Date) -> String {
        guard housekeep.phase == .running, let at = housekeep.snapshot?.checkedAt else { return "" }
        return "Checked \(Timestamp.ago(at, now: now))"
    }

    private func open(_ link: String) {
        if let url = URL(string: link) { NSWorkspace.shared.open(url) }
    }
}

/// One project that needs you: its next step in plain words, and the request for your assistant.
private struct ProjectCard: View {
    let project: Project
    let open: () -> Void
    @State private var copied = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 9) {
            TierDot(tier: project.tier)
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .firstTextBaseline) {
                    Text(project.name).font(.system(size: 13, weight: .medium)).foregroundStyle(Palette.text).lineLimit(1)
                    Spacer(minLength: 8)
                    Text(project.tier.verdict).font(.system(size: 11.5)).foregroundStyle(Palette.text3)
                }
                if let next = project.next {
                    Text(next.title).font(.system(size: 12.5)).foregroundStyle(Palette.text)
                        .padding(.top, 5).fixedSize(horizontal: false, vertical: true)
                    Text(next.why).font(.system(size: 12)).foregroundStyle(Palette.text2).lineLimit(3)
                        .padding(.top, 2).fixedSize(horizontal: false, vertical: true)
                }
                HStack(spacing: 6) {
                    if let request = project.request {
                        Button { copy(request) } label: {
                            Label(copied ? "Copied" : "Copy Request", systemImage: copied ? "checkmark" : "doc.on.doc")
                        }
                        .systemButton(prominent: true)
                        .help("Copy a request to paste into your AI assistant (Claude Code, Cursor, Codex)")
                        .accessibilityLabel(copied ? "Copied" : "Copy request for \(project.name)")
                    }
                    Button("Open", action: open).systemButton().accessibilityLabel("Open \(project.name) on the map")
                }
                .controlSize(.small)
                .padding(.top, 10)
            }
        }
        .padding(12)
        .card()
    }

    private func copy(_ request: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(request, forType: .string)
        copied = true
        Task {
            try? await Task.sleep(for: .seconds(1.6))
            copied = false
        }
    }
}
