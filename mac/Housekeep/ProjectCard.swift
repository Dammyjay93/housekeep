import SwiftUI

/// One project. Closed: a line to scan, with a request for everything. Open: the map, what to fix with a
/// checkbox each, and exactly what your assistant will do. After you copy, it follows the fix live.
struct ProjectCard: View {
    let project: Project
    let open: Bool
    /// Pinned open on the project's own page, with no header to toggle.
    var pinned = false
    let toggle: () -> Void
    @EnvironmentObject private var sent: SentRequests
    @State private var skipped: Set<String> = []
    @State private var hovering = false

    private var live: SentRequests.Sent? { sent.bySlug[project.slug] }
    private var items: [Item] { project.toFix }
    private var canOpen: Bool { !items.isEmpty || live != nil }
    private var chosen: [Item] { items.filter { !skipped.contains($0.id) } }

    private var tier: Tier {
        guard let live else { return project.tier }
        return live.finished ? .safe : .attention
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !pinned { header }
            if open && canOpen {
                MapView(project: project)
                    .padding(.leading, pinned ? 20 : 40)
                    .padding(.trailing, 20)
                    .padding(.top, pinned ? 18 : 4)
                    .padding(.bottom, 16)
                if let live { progress(live) }
                Rectangle().fill(Palette.line).frame(height: 1)
                HStack(alignment: .top, spacing: 0) {
                    checklist.frame(maxWidth: .infinity, alignment: .leading)
                    Rectangle().fill(Palette.line).frame(width: 1)
                    panel.frame(width: 290)
                }
                .fixedSize(horizontal: false, vertical: true)
            }
        }
        .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(open || hovering ? Palette.layer1 : Palette.shell))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(open || hovering ? Palette.line2 : Palette.line, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .shadow(color: .black.opacity(open && !pinned ? 0.45 : 0), radius: 30, y: 18)
        .animation(.easeOut(duration: 0.16), value: hovering)
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 12) {
            TierDot(tier: tier).frame(width: 12)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text(project.name).font(.system(size: 14.5, weight: .medium)).foregroundStyle(Palette.text)
                    Text(project.shownPath).font(.system(size: 11.5, design: .monospaced)).foregroundStyle(Palette.text3)
                        .lineLimit(1).truncationMode(.middle)
                }
                Text(summary).font(.system(size: 13)).foregroundStyle(live != nil ? Palette.green : Palette.text2).lineLimit(1)
            }
            .layoutPriority(1)
            Spacer(minLength: 12)
            if !open && live == nil {
                // As many tags as fit on one line, never squeezed into two.
                ViewThatFits(in: .horizontal) {
                    tags(3)
                    tags(2)
                    tags(1)
                    Color.clear.frame(width: 0, height: 0)
                }
            }
            if !open && live == nil && canOpen {
                Button { copy(Requests.combined(project, items), items: items) } label: {
                    Label("Copy request", systemImage: "doc.on.doc").roomy()
                }
                .systemButton()
                .help("Copy one request that fixes everything in \(project.name)")
            }
            if canOpen {
                Button(action: toggle) {
                    Image(systemName: "chevron.right").rotationEffect(.degrees(open ? 90 : 0)).frame(width: 14).roomy()
                }
                .systemButton()
                .accessibilityLabel(open ? "Close \(project.name)" : "Open \(project.name)")
            }
        }
        .controlSize(.large)
        .padding(.leading, 22)
        .padding(.trailing, 18)
        .padding(.vertical, 20)
        .contentShape(Rectangle())
        .onTapGesture { if canOpen { toggle() } }
        .onHover { hovering = canOpen && !open && $0 }
    }

    private func tags(_ shown: Int) -> some View {
        HStack(spacing: 6) {
            ForEach(items.prefix(shown)) { item in
                HStack(spacing: 6) {
                    Circle().fill(color(item.lane)).frame(width: 5, height: 5)
                    Text(item.title.count > 26 ? "\(item.title.prefix(24))…" : item.title).lineLimit(1)
                }
                .font(.system(size: 12))
                .foregroundStyle(Palette.text2)
                .padding(.horizontal, 12)
                .frame(height: 30)
                .glassCapsule()
                .fixedSize()
            }
            if items.count > shown {
                Text("+\(items.count - shown)").font(.system(size: 12)).foregroundStyle(Palette.text2)
                    .padding(.horizontal, 12).frame(height: 30).glassCapsule().fixedSize()
            }
        }
    }

    private var summary: String {
        if let live {
            if live.finished { return "All fixed. Everything in the request shows up in git." }
            return live.fixed > 0 ? "\(live.fixed) of \(live.items.count) fixed, the rest is in progress." : "Request copied. Nothing has changed in git yet."
        }
        let mac = items.filter { $0.lane == .mac }, check = items.filter { $0.lane == .check }, tidy = items.filter { $0.lane == .tidy }
        if mac.contains(where: { $0.id == "no-remote" }) { return "Not on \(project.hostName) at all. The whole project exists only on this Mac." }
        if !mac.isEmpty { return "Some work here isn't on \(project.hostName) yet." }
        if let first = check.first { return "\(first.title)." }
        if !tidy.isEmpty { return "Nothing at risk. \(tidy.map(\.title).joined(separator: " and ")) to clear." }
        return project.notes?.first ?? "Everything is in \(project.main?.remoteRef ?? "main")."
    }

    // MARK: - Open

    private func progress(_ live: SentRequests.Sent) -> some View {
        HStack(spacing: 12) {
            HStack(spacing: 4) {
                ForEach(live.items, id: \.id) { entry in
                    Capsule().fill(live.done[entry.id] != nil ? Palette.green : Palette.layer2).frame(height: 4)
                }
            }
            Text("\(live.fixed) of \(live.items.count) fixed").font(.system(size: 12.5)).foregroundStyle(Palette.text2)
        }
        .padding(.horizontal, 20)
        .padding(.leading, pinned ? 0 : 20)
        .padding(.bottom, 16)
        .animation(.easeOut(duration: 0.4), value: live.fixed)
    }

    @ViewBuilder private var checklist: some View {
        VStack(alignment: .leading, spacing: 22) {
            if let live {
                let todo = live.items.filter { live.done[$0.id] == nil }, fixed = live.items.filter { live.done[$0.id] != nil }
                if !todo.isEmpty { lane("Still to do", "Each one turns green when its change shows up in git", Palette.text2) { todo.map { liveRow($0, done: nil) } } }
                if !fixed.isEmpty { lane("Fixed", "Seen in git", Palette.green) { fixed.map { liveRow($0, done: live.done[$0.id]) } } }
            } else {
                ForEach(Item.Lane.allCases, id: \.self) { which in
                    let rows = items.filter { $0.lane == which }
                    if !rows.isEmpty { lane(title(which), hint(which), color(which)) { rows.map { checkRow($0) } } }
                }
            }
            ForEach(project.notes ?? [], id: \.self) { note in
                Text(note).font(.system(size: 12.5)).foregroundStyle(Palette.text3).fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 22)
        .padding(.trailing, 20)
        .padding(.leading, pinned ? 20 : 40)
    }

    private func lane(_ title: String, _ hint: String, _ color: Color, rows: () -> [AnyView]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(title).font(.system(size: 12.5, weight: .medium)).foregroundStyle(color)
                Text(hint).font(.system(size: 12)).foregroundStyle(Palette.text3)
            }
            VStack(spacing: 0) {
                let built = rows()
                ForEach(built.indices, id: \.self) { index in
                    if index > 0 { Rectangle().fill(Palette.line).frame(height: 1) }
                    built[index]
                }
            }
            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Palette.shell))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Palette.line, lineWidth: 1))
        }
    }

    private func checkRow(_ item: Item) -> AnyView {
        let on = Binding(get: { !skipped.contains(item.id) }, set: { if $0 { skipped.remove(item.id) } else { skipped.insert(item.id) } })
        return AnyView(
            Toggle(isOn: on) { rowText(item.title, item.why, item.where, dim: false) }
                .toggleStyle(.checkbox)
                .padding(.horizontal, 14)
                .padding(.vertical, 11)
        )
    }

    private func liveRow(_ entry: SentRequests.Sent.Entry, done: Date?) -> AnyView {
        AnyView(
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: done != nil ? "checkmark.circle.fill" : "circle.dashed")
                    .foregroundStyle(done != nil ? Palette.green : Palette.text3)
                    .font(.system(size: 15))
                rowText(entry.title, done.map { "Fixed at \($0.formatted(date: .omitted, time: .shortened))" } ?? entry.why,
                        items.first { $0.id == entry.id }?.where ?? "", dim: done != nil)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 11)
        )
    }

    private func rowText(_ title: String, _ why: String, _ place: String, dim: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 13.5, weight: .medium)).foregroundStyle(dim ? Palette.text2 : Palette.text)
                Text(why).font(.system(size: 12.5)).foregroundStyle(dim ? Palette.text3 : Palette.text2).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            Text(place).font(.system(size: 11, design: .monospaced)).foregroundStyle(Palette.text3).lineLimit(1).truncationMode(.middle)
                .frame(maxWidth: 200, alignment: .trailing)
        }
    }

    @ViewBuilder private var panel: some View {
        VStack(alignment: .leading, spacing: 16) {
            if let live {
                Label("Request copied at \(live.at.formatted(date: .omitted, time: .shortened))", systemImage: "checkmark")
                    .font(.system(size: 12.5)).foregroundStyle(Palette.text)
                    .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 10).fill(Palette.green.opacity(0.08)))
                    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Palette.green.opacity(0.22), lineWidth: 1))
                VStack(alignment: .leading, spacing: 4) {
                    Text(live.finished ? "All fixed" : "Changes seen in git").font(.system(size: 13.5, weight: .medium)).foregroundStyle(Palette.text)
                    Text(live.finished ? "Every change landed in git." : "Housekeep ticks each item off as its change lands in git. No need to keep checking.")
                        .font(.system(size: 12)).foregroundStyle(Palette.text3).fixedSize(horizontal: false, vertical: true)
                }
                ForEach(live.items.filter { live.done[$0.id] != nil }, id: \.id) { entry in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(live.done[entry.id]!.formatted(date: .omitted, time: .shortened)).font(.system(size: 10.5, design: .monospaced)).foregroundStyle(Palette.text3)
                        Text(entry.title).font(.system(size: 12)).foregroundStyle(Palette.text)
                    }
                }
                Spacer(minLength: 0)
                if !live.finished {
                    Button { copy(Requests.combined(project, items.filter { item in live.items.contains { $0.id == item.id } }), items: nil) } label: {
                        Label("Copy request again", systemImage: "doc.on.doc").frame(maxWidth: .infinity).roomy()
                    }
                    .systemButton()
                    .controlSize(.large)
                }
                Button(live.finished ? "Done" : "Stop watching") { sent.forget(project.slug) }
                    .buttonStyle(.plain).foregroundStyle(Palette.text2).frame(maxWidth: .infinity)
            } else {
                VStack(alignment: .leading, spacing: 4) {
                    Text("What your assistant will do").font(.system(size: 13.5, weight: .medium)).foregroundStyle(Palette.text)
                    Text("In this order. It backs up first and asks before deleting anything on the remote.")
                        .font(.system(size: 12)).foregroundStyle(Palette.text3).fixedSize(horizontal: false, vertical: true)
                }
                if chosen.isEmpty {
                    Text("Tick at least one thing to fix.").font(.system(size: 12.5)).foregroundStyle(Palette.text3)
                } else {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(Array(chosen.enumerated()), id: \.element.id) { index, item in
                            HStack(alignment: .firstTextBaseline, spacing: 10) {
                                Text("\(index + 1)").font(.system(size: 10.5)).foregroundStyle(Palette.text2)
                                    .frame(width: 20, height: 20).background(Circle().fill(Palette.layer2))
                                Text(item.step).font(.system(size: 12.5)).foregroundStyle(Palette.text).fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                }
                Spacer(minLength: 0)
                Button { copy(Requests.combined(project, chosen), items: chosen) } label: {
                    Label("Copy request", systemImage: "doc.on.doc").frame(maxWidth: .infinity).roomy()
                }
                .systemButton(prominent: true)
                .controlSize(.large)
                .disabled(chosen.isEmpty)
                Text("Paste it into Claude Code, Codex or Cursor, opened in \(project.shownPath).")
                    .font(.system(size: 11.5)).foregroundStyle(Palette.text3).multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity).fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(20)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Palette.shell)
    }

    // MARK: - Helpers

    private func copy(_ text: String, items: [Item]?) {
        Requests.copy(text)
        if let items { sent.remember(project, items: items) }
    }

    private func title(_ lane: Item.Lane) -> String {
        switch lane {
        case .mac: "Only on this Mac"
        case .check: "Needs a check"
        case .tidy: "Tidy up"
        }
    }

    private func hint(_ lane: Item.Lane) -> String {
        switch lane {
        case .mac: "Lost if this Mac is"
        case .check: "Nothing lost yet"
        case .tidy: "Already in main, safe to clear"
        }
    }

    private func color(_ lane: Item.Lane) -> Color {
        switch lane {
        case .mac: Palette.red
        case .check: Palette.amber
        case .tidy: Palette.green
        }
    }
}

private extension View {
    /// Room inside a glass button: macOS gives each control size a fixed, tight height, so the label
    /// carries the extra space itself. Makes card buttons about 38pt tall.
    func roomy() -> some View { padding(.vertical, 5).padding(.horizontal, 3) }
}
