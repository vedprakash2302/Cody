# Cody icons

`icon.svg` is the app icon source: the terminal pup, a black prompt window with pointed spitz ears showing `>_`, on a white background. Its mark has the same straight-line geometry as the header SVG, with padding for app-icon sizes. `source.png` preserves an earlier concept and is not used by the app. Regenerate the desktop and web sizes with:

```sh
node scripts/export-cody-icons.mjs
```

The header uses the matching monochrome `CodyMark` SVG with `currentColor` and no background, black in light mode and white in dark mode. Desktop packaging converts `icon-1024.png` into macOS and Linux assets and uses `icon.ico` on Windows. The official T3 mobile app is unchanged.

`project-icon.svg` is this repository's sidebar icon, set by `iconPath` in `t3.json`. It is the black pup on a white tile in every theme. Its mark fills the tile, larger than the app icon's, so it stays legible at 16px. Keep colors as plain `fill` and `stroke` attributes. The iOS app renders SVGs with Apple's CoreSVG, which misreads an embedded `<style>` with a `prefers-color-scheme` media query and drew the earlier theme-switching version as a white square.
