import XCTest
@testable import AgentRadio

final class PlaybackPolicyTests: XCTestCase {
    func testInterruptionBeganDropsItem() {
        XCTAssertEqual(PlaybackPolicy.decide(.interruptionBegan, wantsPlaying: true), .stopItem)
    }

    func testInterruptionEndedStartsFreshEvenWithoutShouldResume() {
        XCTAssertEqual(PlaybackPolicy.decide(.interruptionEnded(shouldResume: false), wantsPlaying: true), .startFresh)
        XCTAssertEqual(PlaybackPolicy.decide(.interruptionEnded(shouldResume: true), wantsPlaying: true), .startFresh)
    }

    func testInterruptionEndedDoesNothingWhenUserStopped() {
        XCTAssertEqual(PlaybackPolicy.decide(.interruptionEnded(shouldResume: true), wantsPlaying: false), .none)
    }

    func testRouteLossStopsAndClearsWant() {
        XCTAssertEqual(PlaybackPolicy.decide(.routeOldDeviceUnavailable, wantsPlaying: true), .stopAll)
        XCTAssertFalse(PlaybackPolicy.wantsPlaying(after: .routeOldDeviceUnavailable, current: true))
    }

    func testForegroundRestartsOnlyWhenWantedAndNotPlaying() {
        XCTAssertEqual(PlaybackPolicy.decide(.enteredForeground(isPlaying: false), wantsPlaying: true), .startFresh)
        XCTAssertEqual(PlaybackPolicy.decide(.enteredForeground(isPlaying: true), wantsPlaying: true), .none)
        XCTAssertEqual(PlaybackPolicy.decide(.enteredForeground(isPlaying: false), wantsPlaying: false), .none)
    }

    func testMediaServicesResetRebuilds() {
        XCTAssertEqual(PlaybackPolicy.decide(.mediaServicesReset, wantsPlaying: true), .rebuildAndStart)
        XCTAssertEqual(PlaybackPolicy.decide(.mediaServicesReset, wantsPlaying: false), .none)
    }

    func testUserActionsSetWant() {
        XCTAssertTrue(PlaybackPolicy.wantsPlaying(after: .userPlay, current: false))
        XCTAssertFalse(PlaybackPolicy.wantsPlaying(after: .userStop, current: true))
        XCTAssertTrue(PlaybackPolicy.wantsPlaying(after: .interruptionBegan, current: true))
    }

    func testBackoffSequenceIsCappedAt60() {
        XCTAssertEqual(PlaybackPolicy.backoff(attempt: 0), 0.5)
        XCTAssertEqual(PlaybackPolicy.backoff(attempt: 1), 1)
        XCTAssertEqual(PlaybackPolicy.backoff(attempt: 3), 4)
        XCTAssertEqual(PlaybackPolicy.backoff(attempt: 50), 60)
    }

    func testStreamLinkParseAndFresh() {
        XCTAssertNil(StreamLink.parse("ftp://x/y"))
        XCTAssertNil(StreamLink.parse("not a url"))
        guard let url = StreamLink.parse(" https://example.com/stream/a.mp3?k=abcdef ") else {
            return XCTFail("expected a valid URL")
        }
        XCTAssertEqual(StreamLink.masked(url).host, "example.com")
        XCTAssertEqual(StreamLink.masked(url).token?.hasPrefix("ab"), true)
        let fresh = StreamLink.fresh(url, now: Date(timeIntervalSince1970: 1))
        XCTAssertTrue(fresh.absoluteString.contains("k=abcdef"))
        XCTAssertTrue(fresh.absoluteString.contains("_=1000"))
    }
}
