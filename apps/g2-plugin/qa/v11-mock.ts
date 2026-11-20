// Static mock of the proposed v0.11 glasses layout (right rail). Not production code.
import { CreateStartUpPageContainer, RebuildPageContainer, ImageContainerProperty, ImageRawDataUpdate, ListContainerProperty, ListItemContainerProperty, TextContainerProperty, waitForEvenAppBridge } from "@evenrealities/even_hub_sdk";
import { HUD_IMAGES, renderImage } from "../src/glasses-hud";
import { encodeGrayPng } from "../src/glasses-image";
const bridge = await waitForEvenAppBridge();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const RAIL = 142, RX = 576 - RAIL - 6, BW = RX - 8;
const t = (id: number, name: string, x: number, y: number, w: number, h: number, content: string, color: number, border = 0, bc = 0, pad = 0, cap = 0) =>
  new TextContainerProperty({ containerID: id, containerName: name, xPosition: x, yPosition: y, width: w, height: h, borderWidth: border, borderColor: bc, borderRadius: border ? 8 : 0, paddingLength: pad, content, textColor: color, isEventCapture: cap } as never);
const imgs = () => (["mascot", "badge"] as const).map(k => new ImageContainerProperty({ ...HUD_IMAGES[k] }));
async function images(mode: string, mascot: string) {
  for (const [k, key] of [["mascot", `mascot:${mascot}`], ["badge", `badge:${mode}`]] as const) {
    await bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: HUD_IMAGES[k].containerID, containerName: HUD_IMAGES[k].containerName, imageData: encodeGrayPng(renderImage(key)) }));
    await sleep(200);
  }
}
const caption = "Them: …twelve weeks right now, so we need a fallback, and the\nx86 box with a discrete GPU could ship";
const page = (title: string, status: string, body: string, mode: string, views: string, menu?: string[]) => ({
  containerTotalNum: 8,
  textObject: [
    t(9, "frame", 0, 38, 576, 194, " ", 4, 2, 9, 0, 0),                       // one big box
    t(2, "body", 8, 42, BW, 186, body, 4, 0, 0, 0, menu ? 0 : 1),             // left: content
    t(1, "header", 44, 2, 222, 34, title, 4), t(5, "status", 268, 2, 264, 34, status, 2),
    t(3, "caption", 6, 234, 564, 54, caption, 3),
    t(6, "rail-mode", RX, 42, RAIL, 28, mode, 4),                             // right, inside the box
    ...(menu ? [] : [t(7, "rail-views", RX, 69, RAIL, 160, views, 2)]),
  ],
  ...(menu ? { listObject: [new ListContainerProperty({ containerID: 8, containerName: "rail-menu", xPosition: RX - 4, yPosition: 68, width: RAIL + 6, height: 160, borderWidth: 0, borderColor: 0, borderRadius: 0, paddingLength: 0, isEventCapture: 1,
    itemContainer: new ListItemContainerProperty({ itemCount: menu.length, itemWidth: RAIL, isItemSelectBorderEn: 1, itemName: menu }) } as never)] } : {}),
  imageObject: imgs(),
});
const scene = async (name: string) => { await sleep(1500); console.log(`[scene] ${name}`); await sleep(2500); };
await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(page("LIVE", "               ● 12m · 2 new",
  "CDTF: Camera data transfer framework:\nsyncs and timestamps multi-camera\nframes.\n\n· Claim: Orin lead time is ~12 weeks\n· → LOOKUP · Jetson lead time…",
  "TECHNICAL", "▶ LIVE\nANSWER ①\nASK ③\nCONCEPTS ②\nSUMMARY\nCHECKS ①") as never));
await images("technical", "listening");
await scene("A-live");
await bridge.rebuildPageContainer(new RebuildPageContainer(page("◆ THEY ASKED 1/1", "     ● 12m · tap to close",
  "Q: Is 16 GB of RAM enough while\nrecording?\nUsually yes for one 4K camera at 30\nfps; budget about 6 GB for ROS nodes\nand write bags to a separate NVMe\npartition.",
  "TECHNICAL", "LIVE\n▶ ANSWER\nASK ③\nCONCEPTS ②\nSUMMARY\nCHECKS ⑨") as never));
await images("technical", "speaking");
await scene("B-answer");
await bridge.rebuildPageContainer(new RebuildPageContainer(page("PROBE 1/3", "               ● 12m · say it",
  "▶ ① What did you personally own\n      in that migration?\n   ② What broke first when traffic\n      doubled?\n   ③ How did you measure the win?",
  "INTERVIEWER", "", ["Pause", "Stop", "Mode ▶", "Ask", "Verify", "Close"]) as never));
await images("interviewer", "listening");
await scene("C-menu");
console.log("[scene] done");
