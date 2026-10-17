import { describe, expect, it } from "vitest";

import { firstContentLine, placeBlocks } from "../src/layout";

// placeBlocks keeps every block on the line it had in the original file; these pin that arithmetic exactly.
const lineOf = (text: string, needle: string): number => text.slice(0, text.indexOf(needle)).split("\n").length;

describe("placeBlocks", () => {
  it("is empty for no blocks, even with a directive", () => {
    expect(placeBlocks([])).toBe("");
    expect(placeBlocks([], "// @ts-nocheck")).toBe("");
  });

  it("puts a first block on its own line by padding with blank lines", () => {
    expect(placeBlocks([{ content: "a", startLine: 1 }])).toBe("a");
    expect(placeBlocks([{ content: "a", startLine: 4 }])).toBe("\n\n\na");
  });

  it("does not pad a first block with no line", () => {
    expect(placeBlocks([{ content: "a" }])).toBe("a");
  });

  it("puts the directive on line 1 and the first block on its line, or right below when it is earlier", () => {
    expect(placeBlocks([{ content: "a", startLine: 5 }], "// @ts-nocheck")).toBe("// @ts-nocheck\n\n\n\na");
    expect(placeBlocks([{ content: "a", startLine: 2 }], "// @ts-nocheck")).toBe("// @ts-nocheck\na");
    expect(placeBlocks([{ content: "a", startLine: 1 }], "// @ts-nocheck")).toBe("// @ts-nocheck\na");
  });

  it("puts a first block with no line on line 2, right below a directive", () => {
    expect(placeBlocks([{ content: "a" }], "// @ts-nocheck")).toBe("// @ts-nocheck\na");
  });

  it("counts the lines of earlier blocks, so a later block lands on its own line", () => {
    const text = placeBlocks([
      { content: "a\nb\nc", startLine: 1 },
      { content: "X", startLine: 9 },
    ]);
    expect(text).toBe("a\nb\nc\n\n\n\n\n\nX");
    expect(lineOf(text, "X")).toBe(9);
  });

  it("counts the directive and the padding too", () => {
    const text = placeBlocks(
      [
        { content: "a\nb", startLine: 4 },
        { content: "X", startLine: 10 },
      ],
      "// @ts-nocheck",
    );
    expect(lineOf(text, "a")).toBe(4);
    expect(lineOf(text, "X")).toBe(10);
  });

  it("separates a later block by one blank line when its line has passed, and by two when it has none", () => {
    expect(
      placeBlocks([
        { content: "a\nb\nc", startLine: 1 },
        { content: "X", startLine: 2 },
      ]),
    ).toBe("a\nb\nc\nX");
    expect(placeBlocks([{ content: "a", startLine: 1 }, { content: "X" }])).toBe("a\n\nX");
    expect(
      placeBlocks([
        { content: "a", startLine: 1 },
        { content: "X", startLine: 2 },
      ]),
    ).toBe("a\nX");
  });

  it("places three blocks in order", () => {
    const text = placeBlocks([
      { content: "a", startLine: 1 },
      { content: "b", startLine: 3 },
      { content: "c", startLine: 6 },
    ]);
    expect([lineOf(text, "a"), lineOf(text, "b"), lineOf(text, "c")]).toEqual([1, 3, 6]);
  });
});

describe("firstContentLine", () => {
  it("is the start line when the text starts with content", () => {
    expect(firstContentLine("a\nb", 7)).toBe(7);
  });

  it("skips leading blank lines and whitespace", () => {
    expect(firstContentLine("\n\n  a", 3)).toBe(5);
    expect(firstContentLine("  \n \t\nb", 1)).toBe(3);
  });

  it("does not count blank lines after the first content", () => {
    expect(firstContentLine("a\n\n\nb", 2)).toBe(2);
  });
});
