# agent-radio for iOS

A minimal native player for the agent-radio live Icecast stream. It exists to fix one thing: after iOS interrupts audio (for example keyboard dictation in another app), the app reconnects at the **live edge** instead of resuming a stale buffer.

How it works: on `AVAudioSession.interruptionNotification` `.began` the player item is dropped. On `.ended` (with or without `.shouldResume`) a brand new `AVPlayerItem` with a cache-busting query is opened, retrying with backoff (0.5, 1, 2, 4 ... 60 s) while the session is still busy. Headphones unplugged stops playback, stalls and failures reconnect, and returning to the foreground restarts if you still want playback.

Requirements: a Mac with Xcode 16+, an iPhone on iOS 17+.

## Build steps (Mac)

1. `brew install xcodegen`
2. `cd ios`
3. `xcodegen` (creates `AgentRadio.xcodeproj`)
4. `open AgentRadio.xcodeproj`
5. In Xcode select the `AgentRadio` target, then Signing & Capabilities:
   - set Team to your Apple ID (a free account works, but the app expires after 7 days);
   - change the Bundle Identifier to something unique, e.g. `com.yourname.agentradio` (the default `com.example.agentradio.app` is a placeholder; the same prefix is in `project.yml`).
6. Plug in the iPhone and unlock it. On the phone enable Settings, Privacy and Security, Developer Mode (it restarts the phone). After the first install, trust the developer under Settings, General, VPN and Device Management.
7. Pick the iPhone as the run destination and press Run.

Unit tests (`AgentRadioTests`): Product, Test, or `xcodebuild test -scheme AgentRadio -destination 'platform=iOS Simulator,name=iPhone 16'`.

Keeping it installed:
- Free Apple ID: re-run from Xcode every 7 days, or use AltStore / SideStore for automatic re-signing.
- Paid Apple Developer account: distribute through TestFlight (builds last 90 days).

## Using the app

1. Copy your personal stream link (`https://<host>/stream/<id>.mp3?k=<listen token>`) on the phone.
2. Open the app, tap Paste, then Save. The link is stored in the Keychain; the screen then shows only the host and a masked token. "Remove link" deletes it.
3. Tap the big Play button. Stop sets "do not resume"; Play and the lock screen play button both reconnect fresh.

## Reading the log

Open the Log row at the bottom of the screen: the last 200 events with timestamps (interruption began/ended with raw options and reason, route changes, reconnects, errors, ICY titles). Tap "Copy log" and paste it where you need it. To learn what dictation sends: play, dictate in another app, return, and copy the log.

The UI is Ukrainian by default with an English fallback (`AgentRadio/uk.lproj`, `AgentRadio/en.lproj`).
