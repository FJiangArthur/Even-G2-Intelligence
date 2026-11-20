export const SHORTCUT_ACTIONS = [
  { itemID: 1, itemName: "Explain term" },
  { itemID: 2, itemName: "Local answer" },
  { itemID: 3, itemName: "Global answer" },
  { itemID: 4, itemName: "Dismiss cue" },
  { itemID: 5, itemName: "Pause / resume" },
] as const;
export type ShortcutActionId = typeof SHORTCUT_ACTIONS[number]["itemID"];
