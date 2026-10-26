import type { SvelteScriptBlock } from "./parse-svelte-sfc";

// The structural part of an ESTree node this file reads (svelte/compiler's own types are not exported for it).
export interface EsNode {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly [key: string]: any;
}

/** A script block's statements, with offsets into the whole `.svelte` file and where the trimmed content starts in it. */
export interface ScriptProgram {
  readonly body: readonly EsNode[];
  readonly base: number;
}

export interface ComponentModule {
  /** The instance script with a function header in front of its statements; the closing `}` is the caller's. */
  readonly code: string;
  /** The function's name, which the module exports as its default after the closing brace. */
  readonly name: string;
}

export interface ScriptBindings {
  /** Local names of default imports (`import Button from "./Button.svelte"`): the components a template can use. */
  readonly components: readonly string[];
  readonly declared: ReadonlySet<string>;
}

function patternNames(pattern: EsNode | null, out: Set<string>): void {
  // a hole in an array pattern (`[, b]`) is null
  if (!pattern) return;
  if (pattern.type === "Identifier") out.add(pattern.name);
  else if (pattern.type === "ObjectPattern") for (const property of pattern.properties) patternNames(property.type === "RestElement" ? property.argument : property.value, out);
  else if (pattern.type === "ArrayPattern") for (const element of pattern.elements) patternNames(element, out);
  else if (pattern.type === "AssignmentPattern") patternNames(pattern.left, out);
  // what is left of a binding pattern is a rest element
  else patternNames(pattern.argument, out);
}

/** `export const a = 1` is the declaration it exports; anything else is itself. */
function unexported(statement: EsNode): EsNode {
  return statement.type === "ExportNamedDeclaration" && statement.declaration ? (statement.declaration as EsNode) : statement;
}

/** The names the script blocks make available to the template, and the default imports among them. */
export function scriptBindings(programs: readonly ScriptProgram[]): ScriptBindings {
  const components: string[] = [];
  const declared = new Set<string>();
  for (const program of programs) {
    for (const raw of program.body) {
      const statement = unexported(raw);
      if (statement.type === "VariableDeclaration") for (const declarator of statement.declarations) patternNames(declarator.id, declared);
      else if ((statement.type === "FunctionDeclaration" || statement.type === "ClassDeclaration") && statement.id) declared.add(statement.id.name);
      else if (statement.type === "ImportDeclaration") {
        for (const specifier of statement.specifiers) {
          declared.add(specifier.local.name);
          if (specifier.type === "ImportDefaultSpecifier" && statement.importKind !== "type") components.push(specifier.local.name);
        }
      }
    }
  }
  return { components, declared };
}

const isPropsCall = (node: EsNode | null | undefined): boolean => node?.type === "CallExpression" && node.callee.name === "$props";

/** Same text with every line break kept, so the lines after a removed statement keep their numbers. */
const blank = (text: string): string => text.replace(/[^\n]/g, "");

/**
 * Turns an instance script that declares props into the body of a function taking them, so the code the
 * compiler already follows (a parameter flowing into a track() call) applies to a component:
 *
 *   export let track; export let label = "x";      ->  function Button({ track, label = "x" }) {   (Svelte 4)
 *   let { track, label = "x" } = $props();         ->  function Button({ track, label = "x" }) {   (Svelte 5)
 *   const props = $props();                        ->  function Button(props) {
 *
 * The imports stay above it, as they must; statements keep their line numbers. Returns null when the block
 * declares no props or is written in a way this does not follow (a default export, imports after other code,
 * a rest element next to `export let`), in which case the component is scanned as before.
 */
export function wrapInstanceScript(block: SvelteScriptBlock, program: ScriptProgram, componentName: string): ComponentModule | null {
  if (block.module) return null;
  const rel = (offset: number): number => offset - program.base;
  const text = (node: EsNode): string => block.content.slice(rel(node.start), rel(node.end));

  let firstBody = -1;
  const edits: { start: number; end: number; text: string }[] = [];
  const params: string[] = [];
  let runesParameter: string | null = null;

  for (const [index, statement] of program.body.entries()) {
    if (statement.type === "ImportDeclaration") {
      if (firstBody !== -1) return null;
      continue;
    }
    if (firstBody === -1) firstBody = index;
    if (statement.type === "ExportDefaultDeclaration" || statement.type === "ExportAllDeclaration") return null;

    if (statement.type === "ExportNamedDeclaration") {
      const declaration = statement.declaration as EsNode | null;
      if (!declaration) {
        // `export { a as b }`: no code, and `export` is not allowed inside a function
        edits.push({ start: rel(statement.start), end: rel(statement.end), text: blank(text(statement)) });
      } else if (declaration.kind === "let") {
        // `export let track = "x"`: a prop. Its default value becomes the parameter's.
        for (const declarator of declaration.declarations) {
          if (declarator.id.type !== "Identifier") return null;
          params.push(declarator.init ? `${declarator.id.name} = ${text(declarator.init)}` : declarator.id.name);
        }
        edits.push({ start: rel(statement.start), end: rel(statement.end), text: blank(text(statement)) });
      } else {
        // `export const x` / `export function f`: readonly exports, not props; just the keyword has to go
        edits.push({ start: rel(statement.start), end: rel(declaration.start), text: blank(block.content.slice(rel(statement.start), rel(declaration.start))) });
      }
      continue;
    }

    // `let { track, label = "x" } = $props()` / `const props = $props()`
    if (statement.type === "VariableDeclaration" && statement.declarations.length === 1 && isPropsCall(statement.declarations[0].init) && runesParameter === null) {
      const id = statement.declarations[0].id as EsNode;
      if (id.type === "Identifier") {
        runesParameter = id.name;
      } else if (id.type === "ObjectPattern") {
        const end = id.typeAnnotation ? id.typeAnnotation.start : id.end;
        runesParameter = block.content.slice(rel(id.start), rel(end)).trim();
      } else {
        return null;
      }
      edits.push({ start: rel(statement.start), end: rel(statement.end), text: blank(text(statement)) });
    }
  }

  let parameter: string;
  if (runesParameter !== null) {
    // runes and `export let` are not mixed in one component; if they are, only the runes props are followed
    parameter = runesParameter;
  } else if (params.length > 0) {
    parameter = `{ ${params.join(", ")} }`;
  } else {
    return null;
  }

  const header = `${/\bawait\b/.test(block.content) ? "async " : ""}function ${componentName}(${parameter}: any) {`;

  // last edit first, so the offsets of the ones before it still hold
  let code = block.content;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
  }
  // the header goes in front of the first statement, which no edit starts before
  const headerAt = rel(program.body[firstBody].start);
  code = code.slice(0, headerAt) + header + code.slice(headerAt);
  return { code, name: componentName };
}
