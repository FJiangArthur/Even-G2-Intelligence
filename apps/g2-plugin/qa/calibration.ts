import { CreateStartUpPageContainer, TextContainerProperty, TextContainerUpgrade, waitForEvenAppBridge } from "@evenrealities/even_hub_sdk";
const bridge = await waitForEvenAppBridge();
const sentence = "Alice owns the launch checklist. We agreed to launch on Friday after confirming the release criteria, resolving the remaining risks, and assigning clear owners for each action. ";
const text = new URLSearchParams(location.search).has("cjk")
  ? "团队决定周五发布产品。请先确认负责人和验收标准，再检查所有依赖是否已经完成。如果还有阻碍，请明确提出下一步行动，确保讨论形成可执行的决定。".repeat(4)
  : sentence.repeat(4);
const result = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({ containerTotalNum: 1, textObject: [new TextContainerProperty({ containerID: 1, containerName: "calibration", xPosition: 4, yPosition: 4, width: 568, height: 280, content: text, paddingLength: 0, borderWidth: 0, textColor: 4, isEventCapture: 1 })] }));
console.info("CALIBRATION", JSON.stringify({ result, characters: text.length, text }));
bridge.onEvenHubEvent(event => { if (event.sysEvent || event.textEvent) void bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 1, containerName: "calibration", content: "" })); });
