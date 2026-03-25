# PixelPrint 3D

A browser-based pixel art tool that exports ready-to-print `.3mf` files for **Bambu Lab** printers with AMS multi-color support.

Draw pixel art, preview it in 3D, then download a `.3mf` file you can open directly in Bambu Studio — no plugins, no installation required.

---

## Features

- **32×32 pixel canvas** with pencil, fill, rectangle, and line tools
- **Undo / redo** (Ctrl+Z / Ctrl+Y)
- **Right-click to erase** on the canvas
- **3D preview** with real bed dimensions (Bambu Lab X1/P1 series — 256×256 mm)
- **Export to .3mf** with correct AMS filament slot assignment (up to 4 colors)
- **Pixel size control** — adjustable mm-per-pixel, max model size ~160×160 mm to leave room for the prime tower
- **Auto-save** — drawing and settings are preserved in local storage
- **11 languages** — English, Norwegian, German, French, Spanish, Portuguese, Swedish, Danish, Finnish, Chinese, Japanese

## Usage

Open [pixelprint-3d.stian.cloud](https://pixelprint-3d.stian.cloud) in your browser — no installation needed.

1. **Draw** your pixel art on the canvas
2. Pick up to 4 colors matching your loaded AMS filaments
3. Click **Preview** to see the 3D model and adjust thickness and pixel size
4. Click **Download .3MF** and open the file in Bambu Studio

## Running locally

No build step required — serve the folder with any static file server:

```bash
npx serve .
```

> Note: ES modules require a server (file:// won't work). Use Live Server in VS Code or any static server.

## Tech stack

- [Three.js](https://threejs.org) — 3D preview
- [Lucide](https://lucide.dev) — icons
- [JSZip](https://stuk.github.io/jszip/) — .3mf generation
- [FileSaver.js](https://github.com/eligrey/FileSaver.js) — file download
- [Inter](https://rsms.me/inter/) — font

## License

MIT © [Stian Johansen](https://stianjohansen.no)
