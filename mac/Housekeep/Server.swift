import AppKit
import Foundation

/// Where a running Housekeep server listens, as it writes it to server.json.
struct ServerInfo: Sendable, Equatable {
    let url: URL
    let token: String
    let pid: Int32?
}

/// Runs the same live server `housekeep serve` does, with the Node and Housekeep this app carries,
/// and follows its state. If a server is already running (say, from the terminal), it uses that one.
@MainActor
final class Housekeep: ObservableObject {
    enum Phase: Equatable {
        case starting
        case running
        case failed(String)
    }

    @Published private(set) var phase: Phase = .starting
    @Published private(set) var snapshot: Snapshot?
    @Published private(set) var checking = false
    @Published private(set) var server: ServerInfo?

    private var child: Process?
    /// Held open for the child's whole life: when this app goes, the pipe closes and the child stops.
    private var childInput: Pipe?
    private var stopping = false
    private var restarts = 0
    private var stream: Task<Void, Never>?

    nonisolated private static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        // The server sends a heartbeat every 15 seconds, so a minute of silence means it's gone.
        config.timeoutIntervalForRequest = 60
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: config)
    }()

    nonisolated static let stateDirectory: URL = {
        let env = ProcessInfo.processInfo.environment
        if let dir = env["HOUSEKEEP_STATE_DIR"] { return URL(fileURLWithPath: dir) }
        let base = env["XDG_STATE_HOME"].map { URL(fileURLWithPath: $0) }
            ?? FileManager.default.homeDirectoryForCurrentUser.appending(path: ".local/state")
        return base.appending(path: "housekeep")
    }()

    nonisolated static let logFile = FileManager.default.homeDirectoryForCurrentUser.appending(path: "Library/Logs/Housekeep/server.log")

    func start() {
        stopping = false
        Task { await connectOrLaunch() }
    }

    /// Stops the server this app started. One started elsewhere keeps running.
    func stop() {
        stopping = true
        stream?.cancel()
        child?.terminate()
    }

    func mapURL(slug: String? = nil) -> URL? {
        guard let server else { return nil }
        guard let slug else { return server.url }
        var parts = URLComponents(url: server.url, resolvingAgainstBaseURL: false)
        parts?.fragment = slug
        return parts?.url ?? server.url
    }

    /// Re-checks every repo, fetching from their remotes first, and waits for the result.
    func checkNow() async {
        guard let server, !checking else { return }
        checking = true
        defer { checking = false }
        var components = URLComponents(url: server.url.appending(path: "api/check"), resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "wait", value: "1")]
        guard let url = components?.url else { return }
        var request = URLRequest(url: url, timeoutInterval: 95)
        request.httpMethod = "POST"
        request.httpBody = Data("{}".utf8)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(server.token, forHTTPHeaderField: "X-Housekeep-Token")
        do {
            let (data, response) = try await Self.session.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { return }
            apply(try JSONDecoder().decode(Snapshot.self, from: data))
        } catch {
            // The live stream still delivers the result when the check finishes; nothing is lost.
            NSLog("Housekeep: check now failed: %@", error.localizedDescription)
        }
    }

    // MARK: - Starting

    private func connectOrLaunch() async {
        phase = .starting
        if let running = await Self.runningServer() {
            listen(to: running)
            return
        }
        let pid: Int32
        do {
            pid = try launch()
        } catch {
            phase = .failed("Housekeep couldn't start: \(error.localizedDescription)")
            return
        }
        // The first check can take a while with many repos; server.json appears once it's listening.
        let deadline = Date.now.addingTimeInterval(180)
        while Date.now < deadline, !stopping {
            guard child?.processIdentifier == pid, child?.isRunning == true else { return }
            if let info = Self.readServerFile(), info.pid == pid, await Self.answers(info) {
                listen(to: info)
                return
            }
            try? await Task.sleep(for: .milliseconds(300))
        }
        if !stopping { phase = .failed("Housekeep took too long to start. The log is in ~/Library/Logs/Housekeep.") }
    }

    private func launch() throws -> Int32 {
        let contents = Bundle.main.bundleURL.appending(path: "Contents")
        let node = contents.appending(path: "Helpers/node")
        let cli = contents.appending(path: "Resources/housekeep/dist/src/cli.js")
        guard FileManager.default.isExecutableFile(atPath: node.path), FileManager.default.fileExists(atPath: cli.path) else {
            throw LaunchError.missingRuntime
        }

        let process = Process()
        process.executableURL = node
        process.arguments = [cli.path, "serve"]
        var env = ProcessInfo.processInfo.environment
        env["HOUSEKEEP_APP"] = "1"
        process.environment = env
        let input = Pipe()
        process.standardInput = input
        let log = try Self.openLog()
        process.standardOutput = log
        process.standardError = log
        process.terminationHandler = { [weak self] ended in
            let pid = ended.processIdentifier
            Task { @MainActor in self?.childExited(pid: pid) }
        }
        try process.run()
        child = process
        childInput = input
        return process.processIdentifier
    }

    private func childExited(pid: Int32) {
        guard child?.processIdentifier == pid else { return }
        child = nil
        childInput = nil
        if stopping { return }
        // Like launchd's KeepAlive, but not forever: three tries, then say what went wrong.
        guard restarts < 3 else {
            phase = .failed("Housekeep stopped unexpectedly. The log is in ~/Library/Logs/Housekeep.")
            return
        }
        restarts += 1
        stream?.cancel()
        server = nil
        Task {
            try? await Task.sleep(for: .seconds(2))
            await connectOrLaunch()
        }
    }

    private static func openLog() throws -> FileHandle {
        let fm = FileManager.default
        try fm.createDirectory(at: logFile.deletingLastPathComponent(), withIntermediateDirectories: true)
        fm.createFile(atPath: logFile.path, contents: nil)
        return try FileHandle(forWritingTo: logFile)
    }

    enum LaunchError: LocalizedError {
        case missingRuntime
        var errorDescription: String? { "parts of the app are missing. Download Housekeep again." }
    }

    // MARK: - Finding a server

    nonisolated private static func readServerFile() -> ServerInfo? {
        guard let data = try? Data(contentsOf: stateDirectory.appending(path: "server.json")),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let url = (json["url"] as? String).flatMap(URL.init(string:)),
              let token = json["token"] as? String else { return nil }
        return ServerInfo(url: url, token: token, pid: (json["pid"] as? NSNumber)?.int32Value)
    }

    /// Whether the server answers, and runs the same version as this app. One left running from an older
    /// version would pair this app's view with its old data, so the app starts its own instead.
    nonisolated private static func answers(_ info: ServerInfo) async -> Bool {
        var request = URLRequest(url: info.url.appending(path: "api/state"), timeoutInterval: 1.5)
        request.setValue(info.token, forHTTPHeaderField: "X-Housekeep-Token")
        guard let (data, response) = try? await session.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
        let mine = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        return json["version"] as? String == mine
    }

    nonisolated private static func runningServer() async -> ServerInfo? {
        guard let info = readServerFile(), await answers(info) else { return nil }
        return info
    }

    // MARK: - Following it

    private func listen(to info: ServerInfo) {
        server = info
        stream?.cancel()
        stream = Task { [weak self] in
            for await snapshot in Self.states(from: info) { self?.apply(snapshot) }
            guard !Task.isCancelled else { return }
            await self?.lostServer()
        }
    }

    /// The server's event stream, one `state` event per change, each a whole snapshot. Read and decoded
    /// off the main thread; it ends when the server goes away.
    nonisolated private static func states(from info: ServerInfo) -> AsyncStream<Snapshot> {
        AsyncStream { continuation in
            let reader = Task.detached {
                var request = URLRequest(url: info.url.appending(path: "api/events"))
                request.setValue(info.token, forHTTPHeaderField: "X-Housekeep-Token")
                do {
                    let (bytes, response) = try await session.bytes(for: request)
                    if (response as? HTTPURLResponse)?.statusCode == 200 {
                        var event = ""
                        for try await line in bytes.lines {
                            if line.hasPrefix("event:") {
                                event = line.dropFirst(6).trimmingCharacters(in: .whitespaces)
                            } else if line.hasPrefix("data:"), event == "state",
                                      let snapshot = try? JSONDecoder().decode(Snapshot.self, from: Data(line.dropFirst(5).utf8)) {
                                continuation.yield(snapshot)
                            }
                        }
                    }
                } catch {
                    if !(error is CancellationError) { NSLog("Housekeep: lost the live stream: %@", error.localizedDescription) }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in reader.cancel() }
        }
    }

    private func apply(_ snapshot: Snapshot) {
        self.snapshot = snapshot
        phase = .running
        restarts = 0
    }

    private func lostServer() async {
        server = nil
        guard !stopping else { return }
        // Our own server restarts through childExited; one started elsewhere may have stopped, so look again.
        if child?.isRunning == true {
            for _ in 0..<30 where !stopping {
                try? await Task.sleep(for: .seconds(1))
                if let info = Self.readServerFile(), await Self.answers(info) {
                    listen(to: info)
                    return
                }
            }
            if !stopping { phase = .failed("Housekeep stopped answering. Quit it and open it again.") }
            return
        }
        try? await Task.sleep(for: .seconds(1))
        await connectOrLaunch()
    }
}
