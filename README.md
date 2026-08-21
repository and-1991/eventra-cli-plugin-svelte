<p align="center">
<img src="./assets/eventra-icon-animated.svg" width="120">
</p>

# Eventra CLI Plugin — Svelte

<p align="center">
  <a href="https://www.npmjs.com/package/@eventra_dev/cli-plugin-svelte"><img alt="npm version" src="https://img.shields.io/npm/v/@eventra_dev/cli-plugin-svelte.svg?style=flat-square&color=blue"></a>
  <a href="https://www.npmjs.com/package/@eventra_dev/cli-plugin-svelte"><img alt="npm downloads" src="https://img.shields.io/npm/dm/@eventra_dev/cli-plugin-svelte.svg?style=flat-square&color=blue"></a>
  <img alt="tests passing" src="https://img.shields.io/badge/tests-22%20passing-brightgreen?style=flat-square&logo=vitest&logoColor=white">
  <img alt="coverage" src="https://img.shields.io/badge/coverage-100%25-brightgreen?style=flat-square&logo=vitest&logoColor=white">
  <img alt="node" src="https://img.shields.io/node/v/@eventra_dev/cli-plugin-svelte?style=flat-square&color=darkgreen&logo=node.js&logoColor=white">
  <a href="https://www.typescriptlang.org/"><img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ready-blue?style=flat-square&logo=typescript&logoColor=white"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@eventra_dev/cli-plugin-svelte?style=flat-square&color=lightgrey">
</p>

Official [**Eventra CLI**](https://www.npmjs.com/package/@eventra_dev/eventra-cli) plugin — extracts `track()` calls from Svelte components (`.svelte`), so `eventra sync`/`check`/`watch` understand Svelte and SvelteKit code the same way they already understand plain TypeScript.

---

## Overview

The CLI core is framework-agnostic and only walks `.ts`/`.tsx`/`.js`/`.jsx`. This plugin teaches it `.svelte`: it parses each component with the real Svelte compiler ([`svelte/compiler`](https://www.npmjs.com/package/svelte)) — not a regex — and hands the CLI a single virtual TypeScript module per file, so every existing detection rule (direct SDK calls, function wrappers, cross-file propagation, dynamic-name reporting) applies to Svelte code without any Svelte-specific case in the core engine.

Svelte and SvelteKit `.svelte` files are handled the same way — SvelteKit routes/layouts/components are ordinary Svelte components.

---

## Installation

```bash
npm install -D @eventra_dev/cli-plugin-svelte @eventra_dev/eventra-cli
# or
pnpm add -D @eventra_dev/cli-plugin-svelte @eventra_dev/eventra-cli
```

Enable it in `eventra.json`:

```json
{
  "plugins": ["@eventra_dev/cli-plugin-svelte"],
  "sync": {
    "include": ["**/*.{ts,tsx,js,jsx}"],
    "exclude": ["node_modules", "dist", ".svelte-kit", ".git"]
  }
}
```

`sync.include` does **not** need `**/*.svelte` added manually — the plugin registers it via `includeGlobs`.

---

## What gets detected

### `<script>` / `<script context="module">`

Handled exactly like a regular `.ts` file — direct SDK calls, function wrappers, variables, ternaries, cross-file propagation all apply:

```svelte
<script lang="ts">
  import { Eventra } from "@eventra_dev/eventra-sdk";

  const tracker = new Eventra({ apiKey: "YOUR_PROJECT_API_KEY" });

  tracker.track("checkout.started");
</script>
```

`<script context="module">` (runs once, before any instance) and the instance `<script>` are merged into one module, module code first. Svelte 5 runes (`$props`, `$state`, `$derived`, `$effect`, …) pass through untouched — they're ordinary JS/TS to the underlying compiler.

### Template — literal event attributes

```svelte
<button event="checkout.cta">Pay</button>
```

### Template — dynamic event attributes

```svelte
<button event={computedEventName}>Pay</button>
```

The expression is copied as-is into the same module scope as the script. If it resolves to a real script-level constant, the event name is detected normally; otherwise it's reported as a **dynamic occurrence** (same mechanism as `tracker.track(someVariable)` in plain TypeScript) instead of being silently dropped.

Only the plain literal (`event="..."`) and expression (`event={...}`) forms are supported. Unlike `@eventra_dev/cli-plugin-astro`, this plugin does not support a JSX-style `{event}` shorthand for `event={event}`, and an interpolated string like `event="a-{b}"` is silently ignored rather than treated as a binding - write `` event={`a-${b}`} `` instead if you need that.

`event` is recognized on any tag — plain elements, components, `{#if}`/`{:else if}`/`{:else}`, `{#each}`, `{#await}`/`{:then}`/`{:catch}`, `{#key}`, and slot content — since the plugin walks the whole template rather than special-casing specific block types.

---

## Configuration

No plugin-specific config — it activates purely by being listed in `eventra.json`'s `plugins` array (see [Installation](#installation)).

---

## Plugin contract

```ts
export interface CliPluginSvelte {
  readonly id: string;
  readonly version: string;
  readonly includeGlobs: readonly string[];
  readonly staticSinks?: readonly CliPluginStaticCalleeSink[];
  match(path: string): boolean;
  transform(input: { path: string; source: string }): Promise<{
    modules: Array<{ path: string; content: string }>;
  }>;
}
```

No dependency on `@eventra_dev/eventra-cli` — the CLI adapts this shape internally. `.svelte` → one virtual `.svelte.ts` module (compiled script content, then a function wrapping synthetic calls for every template `event="..."` binding). `staticSinks` describes those synthetic calls; the CLI builds its own sink detector from them. See [`@eventra_dev/eventra-cli`'s plugin docs](https://www.npmjs.com/package/@eventra_dev/eventra-cli#plugin-contract-for-authors) for the full external-plugin contract.

---

## Requirements

- Node.js 18+
- `@eventra_dev/eventra-cli` as the host CLI

---

## Test Coverage

**100% statement/branch/function/line coverage** (v8 provider, `pnpm test:coverage`), enforced via a `coverage.thresholds` block in `vitest.config.ts`.

**22 unit tests** (vitest), covering:

| Area | Covers |
|---|---|
| SFC parsing | `context="module"` + instance merge order, comment safety, syntax-error reporting |
| Template — literal | Nested elements, `{#if}`/`{:else if}`/`{:else}`, `{#each}`, `{#await}`/`{:then}`/`{:catch}`, `{#key}`, slots, components |
| Template — dynamic | Raw expression passthrough, resolution through the merged script scope |
| Edge cases | Empty `event=""`, boolean-shorthand `event`, interpolated `event="a-{b}"` |
| Svelte 5 runes | `$props()` destructuring passes through without special-casing |
| Virtual module output | Single combined `.svelte.ts`, export stub when script/template are empty |
| Plugin contract | `match()`, `includeGlobs`, `staticSinks`, `transform()` |

Run locally:

```bash
pnpm --filter @eventra_dev/cli-plugin-svelte test
pnpm --filter @eventra_dev/cli-plugin-svelte test:coverage
```

---

## License

MIT
