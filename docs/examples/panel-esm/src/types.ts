import type * as React from "react";

// Only the PluginRuntimeApi fields consumed here; no private host imports.
export type PanelApi = Readonly<{
  t: (key: string) => string;
  ui: Readonly<{ React: typeof React }>;
}>;

// The host supplies other props too; this component only consumes api.
export type PanelProps = Readonly<{ api: PanelApi }>;
