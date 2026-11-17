import AuthenticationServices
import CryptoKit
import Security
import Foundation
import UIKit

/// Server address, the app's session, and the remote's data. Audio itself stays in `RadioPlayer`.
@MainActor
final class RemoteStore: NSObject, ObservableObject {
    @Published private(set) var origin: URL?
    @Published private(set) var signedIn = false
    @Published private(set) var radio: RadioInfo?
    @Published private(set) var live: LiveInfo?
    @Published private(set) var folders: FoldersInfo?
    @Published var notice: String?
    @Published private(set) var busy: String?
    @Published private(set) var signingIn = false

    private static let originKey = "server-host"
    private static let tokenAccount = "app-session"
    private var pollTask: Task<Void, Never>?
    private weak var player: RadioPlayer?
    private var authSession: ASWebAuthenticationSession?
    private var verifier: String?

    init(player: RadioPlayer) {
        self.player = player
        super.init()
        origin = UserDefaults.standard.string(forKey: Self.originKey).flatMap(URL.init(string:))
        signedIn = origin != nil && Keychain.load(account: Self.tokenAccount) != nil
    }

    private var api: Api? {
        guard let origin, let token = Keychain.load(account: Self.tokenAccount) else { return nil }
        return Api(origin: origin, token: token)
    }

    // MARK: - Server and sign-in

    /// Accepts "music.example.com" or a full URL; returns the origin.
    static func parseOrigin(_ raw: String) -> URL? {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return nil }
        if !text.contains("://") { text = "https://" + text }
        guard let url = URL(string: text), let host = url.host, host.contains("."),
              let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http" else { return nil }
        var c = URLComponents()
        c.scheme = scheme
        c.host = host
        c.port = url.port
        return c.url
    }

    /// Opens the site in the system browser sheet: password and passkey sign-in both work there.
    func signIn(server raw: String) {
        guard let url = Self.parseOrigin(raw) else { notice = "Невірна адреса сервера"; return }
        origin = url
        UserDefaults.standard.set(url.absoluteString, forKey: Self.originKey)
        // PKCE: only this app, holding the verifier, can trade the code the site returns
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { return }
        let v = Self.base64url(Data(bytes))
        verifier = v
        let cc = Self.base64url(Data(SHA256.hash(data: Data(v.utf8))))
        var comps = URLComponents(url: url.appendingPathComponent("login"), resolvingAgainstBaseURL: false)!
        comps.queryItems = [URLQueryItem(name: "app", value: "1"), URLQueryItem(name: "cc", value: cc)]
        let start = comps.url!
        let session = ASWebAuthenticationSession(url: start, callbackURLScheme: "agentradio") { [weak self] callback, error in
            Task { @MainActor in self?.finishSignIn(callback, error) }
        }
        session.presentationContextProvider = self
        session.prefersEphemeralWebBrowserSession = false
        authSession = session
        signingIn = true
        if !session.start() { signingIn = false; notice = "Не вдалося відкрити вхід" }
    }

    private func finishSignIn(_ callback: URL?, _ error: Error?) {
        authSession = nil
        if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin { signingIn = false; return }
        guard let callback, let origin, let verifier,
              let code = URLComponents(url: callback, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "code" })?.value, !code.isEmpty else {
            signingIn = false
            notice = "Вхід не вдався"
            return
        }
        self.verifier = nil
        Task {
            defer { signingIn = false }
            do {
                let token = try await Api.exchange(origin: origin, code: code, verifier: verifier)
                Keychain.save(token, account: Self.tokenAccount)
                signedIn = true
                player?.log.add("signed in, host=\(origin.host ?? "?")")
                start()
            } catch {
                notice = "Вхід не вдався"
            }
        }
    }

    static func base64url(_ d: Data) -> String {
        d.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    func signOut() {
        stop()
        Keychain.delete(account: Self.tokenAccount)
        signedIn = false
        radio = nil
        live = nil
        folders = nil
        player?.log.add("signed out")
    }

    // MARK: - Data

    func start() {
        guard pollTask == nil, signedIn else { return }
        pollTask = Task { [weak self] in
            var tick = 0
            while !Task.isCancelled {
                guard let self else { return }
                if tick % 6 == 0 { await self.refresh() } else { await self.refreshLive() }
                tick += 1
                try? await Task.sleep(nanoseconds: 5_000_000_000)
            }
        }
    }

    func stop() {
        pollTask?.cancel()
        pollTask = nil
    }

    func refresh() async {
        guard let api else { return }
        do {
            let r = try await api.radio()
            radio = r
            if let url = StreamLink.parse(r.station.listenUrl), player?.streamURL != url {
                player?.saveURL(url.absoluteString)
            }
            if folders == nil { folders = try? await api.folders() }
            await refreshLive()
        } catch { handle(error) }
    }

    private func refreshLive() async {
        guard let api else { return }
        do { live = try await api.live() } catch { handle(error) }
    }

    private func handle(_ error: Error) {
        if case ApiError.unauthorized = error {
            signOut()
            notice = "Сесія закінчилась, увійдіть знову"
        }
    }

    // MARK: - Actions

    func setSource(_ s: Source, key: String) {
        guard let api, busy == nil else { return }
        busy = key
        Task {
            do { try await api.setSource(s) } catch { handle(error); notice = "Не вдалося перемкнути" }
            await refresh()
            busy = nil
        }
    }

    func setLevels(music: Double? = nil, voice: Double? = nil) {
        guard let api else { return }
        Task {
            do { try await api.setLevels(music: music, voice: voice) } catch { handle(error); notice = "Не вдалося зберегти" }
        }
    }

    func replay(count: Int? = nil, id: String? = nil) {
        guard let api, busy == nil else { return }
        busy = id ?? "n\(count ?? 1)"
        Task {
            do {
                let r = id != nil ? try await api.replay(id: id!) : try await api.replay(count: count ?? 1)
                switch r.status {
                case "skipped": notice = "Ніхто не слухає — повтор не потрібен"
                case "waiting": notice = "Повтор у черзі"
                default: notice = "Повтор в ефірі"
                }
            } catch { handle(error); notice = "Не вдалося повторити" }
            busy = nil
        }
    }
}

extension RemoteStore: ASWebAuthenticationPresentationContextProviding {
    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            UIApplication.shared.connectedScenes
                .compactMap { ($0 as? UIWindowScene)?.keyWindow }
                .first ?? ASPresentationAnchor()
        }
    }
}
