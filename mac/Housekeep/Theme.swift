import AppKit
import SwiftUI

/// The map's own materials (assets/dashboard.html): near black, layers a few percent apart, hairline
/// outlines, three levels of text, and colour only for state. The controls on top are the system's.
enum Palette {
    static let black = Color(hex: 0x000000)
    static let shell = Color(hex: 0x080808)
    static let layer1 = Color(hex: 0x0E0E0E)
    static let layer2 = Color(hex: 0x151515)
    static let line = Color.white.opacity(0.07)
    static let line2 = Color.white.opacity(0.11)
    static let text = Color(hex: 0xEDEDED)
    static let text2 = Color(hex: 0x9B9B9B)
    static let text3 = Color(hex: 0x5F5F5F)

    static func tier(_ tier: Tier?) -> Color { Color(nsColor: nsTier(tier)) }

    static func nsTier(_ tier: Tier?) -> NSColor {
        switch tier {
        case .atRisk: NSColor(hex: 0xCF6360)
        case .attention: NSColor(hex: 0xC89B4E)
        case .safe: NSColor(hex: 0x52A67C)
        case nil: .tertiaryLabelColor
        }
    }
}

extension Color {
    init(hex: UInt32) { self.init(nsColor: NSColor(hex: hex)) }
}

extension NSColor {
    convenience init(hex: UInt32) {
        self.init(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                  blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
}

/// Red a filled dot, amber a ring, green a small quiet dot: shape as well as colour, like the map.
struct TierDot: View {
    let tier: Tier?

    var body: some View {
        switch tier {
        case .attention:
            Circle().strokeBorder(Palette.tier(tier), lineWidth: 1.5).frame(width: 7, height: 7)
        case .safe:
            Circle().fill(Palette.tier(tier)).frame(width: 5, height: 5).opacity(0.85)
        default:
            Circle().fill(Palette.tier(tier)).frame(width: 7, height: 7)
        }
    }
}

extension View {
    /// The system's buttons: Liquid Glass capsules on macOS 26 and later (macOS draws glass buttons as
    /// rounded rectangles unless told otherwise), bordered before it. The prominent one is clear glass with a
    /// light wash of the accent: glassProminent fills the glass with its tint until it reads as a solid pill.
    @ViewBuilder func systemButton(prominent: Bool = false) -> some View {
        if #available(macOS 26, *) {
            if prominent { buttonStyle(.glass(.regular.tint(Palette.accent.opacity(0.35)))).buttonBorderShape(.capsule) }
            else { buttonStyle(.glass).buttonBorderShape(.capsule) }
        } else {
            if prominent { buttonStyle(.borderedProminent).tint(Palette.text).foregroundStyle(Palette.black) } else { buttonStyle(.bordered) }
        }
    }

    /// A card in the map's style: layer one, outlined by a hairline.
    func card(radius: CGFloat = 12) -> some View {
        background(RoundedRectangle(cornerRadius: radius, style: .continuous).fill(Palette.layer1))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(Palette.line, lineWidth: 1))
    }
}

extension Palette {
    static let track = Color(hex: 0xD9D9D9)
    static let trackSoft = Color(hex: 0x3B3B3B)
    static let accent = Color(hex: 0x8A8FD9)
    static let red = Color(hex: 0xE0726E)
    static let amber = Color(hex: 0xD4A85A)
    static let green = Color(hex: 0x5FB88A)
}

extension View {
    /// Liquid Glass in a capsule on macOS 26 and later; a hairline pill before it.
    @ViewBuilder func glassCapsule() -> some View {
        if #available(macOS 26, *) {
            glassEffect(.regular, in: .capsule)
        } else {
            background(Capsule().fill(Palette.layer2)).overlay(Capsule().strokeBorder(Palette.line, lineWidth: 1))
        }
    }
}
