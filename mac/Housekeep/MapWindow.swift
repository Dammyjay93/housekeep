import AppKit
import WebKit

/// The live map in a window of its own, served by the local Housekeep server. Anything that isn't the
/// map (GitHub, the glossary, a pull request) opens in the default browser instead.
@MainActor
final class MapWindow: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
    private var window: NSWindow?
    private var webView: WKWebView?
    private var serverURL: URL?

    func show(_ url: URL) {
        let window = self.window ?? makeWindow()
        load(url)
        AppWindows.show(window)
    }

    /// The server restarted with a new address or token: reload the map from it, if it's open.
    func serverChanged(to url: URL?) {
        guard let url, let current = serverURL, current != url, window?.isVisible == true else { return }
        load(url)
    }

    private func load(_ url: URL) {
        var base = URLComponents(url: url, resolvingAgainstBaseURL: false)
        base?.fragment = nil
        serverURL = base?.url ?? url
        webView?.load(URLRequest(url: url))
    }

    private func makeWindow() -> NSWindow {
        let config = WKWebViewConfiguration()
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.underPageBackgroundColor = .black

        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                              backing: .buffered, defer: false)
        window.title = "Housekeep"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.backgroundColor = .black
        window.appearance = NSAppearance(named: .darkAqua)
        window.minSize = NSSize(width: 900, height: 600)
        window.contentView = webView
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.center()
        window.setFrameAutosaveName("HousekeepMap")

        self.window = window
        self.webView = webView
        return window
    }

    func windowWillClose(_ notification: Notification) {
        if let window { AppWindows.closing(window) }
    }

    // MARK: - Links

    private func isMap(_ url: URL) -> Bool {
        guard let serverURL else { return false }
        return url.scheme == serverURL.scheme && url.host == serverURL.host && url.port == serverURL.port
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { return decisionHandler(.cancel) }
        if isMap(url) || url.scheme == "about" { return decisionHandler(.allow) }
        NSWorkspace.shared.open(url)
        decisionHandler(.cancel)
    }

    /// Links that ask for a new window (target="_blank") open in the browser.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, !isMap(url) { NSWorkspace.shared.open(url) }
        return nil
    }
}
