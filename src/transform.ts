import { buildScriptModule, parseSvelteSfc, scriptVirtualPath } from "./parse-svelte-sfc";
import type { CliPluginTransformInput, CliPluginTransformResult } from "./types";

export async function transformSvelteSfc(
  input: CliPluginTransformInput,
): Promise<CliPluginTransformResult> {
  const parsed = parseSvelteSfc(input.source, input.path);

  if (parsed.errors.length > 0) {
    // A parse error means the compiler could not build a reliable tree -
    // continuing would silently under-report (or miss entirely) every
    // event in this file. Throwing surfaces it through the host CLI's
    // per-file "skip: <file> <message>" path instead of returning a module
    // that looks like a legitimate zero-event file.
    throw new Error(
      `Failed to parse Svelte SFC ${input.path}: ${parsed.errors.join("; ")}`,
    );
  }

  return {
    modules: [
      {
        path: scriptVirtualPath(input.path),
        content: buildScriptModule(parsed),
      },
    ],
  };
}
