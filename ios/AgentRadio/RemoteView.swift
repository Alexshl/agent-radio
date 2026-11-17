import SwiftUI

/// Native remote: player, levels, replay and sources on one screen.
struct RemoteView: View {
    @EnvironmentObject private var radio: RadioPlayer
    @EnvironmentObject private var store: RemoteStore
    @Environment(\.scenePhase) private var phase
    @State private var showLog = false

    var body: some View {
        NavigationStack {
            Group {
                if store.signedIn { remote } else { SignInView() }
            }
            .navigationTitle(Text(verbatim: "Пульт"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { if store.signedIn { StatusPill() } }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button { showLog = true } label: { Label("Журнал", systemImage: "list.bullet.rectangle") }
                        if store.signedIn {
                            Button(role: .destructive) { store.signOut() } label: {
                                Label("Вийти", systemImage: "rectangle.portrait.and.arrow.right")
                            }
                        }
                    } label: { Image(systemName: "ellipsis.circle") }
                }
            }
            .sheet(isPresented: $showLog) { NavigationStack { LogView(log: radio.log) } }
        }
        .onAppear { store.start() }
        .onChange(of: phase) { _, p in
            if p == .active { store.start(); Task { await store.refresh() } } else if p == .background { store.stop() }
        }
        .alert(Text(verbatim: store.notice ?? ""), isPresented: Binding(get: { store.notice != nil }, set: { if !$0 { store.notice = nil } })) {
            Button("OK", role: .cancel) {}
        }
    }

    private var remote: some View {
        List {
            NowSection()
            LevelsSection()
            ReplaySection()
            SourcesSection()
        }
        .listStyle(.insetGrouped)
        .refreshable { await store.refresh() }
        .overlay { if store.radio == nil { ProgressView() } }
    }
}

// MARK: - Sign in

private struct SignInView: View {
    @EnvironmentObject private var store: RemoteStore
    @State private var server = UserDefaults.standard.string(forKey: "server-host")
        .flatMap(URL.init(string:))?.host ?? "radio.example.com"

    var body: some View {
        Form {
            Section {
                TextField(text: $server) { Text(verbatim: "radio.example.com") }
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .textContentType(.URL)
            } header: {
                Text(verbatim: "Сервер")
            } footer: {
                Text(verbatim: "Вхід відкриється на сторінці сайту: можна паролем або passkey.")
            }
            Section {
                Button {
                    store.signIn(server: server)
                } label: {
                    HStack {
                        Spacer()
                        if store.signingIn { ProgressView() } else { Text(verbatim: "Увійти").bold() }
                        Spacer()
                    }
                }
                .disabled(RemoteStore.parseOrigin(server) == nil || store.signingIn)
            }
        }
    }
}

// MARK: - Now playing

private struct StatusPill: View {
    @EnvironmentObject private var store: RemoteStore

    var body: some View {
        let up = store.live?.up == true
        let n = store.live?.listeners ?? 0
        HStack(spacing: 6) {
            Circle().fill(up && n > 0 ? Color.green : Color.secondary).frame(width: 8, height: 8)
            Text(verbatim: !up ? "Офлайн" : n == 0 ? "Нікого" : "В ефірі · \(n)")
                .font(.footnote.weight(.medium))
                .monospacedDigit()
        }
        .fixedSize()
    }
}

private struct NowSection: View {
    @EnvironmentObject private var radio: RadioPlayer
    @EnvironmentObject private var store: RemoteStore

    var body: some View {
        Section {
            HStack(spacing: 16) {
                Button { radio.toggle() } label: {
                    ZStack {
                        Circle().fill(Color.accentColor)
                        if radio.wantsPlaying && !radio.isPlaying {
                            ProgressView().tint(.white)
                        } else {
                            Image(systemName: radio.wantsPlaying ? "pause.fill" : "play.fill")
                                .font(.system(size: 26, weight: .semibold))
                                .foregroundStyle(.white)
                                .offset(x: radio.wantsPlaying ? 0 : 2)
                        }
                    }
                    .frame(width: 64, height: 64)
                }
                .buttonStyle(.plain)
                .disabled(radio.streamURL == nil)
                .accessibilityLabel(Text(verbatim: radio.wantsPlaying ? "Стоп" : "Грати"))

                VStack(alignment: .leading, spacing: 4) {
                    Text(verbatim: sourceName)
                        .font(.footnote).foregroundStyle(.secondary).lineLimit(1)
                    Text(verbatim: store.live?.title ?? radio.trackTitle ?? "—")
                        .font(.headline).lineLimit(2)
                    Text(verbatim: radio.isPlaying ? "● Наживо" : radio.wantsPlaying ? "Підключення…" : "Не слухаєте")
                        .font(.caption)
                        .foregroundStyle(radio.isPlaying ? Color.red : Color.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.vertical, 6)
        }
    }

    private var sourceName: String {
        guard let r = store.radio else { return " " }
        switch r.station.source {
        case .silence: return "Тиша"
        case let .relay(url, name): return name ?? URL(string: url)?.host ?? url
        case let .playlist(dir, _): return dir.isEmpty ? "Уся бібліотека" : (dir as NSString).lastPathComponent
        case let .userPlaylist(id): return r.playlists.first { $0.id == id }?.name ?? "Плейлист"
        }
    }
}

// MARK: - Levels

private struct LevelsSection: View {
    @EnvironmentObject private var store: RemoteStore
    @State private var music: Double = 0
    @State private var voice: Double = 0
    @State private var loadedFor: String?

    var body: some View {
        Section {
            level("Музика", value: $music, range: -30...6) { store.setLevels(music: music) }
            level("Голос", value: $voice, range: -12...12) { store.setLevels(voice: voice) }
        } header: {
            Text(verbatim: "Рівні")
        }
        .onReceive(store.$radio) { r in
            guard let r, loadedFor != r.station.id else { return }
            loadedFor = r.station.id
            music = r.station.musicGainDb
            voice = r.station.voiceGainDb
        }
    }

    private func level(_ title: String, value: Binding<Double>, range: ClosedRange<Double>, save: @escaping () -> Void) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(verbatim: title)
                Spacer()
                Text(verbatim: String(format: "%+.0f дБ", value.wrappedValue))
                    .monospacedDigit().foregroundStyle(.secondary)
            }
            Slider(value: value, in: range, step: 1) { editing in if !editing { save() } }
        }
    }
}

// MARK: - Replay

private struct ReplaySection: View {
    @EnvironmentObject private var store: RemoteStore

    var body: some View {
        let messages = store.radio?.messages ?? []
        Section {
            HStack(spacing: 10) {
                ForEach([1, 2, 3], id: \.self) { n in
                    Button { store.replay(count: n) } label: {
                        VStack(spacing: 4) {
                            if store.busy == "n\(n)" { ProgressView() } else { Image(systemName: "arrow.counterclockwise") }
                            Text(verbatim: n == 1 ? "Останнє" : "Останні \(n)").font(.caption)
                        }
                        .frame(maxWidth: .infinity, minHeight: 52)
                    }
                    .buttonStyle(.bordered)
                    .disabled(store.busy != nil || messages.isEmpty)
                }
            }
            .listRowInsets(EdgeInsets(top: 10, leading: 12, bottom: 10, trailing: 12))

            if messages.isEmpty {
                Text(verbatim: "Повідомлень ще немає").foregroundStyle(.secondary)
            }
            ForEach(messages) { m in
                HStack(alignment: .top, spacing: 12) {
                    VStack(alignment: .leading, spacing: 3) {
                        HStack {
                            Text(verbatim: m.host.map { "\(m.session) · \($0)" } ?? m.session)
                                .font(.caption.weight(.semibold)).lineLimit(1)
                            Spacer()
                            Text(verbatim: Self.time(m.createdAt)).font(.caption).monospacedDigit().foregroundStyle(.secondary)
                        }
                        Text(verbatim: m.text).font(.subheadline).lineLimit(3)
                    }
                    Button { store.replay(id: m.id) } label: {
                        if store.busy == m.id { ProgressView() } else { Image(systemName: "play.circle.fill").font(.title2) }
                    }
                    .buttonStyle(.borderless)
                    .disabled(store.busy != nil)
                    .frame(width: 32)
                }
                .padding(.vertical, 2)
            }
        } header: {
            Text(verbatim: "Повтор")
        }
    }

    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    static func time(_ s: String) -> String {
        guard let d = iso.date(from: s) ?? ISO8601DateFormatter().date(from: s) else { return "" }
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f.string(from: d)
    }
}

// MARK: - Sources

private enum SourceTab: String, CaseIterable, Identifiable {
    case silence = "Тиша", playlists = "Плейлисти", folders = "Папки", stations = "Станції"
    var id: String { rawValue }
}

private struct SourcesSection: View {
    @EnvironmentObject private var store: RemoteStore
    @State private var tab: SourceTab = .stations
    @State private var tabSet = false

    private struct Row: Identifiable {
        let id, name, meta, icon: String
        let active: Bool
        let source: Source
    }

    var body: some View {
        Section {
            Picker(selection: $tab) {
                ForEach(SourceTab.allCases) { Text(verbatim: $0.rawValue).tag($0) }
            } label: { EmptyView() }
            .pickerStyle(.segmented)
            .listRowInsets(EdgeInsets(top: 10, leading: 12, bottom: 10, trailing: 12))

            let items = rows
            if items.isEmpty {
                Text(verbatim: "Тут поки порожньо").foregroundStyle(.secondary)
            }
            ForEach(items) { it in
                Button { if !it.active { store.setSource(it.source, key: it.id) } } label: {
                    HStack(spacing: 12) {
                        Group {
                            if store.busy == it.id { ProgressView() } else { Image(systemName: it.icon) }
                        }
                        .frame(width: 24)
                        .foregroundStyle(it.active ? Color.accentColor : Color.secondary)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(verbatim: it.name).foregroundStyle(.primary).lineLimit(1)
                            if !it.meta.isEmpty {
                                Text(verbatim: it.meta).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            }
                        }
                        Spacer()
                        if it.active { Image(systemName: "checkmark").foregroundStyle(Color.accentColor).fontWeight(.semibold) }
                    }
                }
                .disabled(store.busy != nil && store.busy != it.id)
            }
        } header: {
            Text(verbatim: "Під голосом")
        }
        .onReceive(store.$radio) { r in
            guard let r, !tabSet else { return }
            tabSet = true
            switch r.station.source {
            case .silence: tab = .silence
            case .userPlaylist: tab = .playlists
            case .playlist: tab = .folders
            case .relay: tab = .stations
            }
        }
    }

    private static func tracks(_ n: Int) -> String {
        let m10 = n % 10, m100 = n % 100
        let w = m10 == 1 && m100 != 11 ? "трек" : (2...4).contains(m10) && !(12...14).contains(m100) ? "треки" : "треків"
        return "\(n) \(w)"
    }

    private var rows: [Row] {
        guard let r = store.radio else { return [] }
        let src = r.station.source
        switch tab {
        case .silence:
            return [Row(id: "silence", name: "Тиша", meta: "Лише голос", icon: "speaker.slash", active: src == .silence, source: .silence)]
        case .playlists:
            return r.playlists.map { p in
                Row(id: p.id, name: p.name, meta: Self.tracks(p.count), icon: "music.note.list",
                    active: src == .userPlaylist(id: p.id), source: .userPlaylist(id: p.id))
            }
        case .folders:
            var dir: String?
            var order = "shuffle"
            if case let .playlist(d, o) = src { dir = d; order = o ?? "shuffle" }
            let all = Row(id: "dir:", name: "Уся бібліотека", meta: Self.tracks(store.folders?.total ?? 0), icon: "music.note",
                          active: dir == "", source: .playlist(dir: "", order: order))
            return [all] + (store.folders?.folders ?? []).map { f in
                Row(id: "dir:\(f.path)", name: f.name, meta: Self.tracks(f.count), icon: "folder",
                    active: dir == f.path, source: .playlist(dir: f.path, order: order))
            }
        case .stations:
            var rows = r.presets.map { p -> Row in
                var on = false
                if case let .relay(u, _) = src { on = u == p.url }
                return Row(id: p.id, name: p.name, meta: p.description, icon: "dot.radiowaves.left.and.right",
                           active: on, source: .relay(url: p.url, name: p.name))
            }
            if case let .relay(u, name) = src, !r.presets.contains(where: { $0.url == u }) {
                let host = URL(string: u)?.host ?? u
                rows.append(Row(id: "own", name: name ?? host, meta: host, icon: "dot.radiowaves.left.and.right", active: true, source: src))
            }
            return rows
        }
    }
}
