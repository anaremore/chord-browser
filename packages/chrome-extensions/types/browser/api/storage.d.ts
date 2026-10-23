import { ExtensionContext } from '../context';
/**
 * Main-process implementation of chrome.storage.session and chrome.storage.local.
 *
 * Both storage areas are backed by the main process so that:
 * - Data is shared between all extension contexts (background, content scripts, popup)
 * - onChanged events are reliably broadcast to all contexts including MV3 service workers
 *
 * chrome.storage.session: in-memory, cleared when the extension is unloaded or the browser quits
 * chrome.storage.local: persisted to disk as JSON, survives browser restarts
 */
export declare class StorageAPI {
    private ctx;
    private sessionAreas;
    constructor(ctx: ExtensionContext);
    private getSessionArea;
}
