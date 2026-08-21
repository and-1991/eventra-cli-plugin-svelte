import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createCliPluginSvelte } from "../src/index";
import { buildScriptModule, parseSvelteSfc, scriptVirtualPath } from "../src/parse-svelte-sfc";

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "checkout.svelte",
);

describe("parseSvelteSfc", () => {
  it("extracts the instance script and literal template event", () => {
    const source = readFileSync(FIXTURE, "utf8");
    const parsed = parseSvelteSfc(source, FIXTURE);

    expect(parsed.scripts).toHaveLength(1);
    expect(parsed.scripts[0]?.module).toBe(false);
    expect(parsed.scripts[0]?.lang).toBe("ts");
    expect(parsed.scripts[0]?.content).toContain('tracker.track("checkout.started")');
    expect(parsed.templateEvents).toEqual([{ kind: "literal", value: "checkout.cta" }]);
  });

  it("builds the virtual module path", () => {
    expect(scriptVirtualPath("/src/App.svelte")).toBe("/src/App.svelte.ts");
  });

  it("ignores <script>/template-looking text inside HTML comments", () => {
    const source = `
      <!-- <script>evil()</script> -->
      <script>track("real");</script>
      <!-- <button event="fake" /> -->
      <button event="real_event" />
    `;
    const parsed = parseSvelteSfc(source, "/virtual/Comment.svelte");

    expect(parsed.scripts).toHaveLength(1);
    expect(parsed.scripts[0]?.content).toBe('track("real");');
    expect(parsed.templateEvents).toEqual([{ kind: "literal", value: "real_event" }]);
  });

  it("finds literal event bindings across nested elements, if/each, slots and components", () => {
    const source = `
      <button event="root_a" />
      {#if cond}
        <button event="conditional" />
      {:else if other}
        <button event="else_if_branch" />
      {:else}
        <button event="fallback" />
      {/if}
      {#each items as item (item.id)}
        <button event="looped" />
      {/each}
      <svelte:fragment slot="footer">
        <button event="slot_footer" />
      </svelte:fragment>
      <Foo>
        <button event="default_slot" />
      </Foo>
    `;
    const parsed = parseSvelteSfc(source, "/virtual/Multi.svelte");

    expect(parsed.templateEvents.map((e) => e.value)).toEqual([
      "root_a",
      "conditional",
      "else_if_branch",
      "fallback",
      "looped",
      "slot_footer",
      "default_slot",
    ]);
  });

  it("finds literal event bindings inside await and key blocks", () => {
    const source = `
      {#await promise}
        <button event="pending" />
      {:then value}
        <button event="resolved" />
      {:catch error}
        <button event="rejected" />
      {/await}
      {#key routeId}
        <button event="keyed" />
      {/key}
    `;
    const parsed = parseSvelteSfc(source, "/virtual/Blocks.svelte");

    expect(parsed.templateEvents.map((e) => e.value)).toEqual([
      "pending",
      "resolved",
      "rejected",
      "keyed",
    ]);
  });

  it("drops an empty event=\"\" attribute instead of emitting a blank literal", () => {
    const parsed = parseSvelteSfc('<button event="" />', "/EmptyLiteral.svelte");

    expect(parsed.templateEvents).toHaveLength(0);
  });

  it("ignores a boolean-shorthand event attribute (no value)", () => {
    const parsed = parseSvelteSfc("<button event />", "/BooleanShorthand.svelte");

    expect(parsed.templateEvents).toHaveLength(0);
  });

  it("ignores an interpolated/mixed event value instead of misreading it as one binding", () => {
    const parsed = parseSvelteSfc('<button event="prefix-{suffix}" />', "/Mixed.svelte");

    expect(parsed.templateEvents).toHaveLength(0);
  });

  it("captures dynamic event={} bindings as raw expressions instead of dropping them", () => {
    const source = `
      <button event={computedName} />
      <button event={isActive ? 'a' : 'b'} />
    `;
    const parsed = parseSvelteSfc(source, "/virtual/Dynamic.svelte");

    expect(parsed.templateEvents).toEqual([
      { kind: "dynamic", value: "computedName" },
      { kind: "dynamic", value: "isActive ? 'a' : 'b'" },
    ]);
  });

  it("merges context=module and instance scripts with module first regardless of source order", () => {
    const source = `
      <script>
      track(SHARED);
      </script>
      <script context="module">
      export const SHARED = "shared_event";
      </script>
    `;
    const parsed = parseSvelteSfc(source, "/virtual/TwoBlocks.svelte");

    expect(parsed.scripts).toHaveLength(2);
    expect(parsed.scripts[0]?.module).toBe(true);
    expect(parsed.scripts[0]?.content).toContain("SHARED");
    expect(parsed.scripts[1]?.module).toBe(false);
    expect(parsed.scripts[1]?.content).toBe("track(SHARED);");
  });

  it("passes Svelte 5 runes through untouched and still detects the sink call", () => {
    const source = `
      <script lang="ts">
      import { Eventra } from "@eventra_dev/eventra-sdk";

      let { eventName = "all_runes_event" } = $props<{ eventName?: string }>();
      const tracker = new Eventra({ apiKey: "k" });
      tracker.track(eventName);
      </script>
      <button event="all_runes_template_event" />
    `;
    const parsed = parseSvelteSfc(source, "/virtual/Runes.svelte");

    const script = parsed.scripts[0]?.content ?? "";
    expect(script).toContain("$props<{ eventName?: string }>()");
    expect(script).toContain("tracker.track(eventName);");
    expect(parsed.templateEvents).toEqual([
      { kind: "literal", value: "all_runes_template_event" },
    ]);
  });

  it("skips a script block that is present but empty", () => {
    const parsed = parseSvelteSfc("<script></script>\n<button event=\"real\" />", "/EmptyScript.svelte");

    expect(parsed.scripts).toHaveLength(0);
    expect(parsed.templateEvents).toEqual([{ kind: "literal", value: "real" }]);
  });

  it("returns no scripts and no template events for an empty SFC", () => {
    const parsed = parseSvelteSfc("<div />", "/Empty.svelte");

    expect(parsed.scripts).toHaveLength(0);
    expect(parsed.templateEvents).toHaveLength(0);
  });

  it("reports a syntax error via the errors array instead of throwing", () => {
    const parsed = parseSvelteSfc("<button event=", "/Broken.svelte");

    expect(parsed.scripts).toHaveLength(0);
    expect(parsed.templateEvents).toHaveLength(0);
    expect(parsed.errors.length).toBeGreaterThan(0);
  });
});

describe("buildScriptModule", () => {
  it("emits a single module with script content followed by the template-events function", () => {
    const parsed = parseSvelteSfc(readFileSync(FIXTURE, "utf8"), FIXTURE);
    const module = buildScriptModule(parsed);

    expect(module).toContain('tracker.track("checkout.started")');
    expect(module).toContain('__eventra_svelte_template_event__("checkout.cta")');
  });

  it("emits dynamic bindings as raw (unquoted) expressions", () => {
    const parsed = parseSvelteSfc("<button event={computedName} />", "/virtual/Dynamic.svelte");
    const module = buildScriptModule(parsed);

    expect(module).toContain("__eventra_svelte_template_event__(computedName);");
    expect(module).not.toContain('__eventra_svelte_template_event__("computedName")');
  });

  it("resolves a dynamic binding through a real script-level const in the same module scope", () => {
    const source = `
      <script>
      const eventName = "from_instance_const";
      </script>
      <button event={eventName} />
    `;
    const parsed = parseSvelteSfc(source, "/virtual/Scoped.svelte");
    const module = buildScriptModule(parsed);

    expect(module).toContain('const eventName = "from_instance_const"');
    expect(module).toContain("__eventra_svelte_template_event__(eventName);");
  });

  it("labels a context=module block in its header comment", () => {
    const parsed = parseSvelteSfc(
      '<script context="module">export const SHARED = "shared_event";</script>',
      "/virtual/Module.svelte",
    );
    const module = buildScriptModule(parsed);

    expect(module).toContain("// --- svelte script context=module ---");
  });

  it('adds a @ts-nocheck header for a plain JS script block (no lang="ts")', () => {
    const parsed = parseSvelteSfc('<script>track("plain_js_event");</script>', "/PlainJs.svelte");
    const module = buildScriptModule(parsed);

    expect(module).toContain("// @ts-nocheck");
    expect(module).toContain('track("plain_js_event")');
  });

  it("returns an export stub when there is no script and no template events", () => {
    const parsed = parseSvelteSfc("<div />", "/Empty.svelte");
    const module = buildScriptModule(parsed);

    expect(module.trim()).toBe("export {}");
  });
});

describe("createCliPluginSvelte", () => {
  it("returns a single virtual module combining script and template", async () => {
    const source = readFileSync(FIXTURE, "utf8");
    const plugin = createCliPluginSvelte();

    expect(plugin.match("App.svelte")).toBe(true);
    expect(plugin.match("App.ts")).toBe(false);
    expect(plugin.includeGlobs).toContain("**/*.svelte");
    expect(plugin.staticSinks?.[0]?.callee).toBe("__eventra_svelte_template_event__");

    const result = await plugin.transform({ path: "/project/Checkout.svelte", source });

    expect(result.modules).toHaveLength(1);
    expect(result.modules[0]?.path).toBe("/project/Checkout.svelte.ts");
    expect(result.modules[0]?.content).toContain("checkout.started");
    expect(result.modules[0]?.content).toContain("checkout.cta");
  });

  it("returns an export stub when both script and template are missing", async () => {
    const plugin = createCliPluginSvelte();
    const result = await plugin.transform({ path: "/Empty.svelte", source: "<div />" });

    expect(result.modules).toHaveLength(1);
    expect(result.modules[0]?.content.trim()).toBe("export {}");
  });
});
