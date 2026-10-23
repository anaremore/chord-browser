import { EventEmitter } from 'node:events';
import { ExtensionContext } from '../context';
export declare class RuntimeAPI extends EventEmitter {
    private ctx;
    private hostMap;
    constructor(ctx: ExtensionContext);
    dispatchInstalled(extensionId: string, details: chrome.runtime.InstalledDetails): Promise<boolean>;
    private connectNative;
    private disconnectNative;
    private sendNativeMessage;
    private openOptionsPage;
}
