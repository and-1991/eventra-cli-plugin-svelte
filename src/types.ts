/** Input passed to a CLI plugin transform step. */
export interface CliPluginTransformInput {
  readonly path: string;
  readonly source: string;
}

/** Virtual module produced from a source file (e.g. Svelte SFC → `.svelte.ts`). */
export interface CliPluginVirtualModule {
  readonly path: string;
  readonly content: string;
}

/**
 * Declarative sink: match `CallExpression` by callee identifier and read the
 * event name from a string-literal argument. The CLI converts this to its
 * internal sink detector.
 */
export interface CliPluginStaticCalleeSink {
  readonly id: string;
  readonly callee: string;
  readonly eventNameArgumentIndex: number;
}

export interface CliPluginTransformResult {
  readonly modules: readonly CliPluginVirtualModule[];
}

/** Contract for `@eventra_dev/cli-plugin-svelte` and compatible CLI plugins. */
export interface CliPluginSvelte {
  readonly id: string;
  readonly version: string;
  readonly includeGlobs: readonly string[];
  readonly staticSinks?: readonly CliPluginStaticCalleeSink[];
  match(path: string): boolean;
  transform(input: CliPluginTransformInput): Promise<CliPluginTransformResult>;
}
