import { parse } from "svelte/compiler";

export interface SvelteScriptBlock {
  readonly lang: string;
  readonly module: boolean;
  readonly content: string;
}

/** A single `event="..."` binding found on a tag in the template. */
export interface TemplateEventBinding {
  /** `literal`: the event name is a string constant. `dynamic`: a raw JS/TS expression, copied verbatim. */
  readonly kind: "literal" | "dynamic";
  readonly value: string;
}

export interface ParsedSvelteSfc {
  readonly scripts: readonly SvelteScriptBlock[];
  readonly templateEvents: readonly TemplateEventBinding[];
  readonly errors: readonly string[];
}

interface SvelteScriptNode {
  readonly start: number;
  readonly context: "default" | "module";
  readonly content: { readonly start: number; readonly end: number };
}

const LANG_RE = /\blang\s*=\s*["']([^"']+)["']/;

function scriptLang(source: string, node: SvelteScriptNode): string {
  const openTag = source.slice(node.start, node.content.start);
  return (openTag.match(LANG_RE)?.[1] ?? "js").toLowerCase();
}

/**
 * Every attribute-bearing template node (`Element`, `InlineComponent`,
 * `SlotTemplate`, `svelte:window`/`svelte:head`/etc) carries an `attributes`
 * array, regardless of its `type` — duck-typing on that shape (rather than an
 * explicit list of node type names) means new block/tag kinds a future Svelte
 * version adds are picked up automatically.
 */
function collectFromAttributes(
  source: string,
  attributes: readonly unknown[],
  out: TemplateEventBinding[],
): void {
  for (const attribute of attributes as { type: string; name: string; value: unknown }[]) {
    if (attribute.type !== "Attribute" || attribute.name !== "event") continue;

    const value = attribute.value;
    // Boolean shorthand (`event`) or an interpolated/mixed value
    // (`event="a-{b}"`) isn't a single literal or single expression — the
    // plugin's convention only supports one or the other, so it's skipped.
    if (!Array.isArray(value) || value.length !== 1) continue;

    const part = value[0] as { type: string; data: string; expression: { start: number; end: number } };
    if (part.type === "Text") {
      const literal = part.data.trim();
      if (literal) {
        out.push({ kind: "literal", value: literal });
      }
    } else {
      // A single-element attribute value array only ever contains a `Text` or
      // `MustacheTag` node per Svelte's attribute-value grammar — there is no
      // third case to fall through to.
      /* v8 ignore else */
      if (part.type === "MustacheTag") {
        out.push({
          kind: "dynamic",
          value: source.slice(part.expression.start, part.expression.end).trim(),
        });
      }
    }
  }
}

function collectEventBindings(source: string, root: unknown, out: TemplateEventBinding[]): void {
  function visit(node: unknown): void {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }

    const record = node as Record<string, unknown>;
    if (Array.isArray(record.attributes)) {
      collectFromAttributes(source, record.attributes, out);
    }
    for (const key of Object.keys(record)) {
      visit(record[key]);
    }
  }

  visit(root);
}

/** Parse a Svelte SFC via the real `svelte/compiler` parser (handles comments, control-flow blocks, malformed markup, etc). */
export function parseSvelteSfc(source: string, filePath: string): ParsedSvelteSfc {
  let ast: {
    html: unknown;
    instance?: SvelteScriptNode;
    module?: SvelteScriptNode;
  };
  try {
    ast = parse(source, { filename: filePath, modern: false }) as typeof ast;
  } catch (error) {
    return {
      scripts: [],
      templateEvents: [],
      // svelte/compiler's parse() only ever throws Error instances (its
      // CompileError subclasses Error) — the String(error) fallback can't be
      // reached without hand-crafting a `throw "non-error value"` inside the
      // compiler itself. Defensive-only.
      /* v8 ignore next */
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }

  const scripts: SvelteScriptBlock[] = [];
  // `context="module"` code runs once when the module first evaluates —
  // before any component instance exists — so it's placed first regardless
  // of which block appears earlier in the source text.
  for (const node of [ast.module, ast.instance]) {
    if (!node) continue;
    const content = source.slice(node.content.start, node.content.end).trim();
    if (!content) continue;
    scripts.push({
      lang: scriptLang(source, node),
      module: node.context === "module",
      content,
    });
  }

  const templateEvents: TemplateEventBinding[] = [];
  collectEventBindings(source, ast.html, templateEvents);

  return { scripts, templateEvents, errors: [] };
}

/** Map `App.svelte` → `App.svelte.ts` (single virtual TS module for the compiler). */
export function scriptVirtualPath(sveltePath: string): string {
  return sveltePath.replace(/\.svelte$/i, ".svelte.ts");
}

const TEMPLATE_EVENT_CALLEE = "__eventra_svelte_template_event__";

/**
 * Build one virtual TS module from the parsed SFC: `context="module"` script,
 * then the instance `<script>`, followed by a function wrapping synthetic
 * calls for every template `event="..."` binding. Because everything shares
 * one module scope, a dynamic binding (`event={expr}`) that references a real
 * top-level script identifier resolves through the same checker-based
 * pipeline as any other TS expression; anything that doesn't resolve (e.g. an
 * `{#each}` loop variable) is correctly reported as a dynamic occurrence
 * rather than silently dropped.
 */
export function buildScriptModule(parsed: ParsedSvelteSfc): string {
  const parts: string[] = [];

  if (parsed.scripts.length === 0) {
    parts.push("export {}");
  } else {
    for (const block of parsed.scripts) {
      const header = [`// --- svelte script${block.module ? " context=module" : ""} ---`];
      if (block.lang !== "ts" && block.lang !== "tsx") {
        header.push("// @ts-nocheck");
      }
      parts.push([...header, block.content].join("\n"));
    }
  }

  if (parsed.templateEvents.length > 0) {
    const lines = [
      "// --- svelte template (auto-generated) ---",
      `declare function ${TEMPLATE_EVENT_CALLEE}(name: string): void;`,
      "function __eventraSvelteTemplate() {",
      ...parsed.templateEvents.map((binding) =>
        binding.kind === "literal"
          ? `  ${TEMPLATE_EVENT_CALLEE}("${escapeString(binding.value)}");`
          : `  ${TEMPLATE_EVENT_CALLEE}(${binding.value});`,
      ),
      "}",
    ];
    parts.push(lines.join("\n"));
  }

  return `${parts.join("\n\n")}\n`;
}

function escapeString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
