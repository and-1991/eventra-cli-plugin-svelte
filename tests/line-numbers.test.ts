import { describe, expect, it } from "vitest";

import { firstContentLine, placeBlocks } from "../src/layout";
import { buildScriptModule, parseSvelteSfc } from "../src/parse-svelte-sfc";

const lineOf = (text: string, needle: string): number =>
  text.split("\n").findIndex((l) => l.includes(needle)) + 1;

describe("svelte script module keeps original line numbers", () => {
  it("puts every script line on the line it has in the .svelte file", () => {
    const source = `<button event={name}>Pay</button>

<script lang="ts">
  import { Eventra } from "@eventra_dev/eventra-sdk";
  const name = "x";
  const sdk = new Eventra({ apiKey: "k" });
  sdk.track(name);
</script>
`;
    const module = buildScriptModule(parseSvelteSfc(source, "/p/A.svelte"));

    for (const needle of ["import { Eventra }", 'const name = "x"', "sdk.track(name)"]) {
      expect(lineOf(module, needle)).toBe(lineOf(source, needle));
    }
  });

  it("keeps a non-ts script on its line with the directive on line 1", () => {
    const source = "<h1>x</h1>\n\n\n<script>\nfoo();\n</script>\n";
    const module = buildScriptModule(parseSvelteSfc(source, "/p/B.svelte"));

    expect(module.split("\n")[0]).toBe("// @ts-nocheck");
    expect(lineOf(module, "foo()")).toBe(lineOf(source, "foo()"));
  });

  it("keeps a context=module block and the instance block on their lines", () => {
    const source = `<script context="module" lang="ts">
export const a = 1;
</script>

<script lang="ts">
const b = 2;
</script>
`;
    const module = buildScriptModule(parseSvelteSfc(source, "/p/C.svelte"));

    expect(lineOf(module, "export const a")).toBe(2);
    expect(lineOf(module, "const b = 2")).toBe(6);
  });
});

describe("placeBlocks", () => {
  it("separates blocks by a blank line when a line is unknown", () => {
    expect(placeBlocks([{ content: "a();" }, { content: "b();" }])).toBe("a();\n\nb();");
  });

  it("keeps the directive on line 1 and starts an unplaced block right below it", () => {
    expect(placeBlocks([{ content: "a();" }], "// @ts-nocheck")).toBe("// @ts-nocheck\na();");
  });

  it("never moves a later block above the end of the previous one", () => {
    const out = placeBlocks([{ content: "a();\nb();", startLine: 1 }, { content: "c();", startLine: 1 }]);

    expect(out).toBe("a();\nb();\nc();");
  });

  it("counts the leading blank lines of a block", () => {
    expect(firstContentLine("\n\n  x", 3)).toBe(5);
    expect(firstContentLine("x", 3)).toBe(3);
  });
});
