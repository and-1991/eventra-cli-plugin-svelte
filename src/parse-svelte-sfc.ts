import { parse } from "svelte/compiler";
import path from "node:path";

import { scriptBindings, wrapInstanceScript } from "./component";
import type { ScriptProgram } from "./component";
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

/** A prop passed to a child component in the template: `track="x"` (literal), `track={expr}` / `{track}` (expression). */
export interface TemplateComponentProp {
  readonly name: string;
  /** `spread`: `{...obj}`, whose properties are props in the place it stands among the others (`name` is empty). */
  readonly kind: "literal" | "expression" | "spread";
  readonly value: string;
}

/** A component element with the props written on it. Whether it is an imported component depends on the script's imports. */
export interface TemplateComponentUsage {
  readonly tag: string;
  readonly props: readonly TemplateComponentProp[];
}

export interface ParsedSvelteSfc {
  readonly scripts: readonly SvelteScriptBlock[];
  readonly templateEvents: readonly TemplateEventBinding[];
  /** Raw expressions of inline handlers in the markup (`on:click={() => track("x")}`, `onclick={...}`), copied verbatim. */
  readonly templateHandlers: readonly string[];
  /** Every component element in the template that carries props, for the ones that turn out to be imported components. */
  readonly componentUsages?: readonly TemplateComponentUsage[];
  readonly errors: readonly string[];
}

interface SvelteScriptNode {
  readonly start: number;
  readonly context: "default" | "module";
  readonly content: { readonly start: number; readonly end: number; readonly body: ScriptProgram["body"] };
}

// The statements of each script block, kept beside the parse result instead of in it, for the step that
// turns a component's props into a function's parameters.
const programs = new WeakMap<SvelteScriptBlock, ScriptProgram>();

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let i = source.indexOf("\n"); i !== -1 && i < offset; i = source.indexOf("\n", i + 1)) {
    line++;
  }
  return line;
}

// Svelte rejects whitespace before the `=`; the leading \s keeps `data-lang="..."` from counting
const LANG_RE = /\slang=\s*["']([^"']+)["']/;

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
        handlers.push(source.slice(attribute.expression.start, attribute.expression.end));
      }
      continue;
    }
    // Svelte 5 event attribute: onclick={handler}. The expression is also reached through its own
    // MustacheTag, but reading it here keeps it ahead of the other attributes' expressions.
    if (attribute.type === "Attribute" && /^on[a-z]+$/.test(attribute.name)) {
      const parts = attribute.value;
      if (Array.isArray(parts) && parts.length === 1 && parts[0].type === "MustacheTag") {
        const expr = parts[0].expression as { start: number; end: number };
        handlers.push(source.slice(expr.start, expr.end));
      }
      continue;
    }
    // `use:action={expr}`, `class:name={expr}`, `transition:fn={expr}`, `{...spread}`
    if (CODE_DIRECTIVES.has(attribute.type)) {
      if (attribute.expression) {
        handlers.push(source.slice(attribute.expression.start, attribute.expression.end));
      }
      continue;
    }
    if (attribute.type !== "Attribute" || attribute.name !== "event") continue;

    const value = attribute.value;
    // The boolean shorthand (`event`) has no value at all, so there is no name to read
    if (!Array.isArray(value) || value.length === 0) continue;

    const parts = value as { type: string; data: string; expression: { start: number; end: number } }[];
    if (parts.length === 1 && parts[0].type === "Text") {
      const literal = parts[0].data.trim();
      if (literal) {
        out.push({ kind: "literal", value: literal });
      }
      continue;
    }
    // `event={expr}` and the shorthand `{event}` (which is `event={event}`) are a single expression
    if (parts.length === 1) {
      /* v8 ignore else */
      if (parts[0].type === "MustacheTag" || parts[0].type === "AttributeShorthand") {
        out.push({ kind: "dynamic", value: source.slice(parts[0].expression.start, parts[0].expression.end) });
      }
      continue;
    }
    // `event="a-{b}"`: text and expressions mixed, read as the template literal it is. When every
    // expression resolves, the name is found; when not, it is reported as dynamic, not dropped
    const template = parts
      .map((part) =>
        part.type === "Text"
          ? part.data.replace(/[\\`]|\$\{/g, (match) => `\\${match}`)
          : `\${${source.slice(part.expression.start, part.expression.end)}}`,
      )
      .join("");
    out.push({ kind: "dynamic", value: `\`${template}\`` });
  }
}

// directive nodes whose `expression` is plain JS (`bind:` is a variable, `let:` a pattern: not code)
const CODE_DIRECTIVES = new Set(["Action", "Class", "Transition", "Animation", "Spread"]);

// nodes of the markup itself that hold an expression: `{expr}`, `{@html expr}`, `{#if expr}`...
const EXPRESSION_NODES = new Set(["MustacheTag", "RawMustacheTag", "ConstTag", "IfBlock", "EachBlock", "AwaitBlock", "KeyBlock", "AttachTag", "RenderTag"]);

/** `<Button track="x" label={y} {shorthand} />`: the props written on a component element, and `{...obj}` spreads in their place; directives and mixed text and `{}` values are not props this can read. */
function collectComponentProps(source: string, tag: string, attributes: readonly unknown[], usages: TemplateComponentUsage[]): void {
  const props: TemplateComponentProp[] = [];
  for (const attribute of attributes as { type: string; name: string; value: unknown; expression?: { start: number; end: number } }[]) {
    if (attribute.type === "Spread" && attribute.expression) {
      props.push({ name: "", kind: "spread", value: source.slice(attribute.expression.start, attribute.expression.end) });
      continue;
    }
    if (attribute.type !== "Attribute" || !Array.isArray(attribute.value) || attribute.value.length !== 1) continue;
    // a one-part value is Text, a MustacheTag (`x={expr}`) or an AttributeShorthand (`{x}`); the last two carry an expression
    const part = attribute.value[0] as { type: string; data: string; expression: { start: number; end: number } };
    props.push(
      part.type === "Text"
        ? { name: attribute.name, kind: "literal", value: part.data }
        : { name: attribute.name, kind: "expression", value: source.slice(part.expression.start, part.expression.end) },
    );
  }
  if (props.length > 0) usages.push({ tag, props });
}

function collectEventBindings(
  source: string,
  root: unknown,
  out: TemplateEventBinding[],
  handlers: string[],
  usages: TemplateComponentUsage[],
): void {
  function visit(node: unknown): void {
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const expression = record.expression as { start?: number; end?: number } | undefined;
    if (
      typeof record.type === "string" &&
      EXPRESSION_NODES.has(record.type) &&
      typeof expression?.start === "number" &&
      typeof expression.end === "number"
    ) {
      handlers.push(source.slice(expression.start, expression.end));
    }
    // `{#each items as item (item.id)}`: the key is an expression of its own
    const key = record.key as { start?: number; end?: number } | undefined;
    if (record.type === "EachBlock" && typeof key?.start === "number" && typeof key.end === "number") {
      handlers.push(source.slice(key.start, key.end));
    }
    // `{#snippet row(item = track("x"))}`: a default value in a parameter is code that runs
    if (record.type === "SnippetBlock" && Array.isArray(record.parameters)) {
      for (const parameter of record.parameters as { type: string; right?: { start?: number; end?: number } }[]) {
        const value = parameter.right;
        if (parameter.type === "AssignmentPattern" && typeof value?.start === "number" && typeof value.end === "number") {
          handlers.push(source.slice(value.start, value.end));
        }
      }
    }
    if (Array.isArray(record.attributes)) {
      collectFromAttributes(source, record.attributes, out, handlers);
      if (record.type === "InlineComponent" && typeof record.name === "string") {
        collectComponentProps(source, record.name, record.attributes, usages);
      }
    }
    for (const key of Object.keys(record)) {
      visit(record[key]);
    }
  }

  visit(root);
}

/** The compiler's message with the line it points at: without it a broken script only says the file is broken. */
export function describeParseError(error: unknown): string {
  // parse() only throws Error instances (its CompileError subclasses Error)
  const { message, start } = error as { message: string; start?: { line?: number } };
  return start?.line !== undefined && !/\bline \d+\b/.test(message) ? `${message} (line ${start.line})` : message;
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
      errors: [describeParseError(error)],
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
    const block: SvelteScriptBlock = {
      lang: scriptLang(source, node),
      module: node.context === "module",
      content,
      startLine: firstContentLine(raw, lineAt(source, node.content.start)),
    };
    scripts.push(block);
    programs.set(block, { body: node.content.body, base: node.content.start + (raw.length - raw.trimStart().length) });
  }

  const templateEvents: TemplateEventBinding[] = [];
  const templateHandlers: string[] = [];
  const componentUsages: TemplateComponentUsage[] = [];
  collectEventBindings(source, ast.html, templateEvents, templateHandlers, componentUsages);

  // the same expression is reached from its attribute and from its own node: one copy is enough
  return { scripts, templateEvents, templateHandlers: [...new Set(templateHandlers)], componentUsages, errors: [] };
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
 *
 * A component that declares props (`export let`, `$props()`) is also exported as a function of them, and
 * every use of it in another template becomes a call of that function. The prop that reaches a tracking
 * call is then found by what the component does with it, whatever the prop is called.
 */
export function buildScriptModule(parsed: ParsedSvelteSfc, filePath = ""): string {
  const parts: string[] = [];
  const blockPrograms = parsed.scripts.flatMap((block) => {
    const program = programs.get(block);
    return program ? [program] : [];
  });
  const bindings = scriptBindings(blockPrograms);

  let scripts = parsed.scripts;
  let component: string | undefined;
  // the instance script comes last, and the function it opens stays open to the end of the module
  const last = parsed.scripts[parsed.scripts.length - 1];
  const lastProgram = last && programs.get(last);
  if (last && lastProgram) {
    const wrapped = wrapInstanceScript(last, lastProgram, componentName(filePath, bindings.declared));
    if (wrapped) {
      scripts = [...parsed.scripts.slice(0, -1), { ...last, content: wrapped.code }];
      component = wrapped.name;
    }
  }

  if (scripts.length === 0) {
    parts.push("export {}");
  } else {
    // Only a leading `@ts-nocheck` is honoured by TypeScript, so only the
    // first block decides. Blocks keep their original line numbers.
    const first = scripts[0];
    const noCheck = first.lang !== "ts" && first.lang !== "tsx";
    parts.push(placeBlocks(scripts, noCheck ? "// @ts-nocheck" : undefined));
  }

  const usages = componentCalls(parsed.componentUsages ?? [], bindings.components);
  if (parsed.templateEvents.length > 0 || parsed.templateHandlers.length > 0 || usages.length > 0) {
    const marker = "// --- svelte template (auto-generated) ---";
    const body = [
      // inline handlers are emitted as plain expression statements, so the
      // calls inside them go through the same detection as script code; the
      // closing paren sits on its own line, so a trailing `// comment` cannot swallow it
      ...parsed.templateHandlers.map((expression) => `  (${expression}\n  );`),
      ...usages,
      ...parsed.templateEvents.map((binding) =>
        binding.kind === "literal"
          ? `  ${TEMPLATE_EVENT_CALLEE}("${escapeString(binding.value)}");`
          : `  ${TEMPLATE_EVENT_CALLEE}(${binding.value});`,
      ),
    ];
    const declaration = `declare function ${TEMPLATE_EVENT_CALLEE}(name: string): void;`;
    if (component) {
      // inside the component function, where its props and script variables are in scope
      parts[0] = `${parts[0]}\n${[marker, ...body].join("\n")}\n// --- end template ---\n}\nexport default ${component};`;
      parts.push(declaration);
    } else {
      parts.push([marker, declaration, "function __eventraSvelteTemplate() {", ...body, "}"].join("\n"));
    }
  } else if (component) {
    parts[0] = `${parts[0]}\n}\nexport default ${component};`;
  }

  return `${parts.join("\n\n")}\n`;
}

/** `Button.svelte` -> `Button`: the name the component is reported under, kept clear of the script's own names. */
function componentName(filePath: string, taken: ReadonlySet<string>): string {
  const base = path.basename(filePath).replace(/\.svelte$/i, "");
  const name = base.replace(/(?:^|[^A-Za-z0-9]+)(\w)/g, (_, letter: string) => letter.toUpperCase()).replace(/[^\w$]/g, "");
  const valid = /^[A-Za-z_$][\w$]*$/.test(name) ? name : "SvelteComponent";
  return taken.has(valid) ? `${valid}Component` : valid;
}

const KEY = /^[A-Za-z_$][\w$]*$/;

/**
 * A use of an imported component in the template is a call of that component with its props object:
 * `<Button track="x" label={text} />` is `Button({ track: "x", label: (text) })`.
 */
function componentCalls(usages: readonly TemplateComponentUsage[], components: readonly string[]): string[] {
  const calls: string[] = [];
  for (const usage of usages) {
    if (!components.includes(usage.tag)) continue;
    const props = usage.props.map((prop) => {
      if (prop.kind === "spread") return `...(${prop.value}\n)`;
      const key = KEY.test(prop.name) ? prop.name : `"${escapeString(prop.name)}"`;
      return `${key}: ${prop.kind === "literal" ? `"${escapeString(prop.value)}"` : `(${prop.value}\n)`}`;
    });
    calls.push(`  ${usage.tag}({ ${props.join(", ")} });`);
  }
  return calls;
}

function escapeString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
