import Foundation
import Security

/// Parsing and display helpers for the personal stream URL.
enum StreamLink {
    /// Accepts any http(s) URL with a host; returns nil otherwise.
    static func parse(_ raw: String) -> URL? {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: text),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              let host = url.host, !host.isEmpty else { return nil }
        return url
    }

    /// Host plus the `k` token with all but the first two characters hidden.
    static func masked(_ url: URL) -> (host: String, token: String?) {
        let host = url.host ?? ""
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
        guard let token = items?.first(where: { $0.name == "k" })?.value, !token.isEmpty else {
            return (host, nil)
        }
        return (host, String(token.prefix(2)) + String(repeating: "•", count: 8))
    }

    /// Same URL with a cache-busting `_` query item so no proxy or cache serves old data.
    static func fresh(_ url: URL, now: Date = Date()) -> URL {
        guard var comps = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url }
        var items = (comps.queryItems ?? []).filter { $0.name != "_" }
        items.append(URLQueryItem(name: "_", value: String(Int(now.timeIntervalSince1970 * 1000))))
        comps.queryItems = items
        return comps.url ?? url
    }
}

/// Minimal Keychain wrapper; the stream URL contains the listen token.
enum Keychain {
    private static let service = "agent-radio"

    private static func baseQuery(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    static func save(_ value: String, account: String) {
        let data = Data(value.utf8)
        SecItemDelete(baseQuery(account) as CFDictionary)
        var query = baseQuery(account)
        query[kSecValueData as String] = data
        // Readable after the first unlock so playback can restart with the screen locked.
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(query as CFDictionary, nil)
    }

    static func load(account: String) -> String? {
        var query = baseQuery(account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func delete(account: String) {
        SecItemDelete(baseQuery(account) as CFDictionary)
    }
}
