import { describe, expect, it } from "vitest";

import { createCliPluginSvelte } from "../src/index";

// The CLI recognises a template event in dynamic-event reports by this name
// shape (packages/cli/src/plugin/registry.ts). Renaming the synthetic callee
// would silently turn "template of X.svelte: event=..." into a bare "~ X:1 __eventra_..." line.
describe("svelte template callee contract", () => {
  it("uses a callee name the CLI reports as a template event", () => {
    const sinks = createCliPluginSvelte().staticSinks ?? [];

    expect(sinks).toHaveLength(1);
    expect(sinks[0]?.callee).toMatch(/^__eventra_[a-z]+_template_event__$/);
  });
});
