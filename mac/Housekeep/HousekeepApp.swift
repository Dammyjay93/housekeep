import AppKit
import SwiftUI

@main
struct HousekeepApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var app

    var body: some Scene {
        MenuBarExtra {
            MenuView(housekeep: app.housekeep, login: app.login, updates: app.updates) { app.showDashboard(slug: $0) }
        } label: {
            MenuBarLabel(housekeep: app.housekeep, app: app)
        }
        .menuBarExtraStyle(.window)

        dashboard
    }

    /// The window, opened when you ask for it: from the menu, or by opening the app again.
    @SceneBuilder private var dashboard: some Scene {
        let window = Window("Housekeep", id: AppDelegate.dashboardID) {
            DashboardView(housekeep: app.housekeep).environmentObject(app.navigator).environmentObject(app.sent)
        }
        .defaultSize(width: 1240, height: 820)
        .windowToolbarStyle(.unified)
        window
    }
}

/// The light, and how many projects need you when any do.
private struct MenuBarLabel: View {
    @ObservedObject var housekeep: Housekeep
    let app: AppDelegate
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        let snapshot = housekeep.phase == .running ? housekeep.snapshot : nil
        let needy = snapshot?.needy.count ?? 0
        Image(nsImage: StatusIcon.image(tier: snapshot?.error == nil ? snapshot?.worst : nil))
            // Always on screen, so it's where the app gets SwiftUI's way to open its window.
            .onAppear { app.openWindow = openWindow }
        if needy > 0 { Text("\(needy)") }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let housekeep = Housekeep()
    let login = LoginItem()
    let updates = Updates()
    let navigator = Navigator()
    let sent = SentRequests()
    var openWindow: OpenWindowAction?
    static let dashboardID = "dashboard"
    let welcome = WelcomeWindow()

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Back to a menu bar app, with no Dock icon, once the window closes.
        NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: nil, queue: .main) { note in
            guard let window = note.object as? NSWindow, window.identifier?.rawValue.hasPrefix(AppDelegate.dashboardID) == true else { return }
            MainActor.assumeIsolated { AppWindows.closing(window) }
        }
        housekeep.start()
        // Give macOS a moment to place the light, then say where it is: always the first time, and
        // after that only when it's hidden behind the notch.
        Task {
            try? await Task.sleep(for: .seconds(1.5))
            if !WelcomeWindow.seen || MenuBarPlace.hidden { showWelcome() }
        }
    }

    /// Opening Housekeep again (from Applications, Spotlight or the Dock) while it runs: the light may be
    /// out of sight, so show the way in.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { showWelcome() }
        return true
    }

    private func showWelcome() {
        welcome.show(housekeep: housekeep, login: login) { [weak self] slug in self?.showDashboard(slug: slug) }
    }

    /// Opens the window at one project, or the overview.
    func showDashboard(slug: String?) {
        navigator.place = slug.map { .project($0) } ?? .overview
        navigator.requested = true
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        openWindow?(id: Self.dashboardID)
    }

    func applicationWillTerminate(_ notification: Notification) {
        housekeep.stop()
    }
}
