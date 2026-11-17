import SwiftUI

@main
struct AgentRadioApp: App {
    @StateObject private var radio: RadioPlayer
    @StateObject private var store: RemoteStore

    init() {
        let player = RadioPlayer()
        _radio = StateObject(wrappedValue: player)
        _store = StateObject(wrappedValue: RemoteStore(player: player))
    }

    var body: some Scene {
        WindowGroup {
            RemoteView()
                .environmentObject(radio)
                .environmentObject(store)
        }
    }
}
