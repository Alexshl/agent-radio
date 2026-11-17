import SwiftUI

@main
struct AgentRadioApp: App {
    @StateObject private var radio = RadioPlayer()

    var body: some Scene {
        WindowGroup {
            TabView {
                RemoteView()
                    .tabItem { Label("remote.title", systemImage: "slider.horizontal.3") }
                ContentView()
                    .tabItem { Label("player.tab", systemImage: "dot.radiowaves.left.and.right") }
            }
            .environmentObject(radio)
        }
    }
}
