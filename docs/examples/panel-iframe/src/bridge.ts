// The bridge is injected synchronously before the classic entry script.
// Declare only the actual SnowPlugin fields consumed by this example.
export type SnowPluginBridge = Readonly<{
  locale: "en" | "zh-CN" | "zh-TW";
  t: (key: string) => string;
}>;

declare global {
  interface Window {
    readonly SnowPlugin: SnowPluginBridge;
  }
}
