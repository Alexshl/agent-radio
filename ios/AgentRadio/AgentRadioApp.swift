import SwiftUI

@main
struct AgentRadioApp: App {
    @StateObject private var radio = RadioPlayer()

    var body: some Scene {
        WindowGroup {
            RemoteView()
                .environmentObject(radio)
        }
    }
}
