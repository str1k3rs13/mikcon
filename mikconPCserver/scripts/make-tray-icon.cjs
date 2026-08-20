// Generates main/assets/tray.png (32x32) from build/icon.png (512x512).
//
// build/ is buildResources: electron-builder consumes it at BUILD time and it does not exist at
// runtime inside the installed app, so the tray icon has to be a packaged file of its own under
// main/, where the existing main/**/* glob covers it.
//
// The output is committed. This script exists so it can be regenerated when the logo changes - the
// build does not run it, and must not, because that would make Electron a build-time image
// dependency of the packaging step.
//
// nativeImage rather than an image library, so the zero-dependency rule survives.
//
// .cjs, not .js: package.json says "type": "module", so a .js file here is loaded as ESM and dies
// on `require` before it does anything - as an Electron error dialog, not a console message.
// test/smoke/make-fixture.js gets away with .js only because test/smoke/ has its own package.json.
//
// Run: npm run make:tray-icon
const { app, nativeImage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "build", "icon.png");
const OUT = path.join(ROOT, "main", "assets", "tray.png");

// The source is the app icon: the router-and-arcs mark, small, inside a very dark navy disc with a
// bright blue rim, a pale halo, and a wide margin. Resized whole to 32px it becomes an unreadable
// dark blob - the mark is about a third of the canvas, and a near-black disc has no contrast on a
// dark taskbar. So the mark is cropped out first and the disc is dropped; a bare mark on
// transparency is what reads on both light and dark taskbars, and is what tray icons normally are.
//
// MEASURED, not detected. Colour thresholding cannot separate the mark from the disc's rim: both
// are bright blue, so every threshold that finds the mark also finds a ring at the full diameter
// and "crops" to the whole image. These are pixel coordinates in the 512x512 source, square so the
// resize does not distort. If the logo changes, re-measure them and LOOK at the output - no
// assertion in this repo can tell you the result is legible.
const SRC_SIZE = 512;
const MARK = { x: 130, y: 112, width: 260, height: 260 };

app.whenReady().then(() => {
  const img = nativeImage.createFromPath(SRC);
  // createFromPath returns an EMPTY image rather than throwing when the path is unreadable.
  if (img.isEmpty()) {
    console.error("could not read " + SRC);
    app.exit(1);
    return;
  }
  // A logo of a different size would make MARK's coordinates mean something else entirely, and the
  // failure would be a silently wrong crop rather than an error.
  const { width, height } = img.getSize();
  if (width !== SRC_SIZE || height !== SRC_SIZE) {
    console.error(`${SRC} is ${width}x${height}, not ${SRC_SIZE}x${SRC_SIZE} - re-measure MARK`);
    app.exit(1);
    return;
  }
  const resized = img.crop(MARK).resize({ width: 32, height: 32, quality: "best" });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, resized.toPNG());
  console.log("wrote " + OUT + " (" + fs.statSync(OUT).size + " bytes)");
  app.exit(0);
});
