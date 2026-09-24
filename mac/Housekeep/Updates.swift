import AppKit
import Combine
import Sparkle

/// Keeps the app up to date with Sparkle: a daily check against the appcast on housekeep.pages.dev,
/// updates signed with the key in Info.plist (SUPublicEDKey), and "Check for Updates…" on demand.
///
/// A menu bar app has no Dock icon to bounce, and Sparkle may put its window behind other apps, so an
/// update that's waiting also shows in the menu until it's seen: Sparkle's "gentle reminders".
@MainActor
final class Updates: NSObject, ObservableObject, SPUStandardUserDriverDelegate {
    @Published private(set) var canCheck = false
    /// The version of an update that's ready and hasn't been looked at yet.
    @Published private(set) var waiting: String?

    private var controller: SPUStandardUpdaterController?
    private var watching: AnyCancellable?

    override init() {
        super.init()
        let controller = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: nil, userDriverDelegate: self)
        watching = controller.updater.publisher(for: \.canCheckForUpdates)
            .receive(on: RunLoop.main)
            .sink { [weak self] can in self?.canCheck = can }
        self.controller = controller
    }

    func check() {
        NSApp.activate(ignoringOtherApps: true)
        controller?.checkForUpdates(nil)
    }

    // MARK: - Gentle reminders (Sparkle calls these on the main thread)

    nonisolated var supportsGentleScheduledUpdateReminders: Bool { true }

    nonisolated func standardUserDriverWillHandleShowingUpdate(_ handleShowingUpdate: Bool, forUpdate update: SUAppcastItem,
                                                               state: SPUUserUpdateState) {
        guard !state.userInitiated else { return }
        let version = update.displayVersionString
        MainActor.assumeIsolated { waiting = version }
    }

    nonisolated func standardUserDriverDidReceiveUserAttention(forUpdate update: SUAppcastItem) {
        MainActor.assumeIsolated { waiting = nil }
    }

    nonisolated func standardUserDriverWillFinishUpdateSession() {
        MainActor.assumeIsolated { waiting = nil }
    }
}
