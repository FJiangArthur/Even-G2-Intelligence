import { describe, expect, it } from "vitest";
import { captionTail } from "../src/index.js";

describe("captionTail (continuous captions)", () => {
  it("joins recent finals and the live partial into one flowing caption", () => {
    expect(captionTail(["We should order the boards.", "Lead time is long."], "And the budget", 200)).toBe("We should order the boards. Lead time is long. And the budget");
    expect(captionTail([], "Hello there", 200)).toBe("Hello there");
    expect(captionTail(["Done."], "", 200)).toBe("Done.");
    expect(captionTail(["  spaced \n text  "], "  live  ", 200)).toBe("spaced text live");
  });
  it("keeps only the tail within maxChars, cut at a word boundary with an ellipsis", () => {
    const out = captionTail(["The first sentence is fairly long and old.", "The second one is newer."], "Now live words", 40);
    expect(Array.from(out).length).toBeLessThanOrEqual(40);
    expect(out.startsWith("…")).toBe(true);
    expect(out.endsWith("Now live words")).toBe(true);
    expect(out).not.toMatch(/…\S*[a-z]ewer/u); // no half word right after the ellipsis
    expect(captionTail(["abc"], "", 1)).toBe("…");
    expect(captionTail(["abc"], "", 0)).toBe("");
    expect(captionTail(["abc"], "", Number.NaN)).toBe("");
  });
  it("does not show a partial twice when it repeats the last final, and lets a cumulative partial replace it", () => {
    expect(captionTail(["Order the Jetson boards."], "Order the Jetson boards", 200)).toBe("Order the Jetson boards.");
    expect(captionTail(["Order the Jetson boards."], "Jetson boards", 200)).toBe("Order the Jetson boards.");
    expect(captionTail(["Order the"], "Order the Jetson boards", 200)).toBe("Order the Jetson boards");
    expect(captionTail(["Hi."], "I think so", 200)).toBe("Hi. I think so");
  });
  it("joins CJK without spaces and never splits surrogate pairs", () => {
    expect(captionTail(["我们下周发布。"], "预算是多少", 200)).toBe("我们下周发布。预算是多少");
    const emoji = captionTail(["😀😀😀😀😀"], "", 3);
    expect(Array.from(emoji)).toHaveLength(3);
    expect(emoji).toBe("…😀😀");
  });
  it("tolerates non-array or non-string inputs", () => {
    expect(captionTail(undefined as never, "live", 50)).toBe("live");
    expect(captionTail([1, null, "ok"] as never, undefined as never, 50)).toBe("ok");
  });
});
