import AVFoundation
import MediaPlayer
import UIKit

/// Plays the live stream and always resumes by reconnecting fresh (never from an old buffer).
/// Decisions come from `PlaybackPolicy`; this class only performs them.
@MainActor
final class RadioPlayer: NSObject, ObservableObject {
    @Published private(set) var wantsPlaying = false
    @Published private(set) var isPlaying = false
    @Published private(set) var trackTitle: String?
    @Published private(set) var streamURL: URL?

    let log = EventLog()

    private static let keychainAccount = "stream-url"
    private static let stuckWaitingSeconds: UInt64 = 10

    private var player = AVPlayer()
    private var item: AVPlayerItem?
    private var timeControlObservation: NSKeyValueObservation?
    private var itemStatusObservation: NSKeyValueObservation?
    private var itemObservers: [NSObjectProtocol] = []
    private var observers: [NSObjectProtocol] = []
    private var retryTask: Task<Void, Never>?
    private var watchdogTask: Task<Void, Never>?
    private var attempt = 0

    override init() {
        super.init()
        if let saved = Keychain.load(account: Self.keychainAccount) {
            streamURL = StreamLink.parse(saved)
        }
        configurePlayer()
        registerNotifications()
        registerRemoteCommands()
        log.add("app started")
    }

    // MARK: - Public API

    func play() { apply(.userPlay) }
    func stop() { apply(.userStop) }
    func toggle() { wantsPlaying ? stop() : play() }

    /// Returns false when `raw` is not an http(s) URL.
    @discardableResult
    func saveURL(_ raw: String) -> Bool {
        guard let url = StreamLink.parse(raw) else { return false }
        Keychain.save(url.absoluteString, account: Self.keychainAccount)
        streamURL = url
        log.add("stream url saved, host=\(url.host ?? "?")")
        if wantsPlaying { startFresh("url changed") }
        return true
    }

    func clearURL() {
        apply(.userStop)
        Keychain.delete(account: Self.keychainAccount)
        streamURL = nil
        log.add("stream url removed")
    }

    // MARK: - Event handling

    private func apply(_ event: PlaybackEvent) {
        let action = PlaybackPolicy.decide(event, wantsPlaying: wantsPlaying)
        wantsPlaying = PlaybackPolicy.wantsPlaying(after: event, current: wantsPlaying)
        switch action {
        case .none:
            break
        case .stopItem:
            cancelTimers()
            teardownItem()
        case .stopAll:
            cancelTimers()
            teardownItem()
            attempt = 0
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        case .startFresh:
            startFresh("\(event)")
        case .rebuildAndStart:
            cancelTimers()
            teardownItem()
            player = AVPlayer()
            configurePlayer()
            startFresh("media services reset")
        }
        updateNowPlaying()
    }

    private func startFresh(_ reason: String) {
        retryTask?.cancel()
        retryTask = nil
        guard wantsPlaying, let base = streamURL else { return }
        do {
            try activateSession()
        } catch {
            log.add("session activation failed (\(reason)): \(error.localizedDescription)")
            scheduleRetry("activation failed")
            return
        }
        teardownItem()

        let newItem = AVPlayerItem(url: StreamLink.fresh(base))
        newItem.preferredForwardBufferDuration = 2
        let output = AVPlayerItemMetadataOutput(identifiers: nil)
        output.setDelegate(self, queue: .main)
        newItem.add(output)

        itemStatusObservation = newItem.observe(\.status, options: [.new]) { [weak self] observed, _ in
            Task { @MainActor in self?.itemStatusChanged(observed) }
        }
        let center = NotificationCenter.default
        let names: [(Notification.Name, String)] = [
            (.AVPlayerItemFailedToPlayToEndTime, "failed to play to end"),
            (.AVPlayerItemPlaybackStalled, "playback stalled"),
            (.AVPlayerItemDidPlayToEndTime, "stream ended"),
        ]
        itemObservers = names.map { name, label in
            center.addObserver(forName: name, object: newItem, queue: .main) { [weak self] note in
                let error = (note.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? NSError)?.localizedDescription
                Task { @MainActor in self?.itemProblem(label, detail: error) }
            }
        }

        item = newItem
        trackTitle = nil
        player.replaceCurrentItem(with: newItem)
        player.play()
        log.add("start fresh (\(reason)), host=\(base.host ?? "?"), attempt=\(attempt)")
    }

    private func teardownItem() {
        itemStatusObservation = nil
        itemObservers.forEach { NotificationCenter.default.removeObserver($0) }
        itemObservers = []
        player.replaceCurrentItem(with: nil)
        item = nil
    }

    private func cancelTimers() {
        retryTask?.cancel()
        retryTask = nil
        watchdogTask?.cancel()
        watchdogTask = nil
    }

    private func scheduleRetry(_ reason: String) {
        guard wantsPlaying else { return }
        retryTask?.cancel()
        let delay = PlaybackPolicy.backoff(attempt: attempt)
        attempt += 1
        log.add("retry in \(delay)s (\(reason))")
        retryTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.startFresh("retry: \(reason)")
        }
    }

    private func itemProblem(_ label: String, detail: String?) {
        log.add("\(label)\(detail.map { ": \($0)" } ?? "")")
        if wantsPlaying { scheduleRetry(label) }
    }

    private func itemStatusChanged(_ observed: AVPlayerItem) {
        guard observed === item else { return }
        if observed.status == .failed {
            itemProblem("item failed", detail: observed.error?.localizedDescription)
        }
    }

    // MARK: - Player and session

    private func configurePlayer() {
        player.automaticallyWaitsToMinimizeStalling = true
        timeControlObservation = player.observe(\.timeControlStatus, options: [.new]) { [weak self] _, _ in
            Task { @MainActor in self?.timeControlChanged() }
        }
    }

    private func activateSession() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .default, policy: .longFormAudio, options: [])
        try session.setActive(true)
    }

    private func timeControlChanged() {
        let status = player.timeControlStatus
        isPlaying = status == .playing
        watchdogTask?.cancel()
        watchdogTask = nil
        if status == .playing {
            attempt = 0
        } else if status == .waitingToPlayAtSpecifiedRate && wantsPlaying {
            watchdogTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: Self.stuckWaitingSeconds * 1_000_000_000)
                guard !Task.isCancelled, let self else { return }
                if self.wantsPlaying && self.player.timeControlStatus == .waitingToPlayAtSpecifiedRate {
                    self.log.add("stuck waiting > \(Self.stuckWaitingSeconds)s")
                    self.scheduleRetry("stuck waiting")
                }
            }
        }
        updateNowPlaying()
    }

    // MARK: - Notifications

    private func observe(_ name: Notification.Name, _ handler: @escaping @MainActor (Notification) -> Void) {
        let token = NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { note in
            Task { @MainActor in handler(note) }
        }
        observers.append(token)
    }

    private func registerNotifications() {
        observe(AVAudioSession.interruptionNotification) { [weak self] in self?.handleInterruption($0) }
        observe(AVAudioSession.routeChangeNotification) { [weak self] in self?.handleRouteChange($0) }
        observe(AVAudioSession.mediaServicesWereResetNotification) { [weak self] _ in
            self?.log.add("media services were reset")
            self?.apply(.mediaServicesReset)
        }
        observe(UIApplication.willEnterForegroundNotification) { [weak self] _ in
            guard let self else { return }
            let live = self.player.currentItem != nil && self.player.timeControlStatus != .paused
            self.log.add("foreground, wantsPlaying=\(self.wantsPlaying), live=\(live)")
            self.apply(.enteredForeground(isPlaying: live))
        }
        // TODO(iOS 26+): if Apple ships newer interruption-lifecycle notifications (for example a
        // resumption recommendation), handle them here behind #available. The exact API names are
        // unverified, so nothing is invented. Dictation behaviour is visible in the in-app log.
    }

    private func handleInterruption(_ note: Notification) {
        let info = note.userInfo
        guard let typeRaw = info?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: typeRaw) else { return }
        let reasonRaw = info?[AVAudioSessionInterruptionReasonKey] as? UInt
        let reason = reasonRaw.map { "reason=\($0)" } ?? "reason=none"
        switch type {
        case .began:
            log.add("interruption began, \(reason)")
            apply(.interruptionBegan)
        case .ended:
            let optionsRaw = info?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
            let shouldResume = AVAudioSession.InterruptionOptions(rawValue: optionsRaw).contains(.shouldResume)
            log.add("interruption ended, options=\(optionsRaw), shouldResume=\(shouldResume), \(reason)")
            apply(.interruptionEnded(shouldResume: shouldResume))
        @unknown default:
            log.add("interruption unknown type \(typeRaw)")
        }
    }

    private func handleRouteChange(_ note: Notification) {
        let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
        let reason = raw.flatMap { AVAudioSession.RouteChangeReason(rawValue: $0) }
        let outputs = AVAudioSession.sharedInstance().currentRoute.outputs.map { $0.portType.rawValue }
        log.add("route change reason=\(raw.map(String.init) ?? "?"), outputs=\(outputs)")
        if reason == .oldDeviceUnavailable {
            apply(.routeOldDeviceUnavailable)
        }
    }

    // MARK: - Lock screen and Control Center

    private func registerRemoteCommands() {
        let commands = MPRemoteCommandCenter.shared()
        commands.playCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.play() }
            return .success
        }
        commands.pauseCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.stop() }
            return .success
        }
        commands.togglePlayPauseCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.toggle() }
            return .success
        }
    }

    private func updateNowPlaying() {
        let center = MPNowPlayingInfoCenter.default()
        guard wantsPlaying else {
            center.nowPlayingInfo = nil
            center.playbackState = .stopped
            return
        }
        center.nowPlayingInfo = [
            MPMediaItemPropertyTitle: trackTitle ?? "agent-radio",
            MPMediaItemPropertyArtist: "agent-radio",
            MPNowPlayingInfoPropertyIsLiveStream: true,
            MPNowPlayingInfoPropertyPlaybackRate: isPlaying ? 1.0 : 0.0,
        ]
        center.playbackState = isPlaying ? .playing : .paused
    }

    private func setTitle(from items: [AVMetadataItem]) async {
        let preferred = items.first { $0.commonKey == .commonKeyTitle } ?? items.first
        guard let preferred, let value = try? await preferred.load(.stringValue), !value.isEmpty else { return }
        trackTitle = value
        log.add("metadata title: \(value)")
        updateNowPlaying()
    }
}

extension RadioPlayer: AVPlayerItemMetadataOutputPushDelegate {
    nonisolated func metadataOutput(_ output: AVPlayerItemMetadataOutput,
                                    didOutputTimedMetadataGroups groups: [AVTimedMetadataGroup],
                                    from track: AVPlayerItemTrack?) {
        let items = groups.flatMap { $0.items }
        guard !items.isEmpty else { return }
        Task { @MainActor in await self.setTitle(from: items) }
    }
}
