import { describe, expect, it } from "vitest";
import { G2ConversationController } from "../src/controller";
import { ConversationPresentation } from "../src/presentation";
import type { GlassesRenderer } from "../src/glasses-renderer";

const bridge = {
  getLocalStorage: async () => "", setLocalStorage: async () => true,
  createStartUpPageContainer: async () => 0, textContainerUpgrade: async () => true,
  audioControl: async () => true, shutDownPageContainer: async () => true, onEvenHubEvent: () => () => undefined,
};

describe("Setup → Test key", () => {
  it("returns the verdict and marks accessible models for Setup", async () => {
    const controller = new G2ConversationController(bridge as never, {} as GlassesRenderer, new ConversationPresentation());
    controller.keyTestFetch = async (url) => url.endsWith("/models")
      ? Response.json({ data: [{ id: "gpt-5.6-terra" }, { id: "gpt-6-luna" }, { id: "gpt-live-transcribe" }] })
      : Response.json({ status: "completed" });
    const seen: string[][] = [];
    controller.subscribeModelAccess(access => seen.push(access.accessible));
    const result = await controller.testKey("sk-test-key", "gpt-6.1-terra");
    expect(result).toMatchObject({ status: "ok", model: "gpt-5.6-terra", realtime: true });
    expect(seen.at(-1)).toEqual(["gpt-5.6-terra", "gpt-6-luna", "gpt-live-transcribe"]);
  });
  it("reports an exhausted project instead of failing silently", async () => {
    const controller = new G2ConversationController(bridge as never, {} as GlassesRenderer, new ConversationPresentation());
    controller.keyTestFetch = async (url) => url.endsWith("/models") ? Response.json({ data: [{ id: "gpt-6.1-terra" }] })
      : new Response(JSON.stringify({ error: { code: "insufficient_quota", message: "You have no credits remaining." } }), { status: 429 });
    expect((await controller.testKey("sk-test-key", "gpt-6.1-terra")).status).toBe("no-credits");
  });
});
