import { transformSvelteSfc } from "./transform";
import type { CliPluginSvelte } from "./types";

export function createCliPluginSvelte(): CliPluginSvelte {
  return {
    id: "svelte",
    version: "1.0.1",
    includeGlobs: ["**/*.svelte"],
    staticSinks: [
      {
        id: "svelte-template-event",
        callee: "__eventra_svelte_template_event__",
        eventNameArgumentIndex: 0,
      },
    ],
    match: (path) => path.endsWith(".svelte"),
    transform: transformSvelteSfc,
  };
}

export default createCliPluginSvelte();

export { transformSvelteSfc } from "./transform";
export { buildScriptModule, parseSvelteSfc, scriptVirtualPath } from "./parse-svelte-sfc";
export type {
  CliPluginStaticCalleeSink,
  CliPluginSvelte,
  CliPluginTransformInput,
  CliPluginTransformResult,
  CliPluginVirtualModule,
} from "./types";
export type { ParsedSvelteSfc, SvelteScriptBlock, TemplateEventBinding } from "./parse-svelte-sfc";
