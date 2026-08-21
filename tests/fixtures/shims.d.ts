// Ambient shims for editor type-checking of the fixture files in this
// directory only. The plugin's tests read these files as raw text
// (readFileSync + parseSvelteSfc) — this file has no effect on the actual
// test suite or build, it only silences editor diagnostics that don't
// apply here (fixtures aren't compiled standalone).
declare module "@eventra_dev/eventra-sdk" {
  export interface TrackOptions {
    userId?: string;
  }
  export class Eventra {
    constructor(config: { apiKey: string; endpoint?: string });
    track(event: string, options?: TrackOptions): void;
  }
}

declare function track(event: string, data?: unknown): void;
