import SwiftUI
import WebKit

/// Server domain the remote (пульт) is loaded from; entered once by the user.
enum ServerSettings {
    private static let key = "server-host"

    static var host: String? {
        get { UserDefaults.standard.string(forKey: key) }
        set { UserDefaults.standard.set(newValue, forKey: key) }
    }

    /// Accepts "music.example.com" or a full URL; returns the https origin.
    static func origin(from raw: String) -> URL? {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return nil }
        if !text.contains("://") { text = "https://" + text }
        guard let url = URL(string: text), let host = url.host, !host.isEmpty,
              let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http" else { return nil }
        var comps = URLComponents()
        comps.scheme = scheme
        comps.host = host
        comps.port = url.port
        return comps.url
    }
}

/// The site's own remote page (login happens on the site's login page) with audio routed to the native player.
struct RemoteView: View {
    @EnvironmentObject private var radio: RadioPlayer
    @State private var origin: URL? = ServerSettings.host.flatMap(ServerSettings.origin(from:))
    @State private var input = ""

    var body: some View {
        NavigationStack {
            Group {
                if let origin {
                    RemoteWebView(origin: origin, radio: radio)
                        .ignoresSafeArea(edges: .bottom)
                        .toolbar {
                            ToolbarItem(placement: .topBarTrailing) {
                                Button("server.change") { self.origin = nil }
                            }
                        }
                } else {
                    Form {
                        Section {
                            TextField("server.placeholder", text: $input)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .keyboardType(.URL)
                            Button("server.connect") {
                                guard let url = ServerSettings.origin(from: input) else { return }
                                ServerSettings.host = url.absoluteString
                                origin = url
                            }
                            .disabled(ServerSettings.origin(from: input) == nil)
                        } header: {
                            Text("server.title")
                        } footer: {
                            Text("server.footer")
                        }
                    }
                }
            }
            .navigationTitle(Text("remote.title"))
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}

private struct RemoteWebView: UIViewRepresentable {
    let origin: URL
    let radio: RadioPlayer

    /// Web audio would play a second, buffered copy; play/pause go to the native player instead.
    private static let bridgeJS = """
    (function () {
      const post = (cmd) => { try { window.webkit.messageHandlers.radio.postMessage(cmd) } catch (e) {} };
      HTMLMediaElement.prototype.play = function () {
        post('play');
        try { Object.defineProperty(this, 'paused', { configurable: true, get: () => false }); } catch (e) {}
        this.dispatchEvent(new Event('play')); this.dispatchEvent(new Event('playing'));
        return Promise.resolve();
      };
      HTMLMediaElement.prototype.pause = function () {
        post('stop');
        try { Object.defineProperty(this, 'paused', { configurable: true, get: () => true }); } catch (e) {}
        this.dispatchEvent(new Event('pause'));
      };
    })();
    """

    func makeCoordinator() -> Coordinator { Coordinator(origin: origin, radio: radio) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default() // keeps the site session cookie between launches
        config.allowsInlineMediaPlayback = true
        let controller = WKUserContentController()
        controller.addUserScript(WKUserScript(source: Self.bridgeJS, injectionTime: .atDocumentStart, forMainFrameOnly: false))
        controller.add(context.coordinator, name: "radio")
        config.userContentController = controller
        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.allowsBackForwardNavigationGestures = true
        let refresh = UIRefreshControl()
        refresh.addTarget(context.coordinator, action: #selector(Coordinator.reload(_:)), for: .valueChanged)
        web.scrollView.refreshControl = refresh
        context.coordinator.web = web
        web.load(URLRequest(url: origin.appendingPathComponent("remote")))
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        if context.coordinator.origin != origin {
            context.coordinator.origin = origin
            web.load(URLRequest(url: origin.appendingPathComponent("remote")))
        }
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        var origin: URL
        let radio: RadioPlayer
        weak var web: WKWebView?

        init(origin: URL, radio: RadioPlayer) {
            self.origin = origin
            self.radio = radio
        }

        @objc func reload(_ sender: UIRefreshControl) {
            web?.reload()
            sender.endRefreshing()
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            switch message.body as? String {
            case "play": if !radio.wantsPlaying { radio.play() }
            case "stop": if radio.wantsPlaying { radio.stop() }
            default: break
            }
        }

        private var poll: Timer?

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            syncStreamURL(webView)
            // Login is client-side (no page load), so keep asking until the link arrives.
            poll?.invalidate()
            poll = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self, weak webView] timer in
                Task { @MainActor in
                    guard let self, let webView else { timer.invalidate(); return }
                    self.syncStreamURL(webView)
                }
            }
        }

        /// After login the session cookie lets us read the personal stream link from the API.
        private func syncStreamURL(_ webView: WKWebView) {
            let js = """
            const r = await fetch('/api/app/radio', { credentials: 'same-origin' });
            if (!r.ok) return null;
            const j = await r.json();
            return j && j.station ? j.station.listenUrl : null;
            """
            webView.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { [weak self] result in
                guard let self, case let .success(value) = result, let link = value as? String,
                      let url = StreamLink.parse(link) else { return }
                self.poll?.invalidate()
                if self.radio.streamURL != url {
                    self.radio.saveURL(url.absoluteString)
                }
            }
        }
    }
}
