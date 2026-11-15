import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var radio: RadioPlayer
    @State private var input = ""
    @State private var invalid = false

    var body: some View {
        NavigationStack {
            Form {
                playerSection
                settingsSection
                Section {
                    NavigationLink("log.title") { LogView(log: radio.log) }
                }
            }
            .navigationTitle(Text(verbatim: "agent-radio"))
        }
    }

    private var statusKey: LocalizedStringKey {
        if radio.streamURL == nil { return "status.nourl" }
        if radio.isPlaying { return "status.playing" }
        return radio.wantsPlaying ? "status.connecting" : "status.stopped"
    }

    private var playerSection: some View {
        Section {
            VStack(spacing: 12) {
                Button {
                    radio.toggle()
                } label: {
                    Image(systemName: radio.wantsPlaying ? "stop.circle.fill" : "play.circle.fill")
                        .resizable()
                        .frame(width: 112, height: 112)
                }
                .buttonStyle(.plain)
                .disabled(radio.streamURL == nil)
                .accessibilityLabel(Text(LocalizedStringKey(radio.wantsPlaying ? "stop" : "play")))
                Text(statusKey).font(.headline)
                if let title = radio.trackTitle {
                    Text(verbatim: title).font(.subheadline).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
        }
    }

    private var settingsSection: some View {
        Section("settings.title") {
            if let url = radio.streamURL {
                let masked = StreamLink.masked(url)
                LabeledContent("Host") { Text(verbatim: masked.host) }
                if let token = masked.token {
                    LabeledContent("settings.token") { Text(verbatim: token) }
                }
                Button("settings.clear", role: .destructive) { radio.clearURL() }
            }
            TextField("settings.url.placeholder", text: $input)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
            HStack {
                Button("settings.paste") { input = UIPasteboard.general.string ?? input }
                Spacer()
                Button("settings.save") {
                    invalid = !radio.saveURL(input)
                    if !invalid { input = "" }
                }
                .disabled(input.isEmpty)
            }
            .buttonStyle(.borderless)
            if invalid {
                Text("settings.invalid").foregroundStyle(.red).font(.footnote)
            }
        }
    }
}

struct LogView: View {
    @ObservedObject var log: EventLog

    var body: some View {
        List {
            if log.entries.isEmpty {
                Text("log.empty").foregroundStyle(.secondary)
            }
            ForEach(Array(log.entries.enumerated().reversed()), id: \.offset) { _, line in
                Text(verbatim: line)
                    .font(.system(.caption2, design: .monospaced))
            }
        }
        .navigationTitle(Text("log.title"))
        .toolbar {
            Button("log.copy") { UIPasteboard.general.string = log.text }
        }
    }
}
