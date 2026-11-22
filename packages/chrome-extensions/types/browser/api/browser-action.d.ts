import { ExtensionContext } from '../context';
import { ResizeType } from './common';
interface ActivateDetails {
    eventType: string;
    extensionId: string;
    tabId: number;
    anchorRect: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    alignment?: string;
}
export declare class BrowserActionAPI {
    private ctx;
    private actionMap;
    private popup?;
    private observers;
    private queuedUpdate;
    constructor(ctx: ExtensionContext);
    private setupSession;
    handleCRXRequest(request: GlobalRequest): GlobalResponse;
    /**
     * Chord: the action's current icon for a tab (or its default) at a size, as
     * the crx:// protocol serves it. Undefined when there's none.
     */
    getIcon(extensionId: string, tabId: string | number | null | undefined, imageSize: number, resizeType?: ResizeType): Electron.NativeImage | undefined;
    private getAction;
    removeActions(extensionId: string): void;
    private getPopupUrl;
    processExtension(extension: Electron.Extension): void;
    getState(): {
        activeTabId: number | undefined;
        actions: {
            color?: string;
            text?: string;
            title?: string;
            popup?: string;
            iconModified?: number;
            id: string;
            tabs: {
                [key: string]: any;
            };
        }[];
    };
    private activate;
    activateClick(details: ActivateDetails): void;
    private activateContextMenu;
    private openPopup;
    private onUpdate;
}
export {};
