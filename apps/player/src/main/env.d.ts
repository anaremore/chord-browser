/** The castLabs ECS build the player is packaged on (ecs.json), defined at build time. */
declare const __ECS_VERSION__: string;

declare namespace Electron {
  /**
   * castLabs ECS only: the Widevine CDM, which Chromium's component updater
   * installs from Google on first use (ECS's `components` API).
   */
  interface Components {
    whenReady(): Promise<void>;
    status(): Record<string, { status: string; title?: string; version?: string }>;
    readonly updatesEnabled: boolean;
  }
}
