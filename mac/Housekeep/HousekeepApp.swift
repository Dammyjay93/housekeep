import AppKit
import SwiftUI

@main
struct HousekeepApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var app

    var body: some Scene {
        MenuBarExtra {
            MenuView(housekeep: app.housekeep, login: app.login, updates: app.updates) { app.dashboard.show(housekeep: app.housekeep, slug: $0) }
        } label: {
            MenuBarLabel(housekeep: app.housekeep)
        }
        .menuBarExtraStyle(.window)
    }
}

/// The light, and how many projects need you when any do.
private struct MenuBarLabel: View {
    @ObservedObject var housekeep: Housekeep

    var body: some View {
        let snapshot = housekeep.phase == .running ? housekeep.snapshot : nil
        let needy = snapshot?.needy.count ?? 0
        Image(nsImage: StatusIcon.image(tier: snapshot?.error == nil ? snapshot?.worst : nil))
        if needy > 0 { Text("\(needy)") }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let housekeep = Housekeep()
    let login = LoginItem()
    let updates = Updates()
    let dashboard = DashboardWindow()
    let welcome = WelcomeWindow()

    func applicationDidFinishLaunching(_ notification: Notification) {
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
        welcome.show(housekeep: housekeep, login: login) { [dashboard, housekeep] slug in dashboard.show(housekeep: housekeep, slug: slug) }
    }

    func applicationWillTerminate(_ notification: Notification) {
        housekeep.stop()
    }
}
