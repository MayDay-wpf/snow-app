// Only the real client-script host members used by this example.
// snow.on does not return an unsubscribe function; the host clears these
// subscriptions after onCleanup callbacks when the script is unloaded.
declare const snow: {
  readonly context: { readonly locale: string };
  on(event: "context", listener: () => void): void;
  onCleanup(callback: () => void): void;
  client: { insertInputText(text: string): void };
};
