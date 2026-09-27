import Foundation

// MARK: - Widget Slot DTO

/// Minimal DTO for widget use — mirrors the server's `/api/chat/slots` response.
/// Explicit CodingKeys because the server mixes snake_case / camelCase and we don't
/// want to rely on convertFromSnakeCase.
struct WidgetSlotDTO: Decodable {
    let key: String
    let title: String?
    let running: Bool?
    let pendingApproval: Bool?
    let updatedAt: String?

    enum CodingKeys: String, CodingKey {
        case key, title, running
        case pendingApproval = "pending_approval"
        case updatedAt = "updated_at"
    }

    var displayTitle: String { title ?? "New Chat" }
    var isStreaming: Bool { running ?? false }
    var inputNeeded: Bool { pendingApproval ?? false }

    /// Higher priority = shown first in the widget
    var displayPriority: Int {
        if isStreaming { return 2 }
        if inputNeeded { return 1 }
        return 0
    }
}

// MARK: - Widget Server Config

/// Reads the server base URL from the shared App Group UserDefaults.
/// No embedded personal hostname: unconfigured widgets stay offline.
struct WidgetServerConfig {
    static let defaultBaseURL = ""
    static let userDefaultsKey = "serverBaseURL"
    static let appGroupSuite = "group.com.sam.pidash"

    let baseURL: String

    init() {
        let defaults = UserDefaults(suiteName: Self.appGroupSuite) ?? .standard
        baseURL = defaults.string(forKey: Self.userDefaultsKey) ?? Self.defaultBaseURL
    }

    func slotsURL() -> URL? {
        guard !baseURL.isEmpty else { return nil }
        return URL(string: "\(baseURL)/api/chat/slots")
    }

    func statusURL() -> URL? {
        guard !baseURL.isEmpty else { return nil }
        return URL(string: "\(baseURL)/api/status")
    }
}

// MARK: - Insecure Session Delegate

/// Accepts all server trust challenges — required for plain HTTP over Tailscale.
private final class WidgetSessionDelegate: NSObject, URLSessionDelegate {
    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
           let trust = challenge.protectionSpace.serverTrust {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            completionHandler(.performDefaultHandling, nil)
        }
    }
}

// MARK: - Widget Network Client

/// Minimal async fetch used by the WidgetKit TimelineProvider.
struct WidgetNetworkClient {
    private let config: WidgetServerConfig
    private let session: URLSession

    init() {
        self.config = WidgetServerConfig()
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 10
        let delegate = WidgetSessionDelegate()
        self.session = URLSession(configuration: cfg, delegate: delegate, delegateQueue: nil)
    }

    /// Returns the sorted slot list and a connected flag.
    /// Sorted: streaming first, then inputNeeded, then rest (most recent updatedAt first).
    func fetchSlots() async -> (slots: [WidgetSlotDTO], connected: Bool) {
        guard let url = config.slotsURL() else { return ([], false) }
        do {
            let (data, response) = try await session.data(from: url)
            guard let http = response as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode) else {
                return ([], false)
            }
            let decoder = JSONDecoder()
            let dtos = try decoder.decode([WidgetSlotDTO].self, from: data)
            let sorted = dtos.sorted { a, b in
                if a.displayPriority != b.displayPriority {
                    return a.displayPriority > b.displayPriority
                }
                // Fall back to updatedAt string comparison (ISO8601 sorts lexicographically)
                return (a.updatedAt ?? "") > (b.updatedAt ?? "")
            }
            return (sorted, true)
        } catch {
            return ([], false)
        }
    }
}
