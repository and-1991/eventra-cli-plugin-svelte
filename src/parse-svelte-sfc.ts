import { parse } from "svelte/compiler";
import { firstContentLine, placeBlocks } from "./layout";

export interface SvelteScriptBlock {
  readonly lang: string;
  readonly module: boolean;
  readonly content: string;
  /** 1-based line of the script's first character in the .svelte file. */
  readonly startLine: number;
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
  /** Raw expressions of inline handlers in the markup (`on:click={() => track("x")}`, `onclick={...}`), copied verbatim. */
  readonly templateHandlers: readonly string[];
  readonly errors: readonly string[];
}

interface SvelteScriptNode {
  readonly start: number;
  readonly context: "default" | "module";
  readonly content: { readonly start: number; readonly end: number };
}

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let i = source.indexOf("\n"); i !== -1 && i < offset; i = source.indexOf("\n", i + 1)) {
    line++;
  }
  return line;
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
  handlers: string[],
): void {
  for (const attribute of attributes as {
    type: string;
    name: string;
    value: unknown;
    expression?: { start: number; end: number } | null;
  }[]) {
    // Svelte 3/4 directive: on:click={handler}. A bare `on:click` (event
    // forwarding) has no expression.
    if (attribute.type === "EventHandler") {
      if (attribute.expression) {
        handlers.push(source.slice(attribute.expression.start, attribute.expression.end).trim());
      }
      continue;
    }
    // Svelte 5 event attribute: onclick={handler}
    if (attribute.type === "Attribute" && /^on[a-z]+$/.test(attribute.name)) {
      const parts = attribute.value;
      if (Array.isArray(parts) && parts.length === 1 && parts[0].type === "MustacheTag") {
        const expr = parts[0].expression as { start: number; end: number };
        handlers.push(source.slice(expr.start, expr.end).trim());
      }
      continue;
    }
    // `use:action={expr}`, `class:name={expr}`, `transition:fn={expr}`, `{...spread}`
    if (CODE_DIRECTIVES.has(attribute.type)) {
      if (attribute.expression) {
        handlers.push(source.slice(attribute.expression.start, attribute.expression.end).trim());
      }
      continue;
    }
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

// directive nodes whose `expression` is plain JS (`bind:` is a variable, `let:` a pattern: not code)
const CODE_DIRECTIVES = new Set(["Action", "Class", "Transition", "Animation", "Spread"]);

// nodes of the markup itself that hold an expression: `{expr}`, `{@html expr}`, `{#if expr}`...
const EXPRESSION_NODES = new Set(["MustacheTag", "RawMustacheTag", "ConstTag", "IfBlock", "EachBlock", "AwaitBlock", "KeyBlock"]);

function collectEventBindings(
  source: string,
  root: unknown,
  out: TemplateEventBinding[],
  handlers: string[],
): void {
  function visit(node: unknown): void {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }

    const record = node as Record<string, unknown>;
    const expression = record.expression as { start?: number; end?: number } | undefined;
    if (
      typeof record.type === "string" &&
      EXPRESSION_NODES.has(record.type) &&
      typeof expression?.start === "number" &&
      typeof expression.end === "number"
    ) {
      handlers.push(source.slice(expression.start, expression.end).trim());
    }
    // `{#each items as item (item.id)}`: the key is an expression of its own
    const key = record.key as { start?: number; end?: number } | undefined;
    if (record.type === "EachBlock" && typeof key?.start === "number" && typeof key.end === "number") {
      handlers.push(source.slice(key.start, key.end).trim());
    }
    if (Array.isArray(record.attributes)) {
      collectFromAttributes(source, record.attributes, out, handlers);
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
      templateHandlers: [],
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
    const raw = source.slice(node.content.start, node.content.end);
    const content = raw.trim();
    if (!content) continue;
    scripts.push({
      lang: scriptLang(source, node),
      module: node.context === "module",
      content,
      startLine: firstContentLine(raw, lineAt(source, node.content.start)),
    });
  }

  const templateEvents: TemplateEventBinding[] = [];
  const templateHandlers: string[] = [];
  collectEventBindings(source, ast.html, templateEvents, templateHandlers);

  // the same expression is reached from its attribute and from its own node: one copy is enough
  return { scripts, templateEvents, templateHandlers: [...new Set(templateHandlers)], errors: [] };
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
    // Only a leading `@ts-nocheck` is honoured by TypeScript, so only the
    // first block decides. Blocks keep their original line numbers.
    const first = parsed.scripts[0];
    const noCheck = first.lang !== "ts" && first.lang !== "tsx";
    parts.push(placeBlocks(parsed.scripts, noCheck ? "// @ts-nocheck" : undefined));
  }

  if (parsed.templateEvents.length > 0 || parsed.templateHandlers.length > 0) {
    const lines = [
      "// --- svelte template (auto-generated) ---",
      `declare function ${TEMPLATE_EVENT_CALLEE}(name: string): void;`,
      "function __eventraSvelteTemplate() {",
      // inline handlers are emitted as plain expression statements, so the
      // calls inside them go through the same detection as script code; the
      // closing paren sits on its own line, so a trailing `// comment` cannot swallow it
      ...parsed.templateHandlers.map((expression) => `  (${expression}\n  );`),
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
