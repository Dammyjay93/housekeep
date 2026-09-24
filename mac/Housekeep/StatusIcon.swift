import AppKit

/// Housekeep's mark, drawn for the menu bar: main arriving at the interchange, with the light inside
/// in the colour of the worst project. The same shapes as assets/logo.svg, on its 32-point grid.
enum StatusIcon {
    /// `height` is the mark's own height; the image adds a little room around it.
    static func image(tier: Tier?, height: CGFloat = 10) -> NSImage {
        // The mark spans x 1.75...30.5 and y 9...23 on the 32-point grid, strokes and caps included.
        let scale = height / 14
        let size = NSSize(width: ceil(28.75 * scale) + 2, height: ceil(height) + 6)
        let dx = (size.width - 28.75 * scale) / 2 - 1.75 * scale
        let dy = (size.height - 14 * scale) / 2 - 9 * scale
        let point = { (x: CGFloat, y: CGFloat) in NSPoint(x: dx + x * scale, y: dy + y * scale) }

        let image = NSImage(size: size, flipped: true) { _ in
            // Drawn when shown, so labelColor follows the menu bar's light or dark appearance. Made opaque,
            // or the line and the station would darken where they overlap.
            (NSColor.labelColor.usingColorSpace(.sRGB)?.withAlphaComponent(1) ?? NSColor.labelColor).setStroke()
            let main = NSBezierPath()
            main.move(to: point(3.5, 16))
            main.line(to: point(12, 16))
            main.lineWidth = 3.5 * scale
            main.lineCapStyle = .round
            main.stroke()

            let origin = point(11, 10.5)
            let station = NSBezierPath(roundedRect: NSRect(x: origin.x, y: origin.y, width: 18 * scale, height: 11 * scale),
                                       xRadius: 5.5 * scale, yRadius: 5.5 * scale)
            station.lineWidth = 3 * scale
            station.stroke()

            // A touch larger than the logo's, so the colour reads at menu bar size.
            let r = 2.8 * scale
            let centre = point(23.5, 16)
            Palette.nsTier(tier).setFill()
            NSBezierPath(ovalIn: NSRect(x: centre.x - r, y: centre.y - r, width: r * 2, height: r * 2)).fill()
            return true
        }
        image.isTemplate = false
        image.accessibilityDescription = "Housekeep"
        return image
    }
}
