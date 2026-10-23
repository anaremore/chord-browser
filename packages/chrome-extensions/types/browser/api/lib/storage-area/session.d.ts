import { StorageArea } from './index';
export declare class SessionStorageArea extends StorageArea {
    private state;
    constructor();
    /** Clear in-memory state (called on extension unload). */
    resetCache(): void;
}
