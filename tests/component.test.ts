import { describe, expect, it } from "vitest";

import { buildScriptModule, parseSvelteSfc } from "../src/parse-svelte-sfc";

function module(source: string, filePath = "/p/Button.svelte"): string {
  return buildScriptModule(parseSvelteSfc(source, filePath), filePath);
}

describe("buildScriptModule with props", () => {
  it("turns `export let` props into the parameters of a function, defaults included", () => {
    const text = module(`<script lang="ts">
  import x from "x";
  export let track: string;
  export let label = "a", other;
  function go() { x(track); }
</script>
<button on:click={go}>{label}</button>`);
    expect(text).toContain('import x from "x";');
    expect(text).toContain('  function Button({ track, label = "a", other }: any) {');
    expect(text).toContain("  function go() { x(track); }");
    // the template sits inside the function, before its closing brace and the default export
    expect(text.indexOf("function go()")).toBeLessThan(text.indexOf("// --- svelte template"));
    expect(text).toContain("// --- end template ---\n}\nexport default Button;\n");
    expect(text.trimEnd().endsWith("declare function __eventra_svelte_template_event__(name: string): void;")).toBe(true);
  });

  it("uses the destructuring of $props() as the parameter, without its type annotation", () => {
    const text = module(`<script lang="ts">
  let { track, label = "x", ...rest }: { track: string } = $props();
</script>`);
    expect(text).toBe('\nfunction Button({ track, label = "x", ...rest }: any) {\n}\nexport default Button;\n');
  });

  it("uses the variable that holds $props() as the parameter", () => {
    const text = module(`<script>\n  const props = $props();\n  go(props.track);\n</script>`);
    expect(text).toContain("function Button(props: any) {");
    expect(text).toContain("go(props.track);");
  });

  it("keeps readonly exports as plain declarations and drops export lists", () => {
    const text = module(`<script>
  export let a;
  export const b = 1;
  export function c() {}
  export { a as z };
</script>`);
    expect(text).toContain("function Button({ a }: any) {");
    expect(text).toContain("const b = 1;");
    expect(text).toContain("function c() {}");
    expect(text).not.toContain("export {");
    expect(text).not.toMatch(/export (const|function)/);
  });

  it("keeps the line of every statement, with the imports above the function", () => {
    const text = module(`<script>\n  import x from "x";\n\n  export let a;\n\n  x(a);\n</script>`);
    expect(text.split("\n").findIndex((line) => line.includes("x(a);"))).toBe(5);
  });

  it("is async when the script awaits at the top level", () => {
    expect(module(`<script>\n  export let a;\n  await load();\n</script>`)).toContain("async function Button(");
  });

  it("puts the module script above the function and leaves it alone", () => {
    const text = module(`<script context="module">\n  export const KIND = 1;\n</script>\n<script>\n  export let a;\n</script>`);
    expect(text.indexOf("export const KIND")).toBeLessThan(text.indexOf("function Button"));
  });

  it("scans a component without props exactly as before", () => {
    const text = module(`<script>\n  const a = 1;\n</script>\n<b event={a} />`);
    expect(text).toContain("function __eventraSvelteTemplate() {");
    expect(text).not.toContain("export default");
  });

  it("does not wrap a script it does not follow", () => {
    expect(module(`<script>\n  export let a;\n  export default {};\n</script>`)).not.toContain("function Button");
    expect(module(`<script>\n  export let a;\n  export * from "x";\n</script>`)).not.toContain("function Button");
    expect(module(`<script>\n  const x = 1;\n  import y from "y";\n  export let a;\n</script>`)).not.toContain("function Button");
    expect(module(`<script>\n  export let { a } = {};\n</script>`)).not.toContain("function Button");
    expect(module(`<script>\n  const [a] = $props();\n</script>`)).not.toContain("function Button");
    expect(module(`<script>\n  import y from "y";\n</script>`)).not.toContain("function Button");
    expect(module(`<script>\n  $props();\n</script>`)).not.toContain("function Button");
  });

  it("follows only the first $props() declaration", () => {
    const text = module(`<script>\n  let { a } = $props();\n  let { b } = $props();\n</script>`);
    expect(text).toContain("function Button({ a }: any) {");
  });

  it("turns a use of an imported component into a call with its props", () => {
    const text = module(`<script>
  import Button from "./Button.svelte";
  import Card from "./Card.svelte";
  import { Other } from "./other";
  const name = "n";
</script>
<div>
  <Button track="a&quot;b" label={name} {name} />
  <Card id={1} />
  <Other n={1} />
  <Button disabled y="p-{name}" {...rest} on:click={go} />
</div>`);
    expect(text).toContain('  Button({ track: "a\\"b", label: (name\n), name: (name\n) });');
    expect(text).toContain("  Card({ id: (1\n) });");
    expect(text).not.toContain("Other(");
    expect(text.match(/Button\(/g)).toHaveLength(1);
    expect(text).toContain("function __eventraSvelteTemplate() {");
  });

  it("quotes a prop name that is not an identifier", () => {
    const text = module(`<script>\n  import B from "./b.svelte";\n</script>\n<B data-x="1" />`);
    expect(text).toContain('B({ "data-x": "1" });');
  });

  it("names the component after its file and keeps the name clear of the script's own", () => {
    const code = `<script>\n  export let a;\n</script>`;
    expect(module(code, "/p/my-page.svelte")).toContain("function MyPage(");
    expect(module(code, "/p/+page.svelte")).toContain("function Page(");
    expect(module(code, "/p/.svelte")).toContain("function SvelteComponent(");
    expect(module(`<script>\n  import Button from "./x.svelte";\n  export let a;\n</script>`, "/p/Button.svelte")).toContain("function ButtonComponent(");
    expect(module(code, "")).toContain("function SvelteComponent(");
  });

  it("keeps the component's name clear of every kind of binding the script declares", () => {
    const script = `<script>
  export let a;
  const [, Arr] = x;
  const { k: [Hole], Dflt = 1, ...Rst } = y;
  const [, ...Tail] = z;
  class Cls {}
</script>`;
    for (const name of ["Arr", "Hole", "Dflt", "Rst", "Tail", "Cls"]) {
      expect(module(script, `/p/${name}.svelte`)).toContain(`function ${name}Component(`);
    }
  });

  it("closes the function when the component is only a script", () => {
    expect(module(`<script>\n  export let a;\n</script>`)).toBe("// @ts-nocheck\nfunction Button({ a }: any) {\n}\nexport default Button;\n");
  });
});

describe("buildScriptModule: what is a component and what is wrapped", () => {
  it("keeps the component's name clear of exported and function declarations", () => {
    const named = (script: string, name: string): string => module(`<script>\n  export let a;\n  ${script}\n</script>`, `/p/${name}.svelte`);
    expect(named("function Foo() {}", "Foo")).toContain("function FooComponent(");
    expect(named("export function Foo() {}", "Foo")).toContain("function FooComponent(");
    expect(named("export const Foo = 1;", "Foo")).toContain("function FooComponent(");
    expect(named("export { x };", "Foo")).toContain("function Foo(");
  });

  it("does not count a name from a default export as declared", () => {
    const text = module(`<script context="module">\n  export default function Foo() {}\n</script>\n<script>\n  export let a;\n</script>`, "/p/Foo.svelte");
    expect(text).toContain("function Foo({ a }");
  });

  it("does not take a type-only import for a component", () => {
    const text = module(`<script lang="ts">\n  import type Foo from "./Foo.svelte";\n  import Bar from "./Bar.svelte";\n</script>\n<Foo a="1" /><Bar b="2" />`);
    expect(text).not.toContain("Foo(");
    expect(text).toContain('Bar({ b: "2" });');
  });

  it("does not wrap a module script, even one that exports a prop-like variable", () => {
    expect(module(`<script context="module">\n  export let a;\n</script>`)).not.toContain("function Button");
  });

  it("reads $props() only from a call of that name, and tolerates a declaration without a value", () => {
    expect(module(`<script>\n  let { a } = foo();\n</script>`)).not.toContain("function Button");
    expect(module(`<script>\n  let { a } = a.$props();\n</script>`)).not.toContain("function Button");
    expect(module(`<script>\n  let x;\n  let { a } = $props();\n</script>`)).toContain("function Button({ a }: any) {");
  });

  it("does not take a declaration of several variables for the props unless it is the only one", () => {
    expect(module(`<script>\n  let { a } = $props(), b = 1;\n</script>`)).not.toContain("function Button");
  });

  it("does not mix a prop it cannot follow with the ones it can", () => {
    expect(module(`<script>\n  export let b;\n  const [a] = $props();\n</script>`)).not.toContain("function Button");
  });

  it("drops the space before the type of a destructured $props()", () => {
    expect(module(`<script lang="ts">\n  let { a } : Props = $props();\n</script>`)).toContain("function Button({ a }: any) {");
  });

  it("removes only the export keyword of a readonly export, and keeps every line", () => {
    expect(module(`<script>\n  export let a;\n  export const b = 1;\n\n  export function c() {}\n</script>`)).toBe(
      "// @ts-nocheck\n" + "function Button({ a }: any) {\n" + "  const b = 1;\n\n  function c() {}\n}\nexport default Button;\n",
    );
  });

  it("applies several edits and the header in the right places", () => {
    const text = module(`<script>\n  import x from "x";\n  export const k = 1;\n  export let a;\n  export { k as z };\n  export let b = 2;\n  x(a, b);\n</script>`);
    expect(text).toBe('// @ts-nocheck\nimport x from "x";\n  function Button({ a, b = 2 }: any) {const k = 1;\n  \n  \n  \n  x(a, b);\n}\nexport default Button;\n');
  });
});
