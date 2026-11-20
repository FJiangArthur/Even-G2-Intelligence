// Simulator probe: which imageData encoding renders, which glyphs render, text brightness levels.
import { CreateStartUpPageContainer, ImageContainerProperty, TextContainerProperty, waitForEvenAppBridge } from "@evenrealities/even_hub_sdk";
import { blankImage, drawBitmap, encodeGrayPng, type GrayImage } from "../src/glasses-image";

const log = (line: string) => { document.getElementById("log")!.textContent += `${line}\n`; console.log(`[probe] ${line}`); };
const bridge = await waitForEvenAppBridge();
const W = 96, H = 48;
function gradient(): GrayImage {
  const image = blankImage(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) image.pixels[y * W + x] = Math.floor(x / (W / 16)) * 17;
  drawBitmap(image, ["#..#", ".##.", ".##.", "#..#"], 2, 2, 4);
  return image;
}
function bmp24(image: GrayImage): Uint8Array {
  const rowSize = Math.ceil((image.width * 3) / 4) * 4, size = 54 + rowSize * image.height, out = new Uint8Array(size), v = new DataView(out.buffer);
  out[0] = 0x42; out[1] = 0x4d; v.setUint32(2, size, true); v.setUint32(10, 54, true); v.setUint32(14, 40, true);
  v.setInt32(18, image.width, true); v.setInt32(22, image.height, true); v.setUint16(26, 1, true); v.setUint16(28, 24, true); v.setUint32(34, rowSize * image.height, true);
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const g = image.pixels[(image.height - 1 - y) * image.width + x]!, at = 54 + y * rowSize + x * 3;
    out[at] = g; out[at + 1] = g; out[at + 2] = g;
  }
  return out;
}
const packed4 = (image: GrayImage) => { const out = new Uint8Array(Math.ceil(image.pixels.length / 2)); for (let i = 0; i < image.pixels.length; i++) out[i >> 1]! |= (image.pixels[i]! >> 4) << (i & 1 ? 0 : 4); return out; };

const glyphs = "○◇■□━─│▁▂▃▄▅▆▇█░▒▓▌▐★☆♥♡◉◎⬤✦❯›▪▫⌁◀◁▷△▽◢◣◤◥▕▏┃╭╮╰╯═║";
const text = (id: number, y: number, content: string, color: number, capture = 0) => new TextContainerProperty({ containerID: id, containerName: `t${id}`, xPosition: 0, yPosition: y, width: 576, height: 28, borderWidth: 0, borderColor: 0, borderRadius: 0, paddingLength: 0, content, isEventCapture: capture, ...(color >= 0 ? { textColor: color } : {}) } as never);
const images = [0, 1, 2, 3].map(i => new ImageContainerProperty({ containerID: 10 + i, containerName: `img${i}`, xPosition: i * 144, yPosition: 180, width: W, height: H }));
const page = new CreateStartUpPageContainer({
  containerTotalNum: 8,
  textObject: [text(1, 0, `GLYPHS ${glyphs}`, 4, 1), text(2, 30, "level 4 bright ●◆▶", 4), text(3, 60, "level 3 ●◆▶", 3), text(4, 90, "level 2 ●◆▶", 2), text(5, 120, "level 1 ●◆▶", 1), text(6, 150, "A=PNG  B=BMP24  C=raw8  D=raw4", 3)],
  imageObject: images,
} as never);
log(`create: ${await bridge.createStartUpPageContainer(page)}`);
const g = gradient();
const payloads: [string, number[]][] = [["png", Array.from(encodeGrayPng(g))], ["bmp24", Array.from(bmp24(g))], ["raw8", Array.from(g.pixels)], ["raw4", Array.from(packed4(g))]];
for (let i = 0; i < 4; i++) {
  const [name, data] = payloads[i]!;
  const result = await bridge.updateImageRawData({ containerID: 10 + i, containerName: `img${i}`, imageData: data } as never);
  log(`image ${name}: ${String(result)} (${data.length} bytes)`);
  await new Promise(r => setTimeout(r, 300));
}
log("PROBE_DONE");
