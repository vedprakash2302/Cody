import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import sharp from "sharp";

const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const output = NodePath.join(root, "assets/cody");
await NodeFSP.mkdir(output, { recursive: true });
const input = process.argv[2] || NodePath.join(output, "source.png");
if (NodePath.resolve(input) !== NodePath.join(output, "source.png"))
  await NodeFSP.copyFile(input, NodePath.join(output, "source.png"));
const source = NodePath.join(output, "source.png");
for (const size of [16, 32, 64, 180, 256, 512, 1024]) {
  await sharp(source)
    .resize(size, size)
    .png()
    .toFile(NodePath.join(output, `icon-${size}.png`));
}
const frames = await Promise.all(
  [16, 32, 48, 64, 128, 256].map(async (size) => ({
    size,
    data: await sharp(source).resize(size, size).png().toBuffer(),
  })),
);
const header = Buffer.alloc(6 + frames.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(frames.length, 4);
let offset = header.length;
frames.forEach(({ size, data }, index) => {
  const p = 6 + index * 16;
  header[p] = size === 256 ? 0 : size;
  header[p + 1] = header[p];
  header.writeUInt16LE(1, p + 4);
  header.writeUInt16LE(32, p + 6);
  header.writeUInt32LE(data.length, p + 8);
  header.writeUInt32LE(offset, p + 12);
  offset += data.length;
});
await NodeFSP.writeFile(
  NodePath.join(output, "icon.ico"),
  Buffer.concat([header, ...frames.map(({ data }) => data)]),
);
for (const [src, dest] of [
  ["icon.ico", "favicon.ico"],
  ["icon-16.png", "favicon-16x16.png"],
  ["icon-32.png", "favicon-32x32.png"],
  ["icon-180.png", "apple-touch-icon.png"],
]) {
  await NodeFSP.copyFile(NodePath.join(output, src), NodePath.join(root, "apps/web/public", dest));
}
