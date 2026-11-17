import Foundation

// MARK: - Models (subset of src/client/api/types.ts)

enum Source: Codable, Equatable {
    case relay(url: String, name: String?)
    case playlist(dir: String, order: String?)
    case userPlaylist(id: String)
    case silence

    private enum K: String, CodingKey { case type, url, name, dir, order, playlistId }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        switch try c.decode(String.self, forKey: .type) {
        case "relay": self = .relay(url: try c.decode(String.self, forKey: .url), name: try c.decodeIfPresent(String.self, forKey: .name))
        case "playlist": self = .playlist(dir: try c.decode(String.self, forKey: .dir), order: try c.decodeIfPresent(String.self, forKey: .order))
        case "userplaylist": self = .userPlaylist(id: try c.decode(String.self, forKey: .playlistId))
        default: self = .silence
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: K.self)
        switch self {
        case let .relay(url, name):
            try c.encode("relay", forKey: .type); try c.encode(url, forKey: .url); try c.encodeIfPresent(name, forKey: .name)
        case let .playlist(dir, order):
            try c.encode("playlist", forKey: .type); try c.encode(dir, forKey: .dir); try c.encodeIfPresent(order, forKey: .order)
        case let .userPlaylist(id):
            try c.encode("userplaylist", forKey: .type); try c.encode(id, forKey: .playlistId)
        case .silence:
            try c.encode("silence", forKey: .type)
        }
    }
}

struct RadioInfo: Decodable {
    struct Station: Decodable {
        let id: String
        let source: Source
        let musicGainDb: Double
        let voiceGainDb: Double
        let listenUrl: String
    }
    struct Preset: Decodable, Identifiable { let id, name, description, url: String }
    struct Playlist: Decodable, Identifiable { let id, name: String; let count: Int }
    struct Message: Decodable, Identifiable {
        let id, session, text, createdAt: String
        let host: String?
    }
    let station: Station
    let presets: [Preset]
    let playlists: [Playlist]
    let messages: [Message]
}

struct LiveInfo: Decodable {
    let up: Bool
    let listeners: Int
    let title: String?
}

struct Folder: Decodable, Identifiable {
    let path, name: String
    let depth, count: Int
    var id: String { path }
}

struct FoldersInfo: Decodable { let folders: [Folder]; let total: Int }

struct ReplayResult: Decodable { let status: String; let ids: [String] }

enum ApiError: Error { case unauthorized, http(Int), bad }

// MARK: - Client

/// Talks to /api/app/* with the session token the site handed to the app (see /api/auth/app-handoff).
struct Api {
    let origin: URL
    let token: String

    private static let session: URLSession = {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.httpShouldSetCookies = false
        cfg.httpCookieAcceptPolicy = .never
        cfg.timeoutIntervalForRequest = 15
        return URLSession(configuration: cfg)
    }()

    private func request(_ method: String, _ path: String, body: Encodable? = nil) async throws -> Data {
        var req = URLRequest(url: origin.appendingPathComponent("api").appendingPathComponent(path))
        req.httpMethod = method
        let cookie = origin.scheme == "https" ? "__Host-ar_session" : "ar_session"
        req.setValue("\(cookie)=\(token)", forHTTPHeaderField: "Cookie")
        // the server's CSRF check accepts its own origin
        req.setValue(origin.absoluteString, forHTTPHeaderField: "Origin")
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONEncoder().encode(body)
        }
        let (data, resp) = try await Self.session.data(for: req)
        guard let http = resp as? HTTPURLResponse else { throw ApiError.bad }
        if http.statusCode == 401 { throw ApiError.unauthorized }
        guard (200..<300).contains(http.statusCode) else { throw ApiError.http(http.statusCode) }
        return data
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        try JSONDecoder().decode(T.self, from: try await request("GET", path))
    }

    func radio() async throws -> RadioInfo { try await get("app/radio") }
    func live() async throws -> LiveInfo { try await get("app/live") }
    func folders() async throws -> FoldersInfo { try await get("app/library/folders") }

    func setSource(_ s: Source) async throws { _ = try await request("PUT", "app/station/source", body: s) }

    func setLevels(music: Double? = nil, voice: Double? = nil) async throws {
        struct B: Encodable { let musicGainDb: Double?; let voiceGainDb: Double? }
        _ = try await request("PATCH", "app/settings", body: B(musicGainDb: music, voiceGainDb: voice))
    }

    func replay(count: Int) async throws -> ReplayResult {
        struct B: Encodable { let count: Int }
        return try JSONDecoder().decode(ReplayResult.self, from: try await request("POST", "app/history/replay", body: B(count: count)))
    }

    func replay(id: String) async throws -> ReplayResult {
        struct B: Encodable { let id: String }
        return try JSONDecoder().decode(ReplayResult.self, from: try await request("POST", "app/history/replay", body: B(id: id)))
    }
}
