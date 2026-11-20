/**
 * Original Helix pixel art, drawn from small string bitmaps into inline SVG
 * (shape-rendering="crispEdges"). No external images, fonts or copyrighted
 * characters. Each palette character maps to a CSS class (`px-<char>`) so the
 * stylesheet controls colors for dark and light themes.
 *
 * Bitmap legend (shared by sprites and icons):
 *   .  transparent        k  outline / ink         b  body
 *   d  body shade         g  goggle frame          e  eye glow
 *   w  highlight          m  beak / warm accent    c  chest light
 *   r  alert              f  icon fill (accent)    s  icon soft fill
 */

export type Bitmap = readonly string[];

function runs(rows: Bitmap, ox = 0): Map<string, string> {
  const paths = new Map<string, string>();
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const char = row[x]!;
      if (char === "." || char === " ") { x++; continue; }
      let end = x + 1;
      while (end < row.length && row[end] === char) end++;
      paths.set(char, `${paths.get(char) ?? ""}M${x + ox} ${y}h${end - x}v1h-${end - x}z`);
      x = end;
    }
  });
  return paths;
}

function merge(target: Map<string, string>, source: Map<string, string>): void {
  for (const [char, d] of source) target.set(char, `${target.get(char) ?? ""}${d}`);
}

function svg(width: number, height: number, paths: Map<string, string>, className: string, label?: string): string {
  const a11y = label ? `role="img" aria-label="${label}"` : `aria-hidden="true" focusable="false"`;
  const body = [...paths].map(([char, d]) => `<path class="px-${char}" d="${d}"/>`).join("");
  return `<svg class="${className}" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" shape-rendering="crispEdges" ${a11y}>${body}</svg>`;
}

/** One bitmap as an SVG string. */
export function pixelSvg(rows: Bitmap, className = "px", label?: string): string {
  const width = Math.max(...rows.map(row => row.length));
  return svg(width, rows.length, runs(rows), className, label);
}

/** Frames laid out left-to-right in one SVG; CSS steps() slides the strip. */
export function pixelSheet(frames: readonly Bitmap[], className: string): string {
  const width = Math.max(...frames.flatMap(frame => frame.map(row => row.length)));
  const height = Math.max(...frames.map(frame => frame.length));
  const paths = new Map<string, string>();
  frames.forEach((frame, index) => merge(paths, runs(frame, index * width)));
  return svg(width * frames.length, height, paths, className);
}

/* ---------------------------------------------------------------- mascot */

/** "Hex", the Helix owl-bot: goggle eyes (a nod to the G2 glasses), antenna tufts, chest light. */
const OWL_BASE: Bitmap = [
  "...k........k...",
  "...kk......kk...",
  "..kbbkkkkkkbbk..",
  ".kbbbbbbbbbbbbk.",
  ".kggggbbbbggggk.",
  ".kgwegbbbbgwegk.",
  ".kgeegbbbbgeegk.",
  ".kggggbmmbggggk.",
  "..kbbbbmmbbbbk..",
  "...kkbbbbbbkk...",
  "..kddbbbbbbddk..",
  ".kddbbbccbbbddk.",
  ".kddbbbccbbbddk.",
  "..kdbbbbbbbbdk..",
  "...kkkkkkkkkk...",
  "....mm....mm....",
];

function patch(base: Bitmap, edits: Readonly<Record<number, string>>): Bitmap {
  return base.map((row, index) => edits[index] ?? row);
}

const BLINK = patch(OWL_BASE, { 5: ".kgddgbbbbgddgk.", 6: ".kgkkgbbbbgkkgk." });
const LOOK_LEFT = patch(OWL_BASE, { 5: ".kgwdgbbbbgwdgk.", 6: ".kgedgbbbbgedgk." });
const LOOK_RIGHT = patch(OWL_BASE, { 5: ".kgdegbbbbgdegk.", 6: ".kgdegbbbbgdegk." });
const LOOK_UP = patch(OWL_BASE, { 5: ".kgeegbbbbgeegk.", 6: ".kgddgbbbbgddgk." });
const TIPS_ON = { 0: "...e........e...", 1: "...ke......ek..." };
const SPEAK_OPEN = { 7: ".kggggbkkbggggk.", 8: "..kbbbbmmbbbbk.." };
const ERROR_X = {
  4: ".krggrbbbbrggrk.", 5: ".kgrrgbbbbgrrgk.", 6: ".kgrrgbbbbgrrgk.", 7: ".krggrbmmbrggrk.",
};

export type MascotState = "idle" | "listening" | "thinking" | "speaking" | "error";

export const MASCOT_FRAMES: Readonly<Record<MascotState, readonly Bitmap[]>> = {
  // 11 open frames + 1 blink: a short blink every ~5 s at 0.4 s/frame.
  idle: [...Array.from({ length: 11 }, () => OWL_BASE), BLINK],
  listening: [patch(OWL_BASE, TIPS_ON), patch(OWL_BASE, { ...TIPS_ON, 11: ".kddbbbeebbbddk.", 12: ".kddbbbeebbbddk." })],
  thinking: [
    patch(LOOK_LEFT, { 11: ".kddbbbddbbbddk." }),
    patch(LOOK_UP, {}),
    patch(LOOK_RIGHT, { 11: ".kddbbbddbbbddk." }),
  ],
  speaking: [patch(OWL_BASE, SPEAK_OPEN), OWL_BASE],
  error: [patch(OWL_BASE, ERROR_X), patch(OWL_BASE, { ...ERROR_X, 11: ".kddbbbrrbbbddk.", 12: ".kddbbbrrbbbddk." })],
};

/** All mascot states; CSS shows the one matching [data-mascot]. */
export function mascotMarkup(): string {
  return (Object.keys(MASCOT_FRAMES) as MascotState[]).map(state => {
    const frames = MASCOT_FRAMES[state];
    return `<span class="mascot-frame mascot-${state}" style="--frames:${frames.length}">${pixelSheet(frames, "sprite-strip")}</span>`;
  }).join("");
}

/* ----------------------------------------------------------------- icons */

export const ICONS = {
  mic: [
    "....kkkk....",
    "...kffffk...",
    "...kfwffk...",
    "...kfwffk...",
    "...kffffk...",
    ".k.kffffk.k.",
    ".k..kkkk..k.",
    "..k......k..",
    "...kkkkkk...",
    ".....kk.....",
    "....kkkk....",
    "............",
  ],
  glasses: [
    "............",
    "............",
    "k..........k",
    "kk........kk",
    ".kkkkk.kkkkk",
    ".kfffkkkfffk",
    ".kfwfk.kfwfk",
    ".kfffk.kfffk",
    "..kkk...kkk.",
    "............",
    "............",
    "............",
  ],
  bulb: [
    "....kkkk....",
    "...kffffk...",
    "..kffwwffk..",
    "..kfwfffffk.",
    "..kffffffk..",
    "..kffffffk..",
    "...kffffk...",
    "....kffk....",
    "....kkkk....",
    "....kssk....",
    "....kkkk....",
    "............",
  ],
  magnifier: [
    "..kkkk......",
    ".kffffk.....",
    "kfwwfffk....",
    "kfwffffk....",
    "kffffffk....",
    "kffffffk....",
    ".kffffk.....",
    "..kkkkkk....",
    "......kkk...",
    ".......kkk..",
    "........kkk.",
    ".........kk.",
  ],
  shield: [
    "kkkkkkkkkkk.",
    "kfffffffffk.",
    "kffffffffkk.",
    "kfffffffkfk.",
    "kfkffffkffk.",
    "kffkffkfffk.",
    "kfffkkffffk.",
    ".kffffffffk.",
    ".kffffffk...",
    "..kfffffk...",
    "...kkfkk....",
    ".....k......",
  ],
  scroll: [
    ".kkkkkkkkk..",
    "kwkfffffffk.",
    "kkkskssskfk.",
    "..kfffffffk.",
    "..ksskssskk.",
    "..kfffffffk.",
    "..ksssskkfk.",
    "..kfffffffk.",
    "..kssskssfk.",
    ".kkkkkkkkkkk",
    "kfffffffffwk",
    ".kkkkkkkkkk.",
  ],
  question: [
    ".kkkkkkkkkk.",
    "kffffffffffk",
    "kfffkkkffffk",
    "kffkfffkfffk",
    "kffffffkfffk",
    "kfffffkffffk",
    "kffffkfffffk",
    "kffffffffffk",
    "kffffkfffffk",
    ".kkkkkkkkkk.",
    "..kk........",
    "..k.........",
  ],
  warning: [
    ".....kk.....",
    "....kffk....",
    "....kffk....",
    "...kfkkfk...",
    "...kfkkfk...",
    "..kffkkffk..",
    "..kffkkffk..",
    ".kfffkkfffk.",
    ".kffffffffk.",
    "kffffkkffffk",
    "kffffffffffk",
    "kkkkkkkkkkkk",
  ],
  coin: [
    "...kkkkkk...",
    "..kffffffk..",
    ".kffwkkffsk.",
    "kffwkffkfsfk",
    "kfwfkfffffsk",
    "kfwffkkffsfk",
    "kfwffffkfsfk",
    "kfwfkffkfsfk",
    ".kffwkkffsk.",
    "..kffffffk..",
    "...kkkkkk...",
    "............",
  ],
  hourglass: [
    "kkkkkkkkkkkk",
    ".kwssssssk..",
    ".ksffffffsk.",
    "..ksffffsk..",
    "...ksffsk...",
    "....kffk....",
    "....kssk....",
    "...ksffsk...",
    "..ksffffsk..",
    ".ksffffffsk.",
    ".kffffffffk.",
    "kkkkkkkkkkkk",
  ],
  check: [
    "............",
    "..........kk",
    ".........kfk",
    "........kfk.",
    ".......kfk..",
    "kk....kfk...",
    "kfk..kfk....",
    ".kfkkfk.....",
    "..kffk......",
    "...kk.......",
    "............",
    "............",
  ],
  cross: [
    "............",
    ".kk......kk.",
    ".kfk....kfk.",
    "..kfk..kfk..",
    "...kfkkfk...",
    "....kffk....",
    "....kffk....",
    "...kfkkfk...",
    "..kfk..kfk..",
    ".kfk....kfk.",
    ".kk......kk.",
    "............",
  ],
  gear: [
    ".....kk.....",
    "..k.kffk.k..",
    ".kfkffffkfk.",
    "..kffkkffk..",
    ".kffk..kffk.",
    "kffk....kffk",
    "kffk....kffk",
    ".kffk..kffk.",
    "..kffkkffk..",
    ".kfkffffkfk.",
    "..k.kffk.k..",
    ".....kk.....",
  ],
  clock: [
    "...kkkkkk...",
    "..kffffffk..",
    ".kffffkfffk.",
    "kfffffkffffk",
    "kfffffkffffk",
    "kfffffkkkffk",
    "kffffffffffk",
    "kffffffffffk",
    ".kffffffffk.",
    "..kffffffk..",
    "...kkkkkk...",
    "............",
  ],
  bubble: [
    ".kkkkkkkkkk.",
    "kffffffffffk",
    "kfkkkkkkkffk",
    "kffffffffffk",
    "kfkkkkkffffk",
    "kffffffffffk",
    "kfkkkkkkkffk",
    "kffffffffffk",
    ".kkkkkkkkkk.",
    "...kk.......",
    "...k........",
    "............",
  ],
  play: [
    "..kk........",
    "..kfk.......",
    "..kffk......",
    "..kfffk.....",
    "..kffffk....",
    "..kfffffk...",
    "..kfffffk...",
    "..kffffk....",
    "..kfffk.....",
    "..kffk......",
    "..kfk.......",
    "..kk........",
  ],
  pause: [
    "............",
    ".kkkk..kkkk.",
    ".kffk..kffk.",
    ".kffk..kffk.",
    ".kffk..kffk.",
    ".kffk..kffk.",
    ".kffk..kffk.",
    ".kffk..kffk.",
    ".kffk..kffk.",
    ".kffk..kffk.",
    ".kkkk..kkkk.",
    "............",
  ],
  stop: [
    "............",
    ".kkkkkkkkkk.",
    ".kffffffffk.",
    ".kfwffffffk.",
    ".kffffffffk.",
    ".kffffffffk.",
    ".kffffffffk.",
    ".kffffffffk.",
    ".kffffffffk.",
    ".kffffffffk.",
    ".kkkkkkkkkk.",
    "............",
  ],
  plug: [
    "...k....k...",
    "...k....k...",
    "..kkkkkkkk..",
    ".kffffffffk.",
    ".kfwffffffk.",
    ".kffffffffk.",
    "..kffffffk..",
    "...kffffk...",
    "....kffk....",
    ".....kk.....",
    ".....kk.....",
    ".....kk.....",
  ],
  /* v0.8: People, Knowledge, transfers and knowledge-source badges. */
  people: [
    "............",
    "...kkk......",
    "..kfffk..kk.",
    "..kfwfk.kssk",
    "..kfffk.kssk",
    "...kkk...kk.",
    "..kkkkk.kkkk",
    ".kfffffkkssk",
    ".kfwfffkkssk",
    ".kfffffkkssk",
    ".kfffffkkkkk",
    ".kkkkkkk....",
  ],
  database: [
    "..kkkkkkkk..",
    ".kffffffffk.",
    "kfwffffffffk",
    "kkffffffffkk",
    "kfkkkkkkkkfk",
    "kffffffffffk",
    "kkffffffffkk",
    "kfkkkkkkkkfk",
    "kffffffffffk",
    "kfwffffffffk",
    ".kffffffffk.",
    "..kkkkkkkk..",
  ],
  download: [
    ".....kk.....",
    "....kffk....",
    "....kffk....",
    "....kffk....",
    ".kkkkffkkkk.",
    "..kffffffk..",
    "...kffffk...",
    "....kffk....",
    "k....kk....k",
    "kk........kk",
    "kffffffffffk",
    "kkkkkkkkkkkk",
  ],
  upload: [
    ".....kk.....",
    "....kffk....",
    "...kffffk...",
    "..kffffffk..",
    ".kkkkffkkkk.",
    "....kffk....",
    "....kffk....",
    "....kffk....",
    "k....kk....k",
    "kk........kk",
    "kffffffffffk",
    "kkkkkkkkkkkk",
  ],
  copy: [
    "....kkkkkkkk",
    "....kssssssk",
    "....kssssssk",
    "kkkkkkkksssk",
    "kffffffksssk",
    "kfkkkkfksssk",
    "kffffffksssk",
    "kfkkkkfksssk",
    "kffffffkkkkk",
    "kfkkkffk....",
    "kffffffk....",
    "kkkkkkkk....",
  ],
  send: [
    "............",
    "kk..........",
    "kfkk........",
    "kfffkk......",
    "kfffffkk....",
    "kfwffffffkk.",
    "kfwffffffkk.",
    "kfffffkk....",
    "kfffkk......",
    "kfkk........",
    "kk..........",
    "............",
  ],
  gem: [
    "...kkkkkk...",
    "..kwfksffk..",
    ".kwffkssffk.",
    "kkkkkkkkkkkk",
    ".kfffksfffk.",
    "..kffksffk..",
    "...kfksfk...",
    "....kksk....",
    ".....kk.....",
    "............",
    "............",
    "............",
  ],
  ring: [
    "....kkkk....",
    "..kkffffkk..",
    ".kfwffffffk.",
    ".kwffkkfffk.",
    "kfffk..kfffk",
    "kfffk..kfffk",
    "kfffk..kfffk",
    ".kfffkkfffk.",
    ".kffffffffk.",
    "..kkffffkk..",
    "....kkkk....",
    "............",
  ],
  // v0.10 mode icons (original drawings)
  chip: [
    "..k.k..k.k..",
    ".kkkkkkkkkk.",
    "kkffffffffkk",
    ".kfkkkkkkfk.",
    "kkfkwssskfkk",
    ".kfkssssksk.",
    "kkfkssssskkk",
    ".kfkkkkkkfk.",
    "kkffffffffkk",
    ".kkkkkkkkkk.",
    "..k.k..k.k..",
    "............",
  ],
  clipboard: [
    "....kkkk....",
    ".kkkwffkkkk.",
    "kffkkkkkkffk",
    "kfssssssssfk",
    "kfskkkkkssfk",
    "kfssssssssfk",
    "kfskkkkkkkfk",
    "kfssssssssfk",
    "kfskkkksssfk",
    "kfssssssssfk",
    "kffffffffffk",
    ".kkkkkkkkkk.",
  ],
  heart: [
    "............",
    ".kkk....kkk.",
    "kfwfk..kfffk",
    "kwfffkkffffk",
    "kffffffffffk",
    "kffffffffffk",
    ".kffffffffk.",
    "..kffffffk..",
    "...kffffk...",
    "....kffk....",
    ".....kk.....",
    "............",
  ],
  scale: [
    ".....kk.....",
    ".kkkkffkkkk.",
    ".k...kk...k.",
    "kfk..kk..kfk",
    "kfk..kk..kfk",
    "k.k..kk..k.k",
    "kfffkkkkfffk",
    ".kkk.kk.kkk.",
    ".....kk.....",
    "....kffk....",
    "..kkffffkk..",
    "..kkkkkkkk..",
  ],
  book: [
    "............",
    ".kkkk..kkkk.",
    "kffffkkffffk",
    "kfkkfkkfkkfk",
    "kffffkkffffk",
    "kfkkfkkfkkfk",
    "kffffkkffffk",
    "kfkkfkkfkkfk",
    "kffffkkffffk",
    ".kkkkffkkkk.",
    ".....kk.....",
    "............",
  ],
  moon: [
    "....kkkk....",
    "..kkfffk....",
    ".kffwfk.....",
    ".kffk.......",
    "kfffk.......",
    "kfffk.......",
    "kfffk.....k.",
    ".kfffk...kk.",
    ".kffffkkkfk.",
    "..kkffffkk..",
    "....kkkk....",
    "............",
  ],
} as const satisfies Record<string, Bitmap>;

export type IconName = keyof typeof ICONS;

/** v0.10 icon per conversation mode (phone chips and the glasses header badge). */
export const MODE_ICONS: Readonly<Record<string, IconName>> = Object.freeze({
  general: "people", technical: "chip", interviewer: "clipboard", partner: "heart", negotiation: "scale",
  learning: "book", social: "bubble", passive: "moon", notes: "check", interviewee: "people", "office-discussion": "people",
});
export function modeIcon(mode: string | undefined): IconName { return MODE_ICONS[mode ?? ""] ?? "people"; }

export function icon(name: IconName, className = "icon"): string {
  return pixelSvg(ICONS[name], `${className} icon-${name}`);
}

/* ------------------------------------------------------------- 5x7 font */

const GLYPHS: Readonly<Record<string, string>> = {
  A: "01110 10001 10001 11111 10001 10001 10001",
  B: "11110 10001 10001 11110 10001 10001 11110",
  C: "01111 10000 10000 10000 10000 10000 01111",
  D: "11110 10001 10001 10001 10001 10001 11110",
  E: "11111 10000 10000 11110 10000 10000 11111",
  F: "11111 10000 10000 11110 10000 10000 10000",
  G: "01111 10000 10000 10011 10001 10001 01111",
  H: "10001 10001 10001 11111 10001 10001 10001",
  I: "11111 00100 00100 00100 00100 00100 11111",
  J: "00111 00010 00010 00010 00010 10010 01100",
  K: "10001 10010 10100 11000 10100 10010 10001",
  L: "10000 10000 10000 10000 10000 10000 11111",
  M: "10001 11011 10101 10101 10001 10001 10001",
  N: "10001 11001 10101 10011 10001 10001 10001",
  O: "01110 10001 10001 10001 10001 10001 01110",
  P: "11110 10001 10001 11110 10000 10000 10000",
  Q: "01110 10001 10001 10001 10101 10010 01101",
  R: "11110 10001 10001 11110 10100 10010 10001",
  S: "01111 10000 10000 01110 00001 00001 11110",
  T: "11111 00100 00100 00100 00100 00100 00100",
  U: "10001 10001 10001 10001 10001 10001 01110",
  V: "10001 10001 10001 10001 10001 01010 00100",
  W: "10001 10001 10001 10101 10101 10101 01010",
  X: "10001 10001 01010 00100 01010 10001 10001",
  Y: "10001 10001 01010 00100 00100 00100 00100",
  Z: "11111 00001 00010 00100 01000 10000 11111",
  0: "01110 10001 10011 10101 11001 10001 01110",
  1: "00100 01100 00100 00100 00100 00100 01110",
  2: "01110 10001 00001 00010 00100 01000 11111",
  3: "11110 00001 00001 01110 00001 00001 11110",
  4: "00010 00110 01010 10010 11111 00010 00010",
  5: "11111 10000 11110 00001 00001 10001 01110",
  6: "00110 01000 10000 11110 10001 10001 01110",
  7: "11111 00001 00010 00100 01000 01000 01000",
  8: "01110 10001 10001 01110 10001 10001 01110",
  9: "01110 10001 10001 01111 00001 00010 01100",
  "&": "01100 10010 10100 01000 10101 10010 01101",
  "?": "01110 10001 00001 00010 00100 00000 00100",
  "!": "00100 00100 00100 00100 00100 00000 00100",
  ".": "00000 00000 00000 00000 00000 01100 01100",
  ":": "00000 01100 01100 00000 01100 01100 00000",
  "-": "00000 00000 00000 11111 00000 00000 00000",
  "/": "00001 00010 00010 00100 01000 01000 10000",
  "$": "00100 01111 10100 01110 00101 11110 00100",
  "+": "00000 00100 00100 11111 00100 00100 00000",
  " ": "00000 00000 00000 00000 00000 00000 00000",
};

/** Bitmap for uppercase text in the Helix 5x7 font (1px tracking). */
export function textBitmap(text: string): Bitmap {
  const chars = [...text.toUpperCase()].map(char => (GLYPHS[char] ?? GLYPHS["?"]!).split(" "));
  return Array.from({ length: 7 }, (_, row) =>
    chars.map(glyph => glyph[row]!.replace(/1/g, "k").replace(/0/g, ".")).join("."));
}

/**
 * Pixel-font heading. The SVG is decorative; the visible text is kept in an
 * sr-only span so screen readers and find-in-page still work.
 */
export function pixelText(text: string, className = "pixel-text"): string {
  return `<span class="${className}">${pixelSvg(textBitmap(text), "pixel-glyphs")}<span class="sr-only">${escapeText(text)}</span></span>`;
}

function escapeText(value: string): string {
  return value.replace(/[&<>"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]!));
}
