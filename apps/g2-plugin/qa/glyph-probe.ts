import { CreateStartUpPageContainer, TextContainerProperty, waitForEvenAppBridge } from "@evenrealities/even_hub_sdk";
const bridge = await waitForEvenAppBridge();
const sets = ["1 ○ ◇ ■ □ ━ ─ │ ┃ ═ ║", "2 ▁ ▂ ▃ ▄ ▅ ▆ ▇ █ ▌ ▐", "3 ░ ▒ ▓ ★ ☆ ♥ ♡ ◉ ◎ ⬤", "4 ✦ ❯ › ‹ ▪ ▫ ◀ ◁ ▷ △ ▽", "5 ◢ ◣ ◤ ◥ ╭ ╮ ╰ ╯ ┌ ┐ └ ┘", "6 ⌁ ∿ ≈ ≡ ± × ÷ √ ∞ ° • ·", "7 ▸ ► ✓ ✔ ✗ ✘ ⚠ ☰ ♪ ♫ ☀ ☾", "8 ⏵ ⏸ ⏹ ⏺ ⧗ ⌛ ⌚ ⏱ ✉ ☎ ⚙ ⚑", "9 ① ② ③ ¶ § † ‡ ‰ ™ © ® №", "10 ← → ↑ ↓ ↔ ↕ ⇐ ⇒ ⇧ ⇩ ↻ ↺"];
const page = new CreateStartUpPageContainer({ containerTotalNum: 1, textObject: [new TextContainerProperty({ containerID: 1, containerName: "g", xPosition: 0, yPosition: 0, width: 576, height: 288, borderWidth: 0, borderColor: 0, borderRadius: 0, paddingLength: 0, content: sets.join("\n"), isEventCapture: 1 } as never)] } as never);
console.log(`[probe] create ${await bridge.createStartUpPageContainer(page)}`);
