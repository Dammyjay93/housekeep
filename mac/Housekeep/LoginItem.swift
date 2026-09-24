import Foundation
import ServiceManagement

/// Starting Housekeep at login, through macOS's own login items, so the light is always there.
@MainActor
final class LoginItem: ObservableObject {
    @Published private(set) var status = SMAppService.mainApp.status
    /// Whether the person has answered the "start at login?" card, either way.
    @Published private(set) var answered = UserDefaults.standard.bool(forKey: answeredKey)

    private static let answeredKey = "answeredStartAtLogin"

    var enabled: Bool { status == .enabled }
    /// On, but macOS wants the person to allow it in System Settings first.
    var needsApproval: Bool { status == .requiresApproval }

    func set(_ on: Bool) {
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
        } catch {
            NSLog("Housekeep: couldn't change the login item: %@", error.localizedDescription)
        }
        status = SMAppService.mainApp.status
        answer()
    }

    func answer() {
        answered = true
        UserDefaults.standard.set(true, forKey: Self.answeredKey)
    }

    func refresh() { status = SMAppService.mainApp.status }

    func openSettings() { SMAppService.openSystemSettingsLoginItems() }
}
