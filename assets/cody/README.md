# Cody icons

`icon.svg` is the app icon source: the terminal pup, a black prompt window with pointed spitz ears showing `>_`, on a white background. Its mark has the same straight-line geometry as the header SVG, with padding for app-icon sizes. `source.png` preserves an earlier concept and is not used by the app. Regenerate the desktop and web sizes with:

```sh
node scripts/export-cody-icons.mjs
```

The header uses the matching monochrome `CodyMark` SVG with `currentColor` and no background, black in light mode and white in dark mode. Desktop packaging converts `icon-1024.png` into macOS and Linux assets and uses `icon.ico` on Windows. The official T3 mobile app is unchanged.

`project-icon.svg` is this repository's sidebar icon, set by `iconPath` in `t3.json`. T3 Code has no separate dark project icon, so the SVG switches itself with `prefers-color-scheme`: black on white in light mode, white on black in dark mode. Its mark is larger than the app icon's so it stays legible at 16px. The web and desktop clients follow the app theme through the page's `color-scheme`. Clients that ignore the media query show the light version.
