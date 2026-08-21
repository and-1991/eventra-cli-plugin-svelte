import { buildScriptModule, parseSvelteSfc, scriptVirtualPath } from "./parse-svelte-sfc";
import type { CliPluginTransformInput, CliPluginTransformResult } from "./types";

export async function transformSvelteSfc(
  input: CliPluginTransformInput,
): Promise<CliPluginTransformResult> {
  const parsed = parseSvelteSfc(input.source, input.path);

  return {
    modules: [
      {
        path: scriptVirtualPath(input.path),
        content: buildScriptModule(parsed),
      },
    ],
  };
}
