import Foundation

/// Inputs to the playback decision logic (no AVFoundation types, so it is unit-testable).
enum PlaybackEvent: Equatable {
    case userPlay
    case userStop
    case interruptionBegan
    case interruptionEnded(shouldResume: Bool)
    case routeOldDeviceUnavailable
    case mediaServicesReset
    case enteredForeground(isPlaying: Bool)
    case stalled
    case failed
}

enum PlaybackAction: Equatable {
    case none
    /// Drop the current item but keep the audio session (interruption began).
    case stopItem
    /// Drop the item and deactivate the session.
    case stopAll
    /// Open a brand new item at the live edge.
    case startFresh
    /// Rebuild the AVPlayer itself, then start fresh.
    case rebuildAndStart
}

struct PlaybackPolicy {
    /// What to do for `event`, given the flag as it was before the event.
    static func decide(_ event: PlaybackEvent, wantsPlaying: Bool) -> PlaybackAction {
        switch event {
        case .userPlay:
            return .startFresh
        case .userStop, .routeOldDeviceUnavailable:
            return .stopAll
        case .interruptionBegan:
            return .stopItem
        case .interruptionEnded:
            // Resume always means reconnect, regardless of .shouldResume.
            return wantsPlaying ? .startFresh : .none
        case .mediaServicesReset:
            return wantsPlaying ? .rebuildAndStart : .none
        case .enteredForeground(let isPlaying):
            return wantsPlaying && !isPlaying ? .startFresh : .none
        case .stalled, .failed:
            return wantsPlaying ? .startFresh : .none
        }
    }

    /// The new value of `wantsPlaying` after `event`.
    static func wantsPlaying(after event: PlaybackEvent, current: Bool) -> Bool {
        switch event {
        case .userPlay: return true
        case .userStop, .routeOldDeviceUnavailable: return false
        default: return current
        }
    }

    /// Reconnect delay for the given attempt: 0.5, 1, 2, 4 ... capped at 60 s.
    static func backoff(attempt: Int) -> TimeInterval {
        let n = max(0, min(attempt, 10))
        return min(60, 0.5 * pow(2, Double(n)))
    }
}
