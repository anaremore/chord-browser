import { EventEmitter } from 'events';
import type { ExtensionEvent, ExtensionRouter } from '../../../router';
interface ClearStorageAdapterTask {
    type: 'clear';
}
interface GetStorageAdapterTask {
    type: 'get';
    keys: string[] | undefined;
}
interface RemoveStorageAdapterTask {
    type: 'remove';
    keys: string[];
}
interface SetStorageAdapterTask {
    type: 'set';
    items: Record<string, any>;
}
type StorageAdapterTask = ClearStorageAdapterTask | GetStorageAdapterTask | RemoveStorageAdapterTask | SetStorageAdapterTask;
interface StorageAdapterTaskResult {
    clear: Record<string, any>;
    get: Record<string, any>;
    remove: Record<string, any>;
    set: Record<string, any>;
}
export type StorageAdapter = <T extends StorageAdapterTask>(task: T) => Promise<StorageAdapterTaskResult[T['type']]>;
export type StorageItems = Record<string, any>;
export declare class StorageArea extends EventEmitter {
    private adapter;
    private queuedChanges;
    private flushQueuedChangesScheduled;
    constructor(adapter: StorageAdapter);
    private flushQueuedChanges;
    private enqueueChanges;
    clear(): Promise<void>;
    get(keys?: string | string[] | Record<string, any> | null): Promise<Record<string, any>>;
    getBytesInUse(keys?: string | string[] | null): Promise<number>;
    getKeys(): Promise<string[]>;
    remove(keys: string | string[]): Promise<void>;
    set(items: Record<string, any>): Promise<void>;
    setAccessLevel(_accessOptions: {
        accessLevel: chrome.storage.AccessLevel;
    }): Promise<void>;
}
export declare function registerStorageAreaHandlers(areaName: string, router: ExtensionRouter, getArea: (event: ExtensionEvent) => StorageArea): void;
export {};
