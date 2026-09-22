# Cody icons

`icon.svg` is the app icon source: a white C and cursor on a black background. Its mark has the same geometry as the header SVG, with padding for app-icon sizes. `source.png` preserves an earlier concept and is not used by the app. Regenerate the desktop and web sizes with:

```sh
node scripts/export-cody-icons.mjs
```

The header uses the matching monochrome `CodyMark` SVG with `currentColor`, black in light mode and white in dark mode. Desktop packaging converts `icon-1024.png` into macOS and Linux assets and uses `icon.ico` on Windows. The official T3 mobile app is unchanged.
