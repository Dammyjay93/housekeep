import AppKit
import SwiftUI

/// Where Housekeep's light is, and whether anyone can see it. A full menu bar on a Mac with a camera
/// notch puts the newest items behind the notch, where they can't be seen or clicked.
@MainActor
enum MenuBarPlace {
    /// The status item's window. MenuBarExtra doesn't expose its NSStatusItem, so this finds the small
    /// window macOS makes for it; if that ever changes, the answer is "don't know", never a false alarm.
    private static var itemWindow: NSWindow? {
        NSApp.windows.first { String(describing: type(of: $0)).contains("StatusBarWindow") }
    }

    /// True only when the light is certainly out of sight: under the notch, or off the screen.
    static var hidden: Bool {
        guard let window = itemWindow, let screen = window.screen ?? NSScreen.main else { return false }
        let frame = window.frame
        if !screen.frame.intersects(frame) { return true }
        guard let left = screen.auxiliaryTopLeftArea, let right = screen.auxiliaryTopRightArea else { return false }
        let notch = NSRect(x: left.maxX, y: min(left.minY, right.minY), width: right.minX - left.maxX, height: max(left.height, right.height))
        return notch.width > 0 && frame.intersects(notch)
    }
}

/// Shows and hides the app's windows. A menu bar app has no Dock icon; while one of its windows is open
/// it behaves like any other app, so it can be found with Command-Tab.
@MainActor
enum AppWindows {
    static func show(_ window: NSWindow) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    static func closing(_ window: NSWindow) {
        let others = NSApp.windows.contains { $0 !== window && $0.isVisible && $0.styleMask.contains(.titled) }
        if !others { NSApp.setActivationPolicy(.accessory) }
    }
}

/// The first thing a new install shows, and what opening Housekeep again brings back: where the light
/// is, the way to the map, and starting at login.
@MainActor
final class WelcomeWindow: NSObject, NSWindowDelegate {
    private static let seenKey = "sawWelcome"
    private var window: NSWindow?

    static var seen: Bool { UserDefaults.standard.bool(forKey: seenKey) }

    func show(housekeep: Housekeep, login: LoginItem, openWindow: @escaping (String?) -> Void) {
        UserDefaults.standard.set(true, forKey: Self.seenKey)
        let view = WelcomeView(housekeep: housekeep, login: login, hidden: MenuBarPlace.hidden,
                               openWindow: { [weak self] slug in
                                   self?.window?.close()
                                   openWindow(slug)
                               },
                               done: { [weak self] in self?.window?.close() })
        let window = self.window ?? makeWindow()
        window.contentView = NSHostingView(rootView: view)
        window.setContentSize(window.contentView?.fittingSize ?? NSSize(width: 400, height: 300))
        window.center()
        AppWindows.show(window)
    }

    private func makeWindow() -> NSWindow {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 300),
                              styleMask: [.titled, .closable, .fullSizeContentView], backing: .buffered, defer: false)
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.title = "Welcome to Housekeep"
        window.backgroundColor = NSColor(hex: 0x080808)
        window.appearance = NSAppearance(named: .darkAqua)
        window.isReleasedWhenClosed = false
        window.delegate = self
        self.window = window
        return window
    }

    func windowWillClose(_ notification: Notification) {
        if let window { AppWindows.closing(window) }
    }
}

private struct WelcomeView: View {
    @ObservedObject var housekeep: Housekeep
    @ObservedObject var login: LoginItem
    let hidden: Bool
    let openWindow: (String?) -> Void
    let done: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .center, spacing: 12) {
                Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 48, height: 48)
                Text("Housekeep is in your menu bar").font(.system(size: 17, weight: .semibold)).foregroundStyle(Palette.text)
            }
            Text("Look for \(Image(nsImage: StatusIcon.image(tier: .safe, height: 8))) at the top of your screen. Click it to see which projects need you, and copy a request for your AI assistant.")
            .font(.system(size: 13))
            .foregroundStyle(Palette.text2)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, 12)

            if hidden { hiddenNote.padding(.top, 14) }

            Toggle(isOn: Binding(get: { login.enabled }, set: { login.set($0) })) {
                Text("Start Housekeep when you log in").font(.system(size: 13)).foregroundStyle(Palette.text)
            }
                .toggleStyle(.checkbox)
                .padding(.top, 16)
            if login.needsApproval {
                Button("Allow it in System Settings…") { login.openSettings() }
                    .buttonStyle(.link)
                    .font(.subheadline)
                    .padding(.top, 4)
                    .padding(.leading, 20)
            }

            HStack(spacing: 8) {
                Spacer()
                Button("Done") { done() }.systemButton().accessibilityLabel("Done").keyboardShortcut(.cancelAction)
                Button("Open Housekeep") { openWindow(nil) }
                    .systemButton(prominent: true)
                    .accessibilityLabel("Open map")
                    .keyboardShortcut(.defaultAction)
                    .disabled(housekeep.server == nil)
            }
            .padding(.top, 20)
        }
        .padding(.horizontal, 22)
        .padding(.top, 34)
        .padding(.bottom, 18)
        .frame(width: 400, alignment: .leading)
        .background(Palette.shell)
        .environment(\.colorScheme, .dark)
        .onAppear { login.refresh() }
    }

    private var hiddenNote: some View {
        HStack(alignment: .firstTextBaseline, spacing: 9) {
            TierDot(tier: .attention)
            VStack(alignment: .leading, spacing: 2) {
                Text("Your menu bar is full").font(.system(size: 13, weight: .medium)).foregroundStyle(Palette.text)
                Text("macOS has hidden Housekeep behind the camera at the top of your screen. Quit an app you don't need up there and it appears. Until then, open Housekeep from Applications to come back here.")
                    .font(.system(size: 12))
                    .foregroundStyle(Palette.text2)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
    }
}
