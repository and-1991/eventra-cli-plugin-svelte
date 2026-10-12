/** One script block to place into a generated module. */
export interface PlacedBlock {
  readonly content: string;
  /**
   * 1-based line of the block's first character in the original file, or
   * `undefined` when it has no place there (for example a `src=` script that
   * lives in another file).
   */
  readonly startLine?: number;
}

const newlines = (text: string): number => text.split("\n").length - 1;

/**
 * Concatenate script blocks so every block's first line sits on the same
 * line as in the original file. Dynamic-event reports then point at the line
 * the user wrote instead of a line inside the generated module. When a line is
 * unknown (or already passed) the block is simply separated by a blank line.
 *
 * `leadingDirective` (for example `// @ts-nocheck`) must stay the first
 * thing in the module, so it takes line 1 and the first block starts below it.
 */
export function placeBlocks(blocks: readonly PlacedBlock[], leadingDirective?: string): string {
  let out = "";
  let line = 1;
  const emit = (text: string): void => {
    out += text;
    line += newlines(text);
  };

  blocks.forEach((block, index) => {
    const target = block.startLine;
    if (index === 0) {
      if (leadingDirective) {
        emit(leadingDirective);
        emit("\n".repeat(Math.max((target ?? 2) - line, 1)));
      } else if (target !== undefined) {
        emit("\n".repeat(Math.max(target - line, 0)));
      }
    } else {
      emit("\n".repeat(target !== undefined ? Math.max(target - line, 1) : 2));
    }
    emit(block.content);
  });

  return out;
}

/** Line (1-based) of the first non-blank character of `raw`, given the line `raw` starts on. */
export function firstContentLine(raw: string, rawStartLine: number): number {
  return rawStartLine + newlines(raw.slice(0, raw.length - raw.trimStart().length));
}
