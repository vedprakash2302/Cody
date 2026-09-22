# Cody icons

`source.png` is the generated Cody artwork: an ivory C and yellow cursor on teal. Regenerate the desktop and web sizes with:

```sh
node scripts/export-cody-icons.mjs
```

The header uses the matching monochrome `CodyMark` SVG with `currentColor`, so it follows the current theme. Desktop packaging converts `icon-1024.png` into macOS and Linux assets and uses `icon.ico` on Windows. The official T3 mobile app is unchanged.
