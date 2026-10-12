import { describe, expect, it } from "vitest";

import { transformSvelteSfc } from "../src/transform";

describe("transformSvelteSfc", () => {
  it("returns a single virtual module for a file with no errors and no events", async () => {
    const result = await transformSvelteSfc({ path: "/project/Plain.svelte", source: "<div>hi</div>" });

    expect(result.modules).toHaveLength(1);
    expect(result.modules[0]?.path).toBe("/project/Plain.svelte.ts");
  });

  it("throws (rather than silently returning an empty module) when the Svelte parser reports an error", async () => {
    await expect(
      transformSvelteSfc({ path: "/project/Broken.svelte", source: "<button event=" }),
    ).rejects.toThrow(/Failed to parse Svelte SFC .*Broken\.svelte/);
  });
});
