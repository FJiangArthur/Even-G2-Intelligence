import { describe, expect, it } from "vitest";
import { authorizeWebSocket } from "../src/auth.js";

describe("WebSocket subprotocol authentication", () => {
  it("accepts a matching base64url token without returning it", () => {
    const token = "short-lived test token";
    const encoded = Buffer.from(token).toString("base64url");
    expect(authorizeWebSocket({
      "sec-websocket-protocol": `helix.v2, helix-auth.${encoded}`,
    }, token)).toEqual({ accepted: true });
  });

  it("rejects missing protocol and incorrect credentials", () => {
    expect(authorizeWebSocket({}, undefined)).toEqual({ accepted: false, status: 426 });
    expect(authorizeWebSocket({
      "sec-websocket-protocol": `helix.v2, helix-auth.${Buffer.from("wrong").toString("base64url")}`,
    }, "expected")).toEqual({ accepted: false, status: 401 });
  });
});
