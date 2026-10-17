import { describe, expect, it } from "vitest";

import { buildScriptModule, parseSvelteSfc, scriptVirtualPath, type ParsedSvelteSfc } from "../src/parse-svelte-sfc";

// Exact-output tests: what each markup construct becomes, field by field, and the exact virtual module text.

const parse = (source: string) => parseSvelteSfc(source, "/proj/App.svelte");
const handlersOf = (markup: string) => parse(markup).templateHandlers;
const eventsOf = (markup: string) => parse(markup).templateEvents;

const CALLEE = "__eventra_svelte_template_event__";

describe("event= attributes", () => {
  it("trims a literal event name", () => {
    expect(eventsOf(`<a event="  signup  ">x</a>`)).toEqual([{ kind: "literal", value: "signup" }]);
  });

  it("drops a literal that is only whitespace", () => {
    expect(eventsOf(`<a event="   ">x</a>`)).toEqual([]);
  });

  it("reads a dynamic event expression exactly, whatever spaces surround it", () => {
    expect(eventsOf(`<a event={  name  }>x</a>`)).toEqual([{ kind: "dynamic", value: "name" }]);
  });

  it("skips a boolean event attribute and a mixed value", () => {
    expect(eventsOf(`<a event>x</a><a event="a-{b}">y</a><a event="{a}{b}">z</a>`)).toEqual([]);
  });

  it("does not take other attributes for an event", () => {
    expect(eventsOf(`<a name="x" data-event="y" events="z" eventx={w}>x</a>`)).toEqual([]);
  });

  it("does not take a directive called event for an event attribute", () => {
    expect(eventsOf(`<script>let v = 1;</script><input bind:event={v} />`)).toEqual([]);
  });
});

describe("inline handlers and expressions", () => {
  it("reads on: handlers and Svelte 5 on* attributes, trimmed", () => {
    expect(handlersOf(`<a on:click={  go()  }>x</a><b onclick={  stop()  }>y</b>`)).toEqual(["go()", "stop()"]);
  });

  it("ignores a bare on:click (event forwarding)", () => {
    expect(handlersOf(`<a on:click>x</a>`)).toEqual([]);
  });

  it("reads an on* attribute only when it is a single expression", () => {
    expect(handlersOf(`<a onclick="static">x</a>`)).toEqual([]);
    expect(handlersOf(`<a onclick="a{b}c">x</a>`)).toEqual(["b"]);
  });

  it("does not take attributes that merely contain on for handlers", () => {
    expect(handlersOf(`<a data-onclick="x" ondblclick2="y" on="z">x</a>`)).toEqual([]);
  });

  it("puts an on* attribute's expression ahead of the other attributes' expressions", () => {
    expect(handlersOf(`<a class={cls()} onclick={go()}>x</a>`)).toEqual(["go()", "cls()"]);
  });

  it("does not put an attribute that merely ends or starts like an event first", () => {
    expect(handlersOf(`<a data-onclick={x()} onclick={go()}>x</a>`)).toEqual(["go()", "x()"]);
    expect(handlersOf(`<a onclick2={x()} onclick={go()}>x</a>`)).toEqual(["go()", "x()"]);
  });

  it("puts only a single-expression on* value ahead, not a value made of several parts", () => {
    expect(handlersOf(`<a on:click={x()} title={t()} onclick="{a}c">x</a>`)).toEqual(["x()", "t()", "a"]);
  });

  it("reads the expression of a directive whose name starts with on", () => {
    expect(handlersOf(`<a class:onclick={active()}>x</a>`)).toEqual(["active()"]);
  });

  it.each([
    ["an action", `<a use:act={opts()}>x</a>`, "opts()"],
    ["a class directive", `<a class:on={flag()}>x</a>`, "flag()"],
    ["a transition", `<a transition:fade={cfg()}>x</a>`, "cfg()"],
    ["an animation", `<a animate:flip={cfg()}>x</a>`, "cfg()"],
    ["a spread", `<a {...props()}>x</a>`, "props()"],
  ])("reads the expression of %s, trimmed", (_label, markup, expected) => {
    expect(handlersOf(markup.replace(/\{([^}]+)\}/, (m) => `{  ${m.slice(1, -1).replace(/^\.\.\./, "...")}  }`))).toContain(expected);
  });

  it("does not read bind: or let: directives as code", () => {
    expect(handlersOf(`<script>let v = 1;</script><input bind:value={v} /><a let:item>x</a>`)).toEqual([]);
  });

  it("reads {expr}, {@html}, {@const}, {#if}, {#each}, {#await}, {#key} expressions, trimmed", () => {
    const markup = [
      "{  a()  }",
      "{@html  b()  }",
      "{@const c = d()}",
      "{#if  e()  }x{/if}",
      "{#each  f()  as item}y{/each}",
      "{#await  g()  then v}z{/await}",
      "{#key  h()  }w{/key}",
    ].join("\n");
    expect(handlersOf(markup)).toEqual(["a()", "b()", "c = d()", "e()", "f()", "g()", "h()"]);
  });

  it("reads the key of an each block as an expression of its own", () => {
    expect(handlersOf(`{#each items as item (  keyOf(item)  )}x{/each}`)).toEqual(["items", "keyOf(item)"]);
  });

  it("does not report the same expression twice", () => {
    expect(handlersOf(`<a onclick={go()} on:focus={go()}>x</a>`)).toEqual(["go()"]);
  });

  it("keeps the order of first appearance, parents before children", () => {
    expect(handlersOf(`<a on:click={one()}>{two()}<b use:x={three()}>{four()}</b></a>`)).toEqual(["one()", "two()", "three()", "four()"]);
  });

  it("reads expressions of nested blocks and components", () => {
    expect(handlersOf(`{#if a}<Comp on:save={save()} />{:else}{#each xs as x}<i>{x.y}</i>{/each}{/if}`)).toEqual(["a", "save()", "xs", "x.y"]);
  });
});

describe("scripts", () => {
  const scriptsOf = (source: string) => parse(source).scripts;

  it("defaults the language to js and lower-cases an explicit one", () => {
    expect(scriptsOf(`<script>let a = 1;</script>`)).toEqual([{ lang: "js", module: false, content: "let a = 1;", startLine: 1 }]);
    expect(scriptsOf(`<script lang="TS">let b = 2;</script>`)[0]?.lang).toBe("ts");
  });

  it("reads lang in single or double quotes, with or without a space after the equals sign", () => {
    expect(scriptsOf(`<script lang='ts'>let a = 1;</script>`)[0]?.lang).toBe("ts");
    expect(scriptsOf(`<script lang= "ts">let a = 1;</script>`)[0]?.lang).toBe("ts");
    expect(scriptsOf(`<script  context="module"   lang="ts">let a = 1;</script>`)[0]?.lang).toBe("ts");
  });

  it("takes the language from the script's own tag, not from another script", () => {
    const [module, instance] = scriptsOf(`<script context="module">let m = 1;</script>\n<script lang="ts">let i = 2;</script>`);
    expect(module).toMatchObject({ lang: "js", module: true, content: "let m = 1;" });
    expect(instance).toMatchObject({ lang: "ts", module: false, content: "let i = 2;" });
  });

  it("does not take a lang that belongs to another attribute", () => {
    expect(scriptsOf(`<script data-lang="ts">let a = 1;</script>`)[0]?.lang).toBe("js");
  });

  it("puts the module script first, and gives each the line of its first non-blank character", () => {
    const scripts = scriptsOf(`<script>\n\n  let i = 1;\n</script>\n\n<script context="module">\n  let m = 1;\n</script>`);
    expect(scripts.map((s) => [s.module, s.startLine])).toEqual([
      [true, 7],
      [false, 3],
    ]);
  });
});

describe("a file that does not parse", () => {
  it("returns only the error, with every list empty", () => {
    const parsed = parse(`<div>{#if}</div>`);
    expect(parsed.scripts).toEqual([]);
    expect(parsed.templateEvents).toEqual([]);
    expect(parsed.templateHandlers).toEqual([]);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]).toEqual(expect.any(String));
  });
});

describe("scriptVirtualPath", () => {
  it("adds .ts after the final .svelte only", () => {
    expect(scriptVirtualPath("/p/App.svelte")).toBe("/p/App.svelte.ts");
    expect(scriptVirtualPath("/p/App.SVELTE")).toBe("/p/App.svelte.ts");
    expect(scriptVirtualPath("/pkg.svelte/kit.svelte-ui/App.svelte")).toBe("/pkg.svelte/kit.svelte-ui/App.svelte.ts");
  });

  it("leaves a path that does not end in .svelte unchanged", () => {
    expect(scriptVirtualPath("/p/App.svelte.ts")).toBe("/p/App.svelte.ts");
    expect(scriptVirtualPath("/p/App.sveltex")).toBe("/p/App.sveltex");
  });
});

describe("buildScriptModule: exact text", () => {
  const parsed = (over: Partial<ParsedSvelteSfc> = {}): ParsedSvelteSfc => ({
    scripts: [],
    templateEvents: [],
    templateHandlers: [],
    errors: [],
    ...over,
  });

  it("is an export stub with a newline when there is nothing", () => {
    expect(buildScriptModule(parsed())).toBe("export {}\n");
  });

  it("puts the template function after the script, separated by one blank line, with exact lines", () => {
    const text = buildScriptModule(
      parsed({
        scripts: [{ lang: "ts", module: false, content: "let a = 1;", startLine: 1 }],
        templateEvents: [{ kind: "literal", value: "signup" }, { kind: "dynamic", value: "name" }],
        templateHandlers: ["go()"],
      }),
    );
    expect(text).toBe(
      [
        "let a = 1;",
        "",
        "// --- svelte template (auto-generated) ---",
        `declare function ${CALLEE}(name: string): void;`,
        "function __eventraSvelteTemplate() {",
        "  (go()",
        "  );",
        `  ${CALLEE}("signup");`,
        `  ${CALLEE}(name);`,
        "}",
        "",
      ].join("\n"),
    );
  });

  it("emits the template function for handlers alone, and for events alone", () => {
    expect(buildScriptModule(parsed({ templateHandlers: ["x"] }))).toContain("function __eventraSvelteTemplate() {");
    expect(buildScriptModule(parsed({ templateEvents: [{ kind: "literal", value: "e" }] }))).toContain("function __eventraSvelteTemplate() {");
  });

  it.each([
    ["ts", false],
    ["tsx", false],
    ["js", true],
    ["jsx", true],
    ["coffee", true],
  ])("a first %s script %s a @ts-nocheck header", (lang, header) => {
    const text = buildScriptModule(parsed({ scripts: [{ lang, module: false, content: "x", startLine: 1 }] }));
    expect(text.startsWith("// @ts-nocheck\n")).toBe(header);
  });

  it("lets only the first block decide on @ts-nocheck", () => {
    const ts = { lang: "ts", module: true, content: "a", startLine: 1 };
    const js = { lang: "js", module: false, content: "b", startLine: 2 };
    expect(buildScriptModule(parsed({ scripts: [ts, js] }))).not.toContain("@ts-nocheck");
    expect(buildScriptModule(parsed({ scripts: [js, ts] }))).toContain("@ts-nocheck");
  });

  it("escapes backslashes and double quotes in a literal event name, in that order", () => {
    const line = (value: string) =>
      buildScriptModule(parsed({ templateEvents: [{ kind: "literal", value }] }))
        .split("\n")
        .find((l) => l.startsWith(`  ${CALLEE}(`));
    expect(line(String.raw`a\b`)).toBe(`  ${CALLEE}("a\\\\b");`);
    expect(line('say "hi"')).toBe(`  ${CALLEE}("say \\"hi\\"");`);
    expect(line(String.raw`a\"b`)).toBe(`  ${CALLEE}("a\\\\\\"b");`);
  });
});
