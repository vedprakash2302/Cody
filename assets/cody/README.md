# Cody icons

`icon.svg` is the app icon source. It uses exactly the header mark's C and cursor geometry, in teal on a transparent background. There is no enclosing tile. `source.png` preserves the original generated concept. Regenerate the desktop and web sizes with:

```sh
node scripts/export-cody-icons.mjs
```

The header uses the matching monochrome `CodyMark` SVG with `currentColor`, so it follows the current theme. Desktop packaging converts `icon-1024.png` into macOS and Linux assets and uses `icon.ico` on Windows. The official T3 mobile app is unchanged.
