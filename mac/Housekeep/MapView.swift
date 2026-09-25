import SwiftUI

/// The map: main as a track, every branch a line that leaves it. Work that exists only here, where you
/// are, and extra checkouts get lines of their own; everything else folds into two sidings, so the map
/// stays calm. The same drawing as the dashboard's (assets/dashboard.html), in native shapes.
struct MapView: View {
    let project: Project

    private struct Row {
        enum Kind {
            case branch(Branch)
            case group(state: Branch.State, count: Int, title: String, note: String)
        }

        let kind: Kind
        var state: Branch.State {
            switch kind {
            case .branch(let b): b.state
            case .group(let state, _, _, _): state
            }
        }
    }

    private static let row: CGFloat = 54
    private static let top: CGFloat = 22

    private var rows: [Row] {
        let branches = project.branches ?? []
        func rank(_ b: Branch) -> Int {
            if b.current { return 0 }
            if b.state == .unpushed { return 1 }
            if b.worktree != nil && b.state != .merged { return 2 }
            if b.state == .unmerged { return 3 }
            return b.worktree != nil ? 4 : 9
        }
        let own = branches.filter { rank($0) < 9 }
            .sorted { rank($0) != rank($1) ? rank($0) < rank($1) : ($0.lastCommit ?? 0) > ($1.lastCommit ?? 0) }
            .prefix(5)
        let rest = branches.filter { b in !own.contains { $0.name == b.name } }
        var out = own.map { Row(kind: .branch($0)) }
        let names = { (list: [Branch]) -> String in
            let shown = list.prefix(2).map { $0.name.split(separator: "/").last.map(String.init) ?? $0.name }.joined(separator: ", ")
            return list.count > 2 ? "\(shown) and \(list.count - 2) more" : shown
        }
        let waiting = rest.filter { $0.state == .unmerged || $0.state == .unpushed }
        let done = rest.filter { $0.state == .merged }
        if !waiting.isEmpty {
            out.append(Row(kind: .group(state: .unmerged, count: waiting.count,
                                        title: waiting.count == 1 ? "1 more branch" : "\(waiting.count) more branches",
                                        note: "Unmerged: \(names(waiting))")))
        }
        if !done.isEmpty {
            out.append(Row(kind: .group(state: .merged, count: done.count,
                                        title: done.count == 1 ? "1 merged branch" : "\(done.count) merged branches",
                                        note: "Safe to delete: \(names(done))")))
        }
        return out
    }

    private var split: Bool {
        guard let m = project.main, m.remoteMain else { return false }
        return (m.ahead ?? 0) > 0 || (m.behind ?? 0) > 0
    }

    private var height: CGFloat {
        let mainY = split ? Self.top + Self.row : Self.top
        return mainY + CGFloat(rows.count) * Self.row + 20
    }

    var body: some View {
        Canvas { context, size in draw(in: context, width: size.width) }
            .frame(height: height)
            .accessibilityElement()
            .accessibilityLabel("Map of \(project.name): main and \(rows.count) branch lines")
    }

    // MARK: - Drawing

    private func draw(in context: GraphicsContext, width: CGFloat) {
        let rows = self.rows
        let m = project.main
        let termX = min(width - 320, 500)
        let junction = termX - 150
        let mainY = split ? Self.top + Self.row : Self.top
        let githubY = Self.top
        let forkRoom = split ? junction - 40 : termX - 150
        let gap = rows.count > 1 ? max(14, min(26, (forkRoom - 30) / CGFloat(rows.count - 1))) : 0
        let mainRef = m?.remoteRef ?? "origin/\(m?.name ?? "main")"
        let onMain = project.head?.branch != nil && project.head?.branch == m?.name
        let primary = project.checkouts?.first { $0.primary }
        let unsaved = (primary?.changed ?? 0) + (primary?.untracked ?? 0)
        let unsavedNote = unsaved > 0 ? " · \(unsaved) uncommitted change\(unsaved == 1 ? "" : "s")" : ""

        for (i, row) in rows.enumerated() {
            let y = mainY + CGFloat(i + 1) * Self.row
            let fx = forkRoom - CGFloat(i) * gap
            var line = Path()
            line.move(to: CGPoint(x: fx, y: mainY))
            line.addLine(to: CGPoint(x: fx + 10, y: mainY + 10))
            line.addLine(to: CGPoint(x: fx + 10, y: y - 10))
            line.addLine(to: CGPoint(x: fx + 20, y: y))
            line.addLine(to: CGPoint(x: termX, y: y))
            let (color, width, dash): (Color, CGFloat, [CGFloat]) = switch row.state {
            case .unpushed: (Palette.amber, 3.5, [])
            case .unmerged: (Palette.trackSoft, 3.5, [])
            case .merged: (Palette.trackSoft, 3, [0.5, 6])
            case .kept: (Palette.trackSoft, 3, [])
            }
            context.stroke(line, with: .color(color), style: StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round, dash: dash))

            switch row.kind {
            case .group(let state, let count, let title, let note):
                counter(context, at: CGPoint(x: termX, y: y), count: count, color: color, dashed: state == .merged)
                label(context, x: termX + 27, y: y, title: title, note: note, noteColor: Palette.text3, width: width)
            case .branch(let b):
                if b.current { youAreHere(context, at: CGPoint(x: termX, y: y)) }
                else if b.worktree != nil { depot(context, at: CGPoint(x: termX, y: y), color: color) }
                else { station(context, at: CGPoint(x: termX, y: y), color: color) }
                var note = switch b.state {
                case .unpushed: "\(b.localOnly) unpushed commit\(b.localOnly == 1 ? "" : "s")"
                case .kept, .merged: b.note
                case .unmerged:
                    b.upstreamGone ? "Upstream gone, work not in main"
                        : b.behindUpstream > 0 ? "Behind its upstream by \(b.behindUpstream) commit\(b.behindUpstream == 1 ? "" : "s")"
                        : "Unmerged · \(b.aheadOfMain) commit\(b.aheadOfMain == 1 ? "" : "s") not in \(mainRef)"
                }
                if b.current { note += unsavedNote }
                let warn = b.state == .unpushed || (b.current && unsaved > 0)
                label(context, x: termX + 22, y: y, title: b.name, note: note, noteColor: warn ? Palette.amber : Palette.text3,
                      tag: b.current ? ("YOU ARE HERE", Palette.accent) : b.worktree != nil ? ("WORKTREE", Palette.text3) : nil, width: width)
            }
        }

        let track = StrokeStyle(lineWidth: 4.5, lineCap: .round)
        guard let m, !m.name.isEmpty, m.remoteMain else {
            var line = Path()
            line.move(to: CGPoint(x: 6, y: mainY))
            line.addLine(to: CGPoint(x: termX, y: mainY))
            let color = m?.name.isEmpty == false ? Palette.amber : Palette.track
            context.stroke(line, with: .color(color), style: track)
            onMain ? youAreHere(context, at: CGPoint(x: termX, y: mainY)) : station(context, at: CGPoint(x: termX, y: mainY), color: color)
            let why = m?.name.isEmpty != false ? "No main branch in this project"
                : project.fetch?.hasRemote == true ? "\(project.hostName) has no \(m?.name ?? "main") to compare with"
                : "No remote: this repo isn't pushed anywhere"
            label(context, x: termX + 22, y: mainY, title: m?.name.isEmpty == false ? m!.name : "history", note: why + (onMain ? unsavedNote : ""),
                  noteColor: Palette.amber, tag: onMain ? ("YOU ARE HERE", Palette.accent) : nil, width: width)
            return
        }
        if !m.local {
            var line = Path()
            line.move(to: CGPoint(x: 6, y: mainY))
            line.addLine(to: CGPoint(x: termX, y: mainY))
            context.stroke(line, with: .color(Palette.track), style: track)
            station(context, at: CGPoint(x: termX, y: mainY), color: Palette.track)
            label(context, x: termX + 22, y: mainY, title: mainRef, note: "No local \(m.name) here", noteColor: Palette.text3, width: width)
        } else if !split {
            // The interchange: this computer's main and the server's main are one station.
            var line = Path()
            line.move(to: CGPoint(x: 6, y: mainY))
            line.addLine(to: CGPoint(x: termX - 13, y: mainY))
            context.stroke(line, with: .color(Palette.track), style: track)
            context.fill(Path(roundedRect: CGRect(x: termX - 13, y: mainY - 7.5, width: 26, height: 15), cornerRadius: 7.5), with: .color(Palette.shell))
            context.stroke(Path(roundedRect: CGRect(x: termX - 13, y: mainY - 7.5, width: 26, height: 15), cornerRadius: 7.5), with: .color(Palette.track), lineWidth: 3)
            if onMain { youAreHere(context, at: CGPoint(x: termX, y: mainY)) }
            label(context, x: termX + 28, y: mainY, title: m.name, note: "Up to date with \(mainRef)" + (onMain ? unsavedNote : ""),
                  noteColor: onMain && unsaved > 0 ? Palette.amber : Palette.text3, tag: onMain ? ("YOU ARE HERE", Palette.accent) : nil, width: width)
        } else {
            // Shared history to the junction; the server's main peels off above, this computer's runs on below.
            let ahead = m.ahead ?? 0, behind = m.behind ?? 0
            var shared = Path()
            shared.move(to: CGPoint(x: 6, y: mainY))
            shared.addLine(to: CGPoint(x: junction, y: mainY))
            context.stroke(shared, with: .color(Palette.track), style: track)
            var up = Path()
            up.move(to: CGPoint(x: junction, y: mainY))
            up.addLine(to: CGPoint(x: junction + Self.row, y: githubY))
            up.addLine(to: CGPoint(x: termX, y: githubY))
            context.stroke(up, with: .color(Palette.track), style: track)
            var local = Path()
            local.move(to: CGPoint(x: junction, y: mainY))
            local.addLine(to: CGPoint(x: termX, y: mainY))
            context.stroke(local, with: .color(ahead > 0 ? Palette.amber : Palette.track), style: track)
            let mid = (junction + Self.row + termX) / 2
            if behind > 0 { badge(context, at: CGPoint(x: mid, y: githubY), text: "+\(behind)", fill: Palette.track) }
            if ahead > 0 { badge(context, at: CGPoint(x: mid, y: mainY), text: "+\(ahead)", fill: Palette.amber) }
            context.fill(Path(ellipseIn: CGRect(x: junction - 4, y: mainY - 4, width: 8, height: 8)), with: .color(Palette.track))
            station(context, at: CGPoint(x: termX, y: githubY), color: Palette.track)
            onMain ? youAreHere(context, at: CGPoint(x: termX, y: mainY)) : station(context, at: CGPoint(x: termX, y: mainY), color: ahead > 0 ? Palette.amber : Palette.track)
            label(context, x: termX + 22, y: githubY, title: mainRef, note: behind > 0 ? "\(behind) commit\(behind == 1 ? "" : "s") to pull" : "Nothing new",
                  noteColor: Palette.text3, width: width)
            let mine = ahead > 0 ? "\(ahead) commit\(ahead == 1 ? "" : "s") \(mainRef) doesn't have" : "Behind \(mainRef)"
            label(context, x: termX + 22, y: mainY, title: "\(m.name) (local)", note: mine + (onMain ? unsavedNote : ""),
                  noteColor: ahead > 0 || (onMain && unsaved > 0) ? Palette.amber : Palette.text3, tag: onMain ? ("YOU ARE HERE", Palette.accent) : nil, width: width)
        }
    }

    // MARK: - Marks

    private func station(_ context: GraphicsContext, at p: CGPoint, color: Color) {
        let rect = CGRect(x: p.x - 5, y: p.y - 5, width: 10, height: 10)
        context.fill(Path(ellipseIn: rect), with: .color(Palette.shell))
        context.stroke(Path(ellipseIn: rect), with: .color(color), lineWidth: 3)
    }

    private func depot(_ context: GraphicsContext, at p: CGPoint, color: Color) {
        let rect = Path(roundedRect: CGRect(x: p.x - 5.5, y: p.y - 5.5, width: 11, height: 11), cornerRadius: 3)
        context.fill(rect, with: .color(Palette.shell))
        context.stroke(rect, with: .color(color), lineWidth: 3)
    }

    private func youAreHere(_ context: GraphicsContext, at p: CGPoint) {
        context.fill(Path(ellipseIn: CGRect(x: p.x - 8, y: p.y - 8, width: 16, height: 16)), with: .color(Palette.accent.opacity(0.25)))
        context.fill(Path(ellipseIn: CGRect(x: p.x - 4.5, y: p.y - 4.5, width: 9, height: 9)), with: .color(Palette.accent))
    }

    private func counter(_ context: GraphicsContext, at p: CGPoint, count: Int, color: Color, dashed: Bool) {
        let rect = CGRect(x: p.x - 11, y: p.y - 9, width: 22, height: 18)
        let shape = Path(roundedRect: rect, cornerRadius: 9)
        context.fill(shape, with: .color(Palette.shell))
        context.stroke(shape, with: .color(color), style: StrokeStyle(lineWidth: 2, dash: dashed ? [2, 3] : []))
        context.draw(Text("\(count)").font(.system(size: 10, weight: .medium)).foregroundColor(Palette.text2), at: p)
    }

    private func badge(_ context: GraphicsContext, at p: CGPoint, text: String, fill: Color) {
        let resolved = context.resolve(Text(text).font(.system(size: 10, weight: .semibold)).foregroundColor(.black))
        let size = resolved.measure(in: CGSize(width: 200, height: 20))
        let rect = CGRect(x: p.x - size.width / 2 - 7, y: p.y - 9, width: size.width + 14, height: 18)
        context.fill(Path(roundedRect: rect, cornerRadius: 9), with: .color(fill))
        context.draw(resolved, at: p)
    }

    private func label(_ context: GraphicsContext, x: CGFloat, y: CGFloat, title: String, note: String, noteColor: Color,
                       tag: (String, Color)? = nil, width: CGFloat) {
        let room = max(80, width - x - 8)
        let name = context.resolve(Text(title).font(.system(size: 13.5)).foregroundColor(Palette.text))
        let nameSize = name.measure(in: CGSize(width: room, height: 20))
        context.draw(name, in: CGRect(x: x, y: y - 17, width: min(nameSize.width, room), height: 18))
        if let (tagText, tagColor) = tag, nameSize.width + 90 < room {
            context.draw(Text(tagText).font(.system(size: 9.5, weight: .semibold)).foregroundColor(tagColor),
                         at: CGPoint(x: x + nameSize.width + 10, y: y - 8), anchor: .leading)
        }
        context.draw(Text(note).font(.system(size: 12.5)).foregroundColor(noteColor),
                     in: CGRect(x: x, y: y + 1, width: room, height: 16))
    }
}
