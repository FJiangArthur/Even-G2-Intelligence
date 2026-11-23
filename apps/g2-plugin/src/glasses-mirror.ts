/**
 * Phone mirror of the glasses HUD (v0.8, v0.10 layout). A pure DOM component: no CSS file, no app state.
 * Draws a 576×288 (2:1) mini display, green on black, exactly as the glasses show it: the
 * pixel-art mascot and mode badge, title + right-aligned status, the rounded BODY card (or the
 * MENU list with its highlight), the splash while not connected, and the caption. Coordinates
 * follow the HUD geometry (glasses-hud.ts HUD_PANELS / HUD_MENU_LIST / HUD_IMAGES) in an SVG
 * viewBox, so it scales to any width the phone gives it.
 *
 *   renderGlassesMirror(element, snapshot.hud)   // call on every presentation snapshot
 *   ui.selectTab(tabForHudView(snapshot.hud.view)) // optional: phone follows the glasses
 */
import type { HudMirror } from "@helix/conversation-sdk";
import { HUD_FRAME, HUD_IMAGES, HUD_LINE_HEIGHT, HUD_LINE_WIDTH, HUD_MENU_LIST, HUD_PANELS, hudTextWidth, renderImage, tabForHudView } from "./glasses-hud";

export { tabForHudView };

const SVG_NS = "http://www.w3.org/2000/svg";
const MENU_PITCH = 40; // simulator 0.9.5: list item pitch in canvas px
const MENU_VISIBLE = 4;
/** G2 text brightness 2 / 3 / 4 as green levels. */
const GREEN = { 2: "#2fae4a", 3: "#45d865", 4: "#5cff7f" } as const;
/** One of the 16 G2 grey levels (0 = off) as the green the glasses show. */
const greenLevel = (level: number) => `rgb(${Math.round(92 * level / 15)},${Math.round(255 * level / 15)},${Math.round(127 * level / 15)})`;

export interface MirrorLine {
  readonly text: string; readonly x: number; readonly y: number; readonly level: 2 | 3 | 4; readonly highlight?: boolean;
  /** "end": x is the right edge (the right-aligned status). */
  readonly anchor?: "start" | "end";
  /** Width the line takes on the glasses (calibrated G2 font); the phone font is fitted to it. */
  readonly width: number;
}
const lineWidth = (text: string, max: number) => Math.min(max, Math.max(1, hudTextWidth(text)));
export interface MirrorModel {
  readonly view: string;
  readonly tab: ReturnType<typeof tabForHudView>;
  readonly menuOpen: boolean;
  readonly lines: readonly MirrorLine[];
  /** Highlight box of the selected menu item, canvas coordinates. */
  readonly highlight?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly label: string;
  /** v0.10 images to draw: slot ("mascot" | "badge" | "splash") -> image key. */
  readonly images: readonly { readonly slot: keyof typeof HUD_IMAGES; readonly key: string }[];
}

/** Pure layout of the mirror (testable without a DOM). */
export function glassesMirrorModel(mirror: HudMirror): MirrorModel {
  const lines: MirrorLine[] = [];
  const header = HUD_PANELS.header, body = HUD_PANELS.body, caption = HUD_PANELS.caption;
  const baseline = 21; // first baseline below a region's top edge (21 px font in a 27 px line)
  if (mirror.title !== undefined) {
    // v0.10: bright title on the left, dim status ending at the right of its container.
    const title = mirror.title.trim(), status = (mirror.status ?? "").trim(), statusBox = HUD_PANELS.status;
    lines.push({ text: title, x: header.xPosition, y: header.yPosition + baseline, level: 4, width: lineWidth(title, HUD_LINE_WIDTH.header) });
    if (status) lines.push({ text: status, x: statusBox.xPosition + HUD_LINE_WIDTH.status, y: statusBox.yPosition + baseline, level: 2, anchor: "end", width: lineWidth(status, HUD_LINE_WIDTH.status) });
  } else {
    const headerText = mirror.header.split("\n")[0] ?? "";
    lines.push({ text: headerText, x: header.xPosition, y: header.yPosition + baseline, level: 2, width: lineWidth(headerText, HUD_LINE_WIDTH.header) });
  }
  let highlight: MirrorModel["highlight"];
  const bodyLines = (text: string) => text.split("\n").slice(0, body.lines).forEach((line, row) => {
    lines.push({ text: line, x: body.xPosition + body.borderWidth + body.paddingLength, y: body.yPosition + body.borderWidth + body.paddingLength + baseline + row * HUD_LINE_HEIGHT,
      level: 4, width: lineWidth(line, HUD_LINE_WIDTH.body) });
  });
  // v0.11 rail inside the box: mode (bright) on top, then the view list or the MENU list.
  if (mirror.railMode) lines.push({ text: mirror.railMode, x: HUD_PANELS.mode.xPosition, y: HUD_PANELS.mode.yPosition + baseline, level: 4, width: lineWidth(mirror.railMode, HUD_LINE_WIDTH.rail) });
  if (mirror.menuOpen) {
    if (mirror.content !== undefined) bodyLines(mirror.content);
    const items = mirror.body.split("\n").map(item => item.replace(/^(▶ |\s+)/u, ""));
    const selection = Math.max(0, Math.min(items.length - 1, mirror.selection ?? 0));
    const first = Math.max(0, Math.min(selection - (MENU_VISIBLE - 1), items.length - MENU_VISIBLE));
    items.slice(first, first + MENU_VISIBLE + 1).forEach((item, offset) => {
      const index = first + offset;
      const top = HUD_MENU_LIST.yPosition + HUD_MENU_LIST.paddingLength + offset * MENU_PITCH;
      if (top + 30 > HUD_MENU_LIST.yPosition + HUD_MENU_LIST.height) return;
      lines.push({ text: item, x: HUD_MENU_LIST.xPosition + 12, y: top + 28, level: index === selection ? 4 : 3, highlight: index === selection,
        width: lineWidth(item, HUD_MENU_LIST.itemWidth - 20) });
      if (index === selection) highlight = { x: HUD_MENU_LIST.xPosition + 2, y: top + 2, width: HUD_MENU_LIST.width - 4, height: MENU_PITCH - 4 };
    });
  } else {
    bodyLines(mirror.content ?? mirror.body);
    (mirror.railViews ?? "").split("\n").slice(0, HUD_PANELS.views.lines).forEach((text, row) => {
      if (text.trim()) lines.push({ text, x: HUD_PANELS.views.xPosition, y: HUD_PANELS.views.yPosition + baseline + row * HUD_LINE_HEIGHT, level: text.startsWith("▶") ? 4 : 2, width: lineWidth(text, HUD_LINE_WIDTH.rail) });
    });
  }
  mirror.caption.split("\n").slice(0, caption.lines).forEach((text, row) => {
    lines.push({ text, x: caption.xPosition, y: caption.yPosition + baseline + row * HUD_LINE_HEIGHT, level: 3, width: lineWidth(text, HUD_LINE_WIDTH.caption) });
  });
  const label = `Glasses: ${mirror.header}. ${mirror.menuOpen ? "Menu open. " : ""}${mirror.body.replace(/\s+/gu, " ").trim()}`;
  const images = Object.entries(mirror.images ?? {})
    .filter((entry): entry is [keyof typeof HUD_IMAGES, string] => entry[0] in HUD_IMAGES && typeof entry[1] === "string" && !(mirror.menuOpen && entry[0] === "splash"))
    .map(([slot, key]) => ({ slot, key }));
  return { view: mirror.view, tab: tabForHudView(mirror.view), menuOpen: mirror.menuOpen, lines, ...(highlight ? { highlight } : {}), label, images };
}

/** Pixel art of one image key as SVG path markup, one path per grey level (cached). */
const imageMarkup = new Map<string, string>();
export function mirrorImageMarkup(key: string): string {
  const cached = imageMarkup.get(key);
  if (cached !== undefined) return cached;
  const image = renderImage(key), runs = new Map<number, string>();
  for (let y = 0; y < image.height; y++) {
    let x = 0;
    while (x < image.width) {
      const level = Math.round(image.pixels[y * image.width + x]! / 17);
      let end = x + 1;
      while (end < image.width && Math.round(image.pixels[y * image.width + end]! / 17) === level) end++;
      if (level) runs.set(level, `${runs.get(level) ?? ""}M${x} ${y}h${end - x}v1h${x - end}z`);
      x = end;
    }
  }
  const markup = [...runs].map(([level, d]) => `<path fill="${greenLevel(level)}" d="${d}"/>`).join("");
  if (imageMarkup.size > 40) imageMarkup.delete(imageMarkup.keys().next().value!);
  imageMarkup.set(key, markup);
  return markup;
}

/**
 * Renders (or re-renders) the mirror into `container`. Without a mirror it draws an empty, dimmed
 * display. Returns the <svg> element. The <svg> and the pixel-art <g> groups of an earlier call are
 * kept (a group is rebuilt only when its image key or slot changed); only the boxes and text lines
 * are replaced, so a caption or body change does not re-parse the art.
 */
export function renderGlassesMirror(container: HTMLElement, mirror?: HudMirror): SVGSVGElement {
  const document = container.ownerDocument;
  const current = container.firstElementChild;
  const reused = container.childElementCount === 1 && current?.localName === "svg" && current.getAttribute("class") === "glasses-mirror";
  const svg = reused ? current as SVGSVGElement : document.createElementNS(SVG_NS, "svg");
  if (!reused) {
    svg.setAttribute("viewBox", "0 0 576 288");
    svg.setAttribute("class", "glasses-mirror");
    svg.setAttribute("role", "img");
    svg.setAttribute("style", "display:block;width:100%;height:auto;background:#000;border-radius:10px");
  }
  // Image groups already in the svg, by image key + position.
  const groups = new Map<string, Element>();
  if (reused) for (const child of [...svg.children]) {
    const key = child.getAttribute("data-image");
    if (key !== null) groups.set(`${key} ${child.getAttribute("transform")}`, child);
  }
  const nodes: Element[] = [];
  const add = (name: string, attributes: Record<string, string | number>, text?: string) => {
    const element = document.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    if (text !== undefined) element.textContent = text;
    nodes.push(element);
    return element;
  };
  const commit = () => {
    svg.replaceChildren(...nodes);
    if (!reused) container.replaceChildren(svg);
    return svg;
  };
  const flag = (name: string, value: string | undefined) => { if (value === undefined) svg.removeAttribute(name); else svg.setAttribute(name, value); };
  add("rect", { x: 0, y: 0, width: 576, height: 288, rx: 10, fill: "#000" });
  if (!mirror) {
    svg.setAttribute("aria-label", "Glasses display (not connected)");
    flag("data-view", undefined); flag("data-menu", undefined); flag("data-ambient", undefined);
    add("text", { x: 288, y: 150, "text-anchor": "middle", fill: GREEN[2], "font-size": 20, "font-family": "system-ui, sans-serif" }, "glasses not connected");
    return commit();
  }
  const model = glassesMirrorModel(mirror);
  svg.setAttribute("aria-label", model.label);
  flag("data-view", model.view);
  flag("data-menu", String(model.menuOpen));
  flag("data-ambient", mirror.ambient ? "true" : undefined);
  const body = HUD_FRAME;
  // The one BODY box: border width and grey level as on the glasses (2 px, level 9). The ambient page has no box.
  if (!mirror.ambient) add("rect", { x: body.xPosition + body.borderWidth / 2, y: body.yPosition + body.borderWidth / 2, width: body.width - body.borderWidth, height: body.height - body.borderWidth,
    rx: body.borderRadius, fill: "none", stroke: greenLevel(body.borderColor), "stroke-width": body.borderWidth });
  for (const image of model.images) {
    const box = HUD_IMAGES[image.slot];
    // Image containers are opaque on G2: black first, then the art.
    add("rect", { x: box.xPosition, y: box.yPosition, width: box.width, height: box.height, fill: "#000" });
    const transform = `translate(${box.xPosition} ${box.yPosition})`;
    const kept = groups.get(`${image.key} ${transform}`);
    if (kept) { nodes.push(kept); continue; }
    const group = add("g", { transform, "shape-rendering": "crispEdges", "data-image": image.key });
    group.innerHTML = mirrorImageMarkup(image.key);
  }
  if (model.highlight) {
    add("rect", { x: model.highlight.x, y: model.highlight.y, width: model.highlight.width, height: model.highlight.height, rx: 8,
      fill: "none", stroke: GREEN[4], "stroke-width": 2 });
  }
  for (const line of model.lines) {
    if (!line.text.trim()) continue;
    // Fit the phone font to the width the line has on the glasses, so wrapping matches 1:1.
    add("text", { x: line.x, y: line.y, fill: GREEN[line.level], "font-size": 20, "font-family": "system-ui, -apple-system, sans-serif",
      style: "white-space:pre", textLength: line.width, lengthAdjust: "spacingAndGlyphs", ...(line.anchor === "end" ? { "text-anchor": "end" } : {}),
      ...(line.highlight ? { "font-weight": 600 } : {}) }, line.text);
  }
  return commit();
}
