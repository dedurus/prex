/*! *****************************************************************************
Copyright (c) Microsoft Corporation.
Licensed under the Apache License, Version 2.0.

See LICENSE file in the project root for details.
***************************************************************************** */

import { LinkedListNode, LinkedList } from "./list";
import { CancellationToken, CancelError } from "./cancellation";
import { isMissing, isInstance } from "./utils";
import { Cancelable } from "@esfx/cancelable";
import { getToken } from "./adapter";
import { Disposable } from "@esfx/disposable";

/**
 * Coordinates readers and writers for a resource.
 */
export class ReaderWriterLock {
    private _readers = new LinkedList<() => void>();
    private _upgradeables = new LinkedList<() => void>();
    private _upgrades = new LinkedList<() => void>();
    private _writers = new LinkedList<() => void>();
    private _upgradeable: UpgradeableLockHandle | undefined;
    private _upgraded: LockHandle | undefined;
    private _count = 0;

    /**
     * Asynchronously waits for and takes a read lock on a resource.
     *
     * @param token A CancellationToken used to cancel the request.
     */
    public read(token?: CancellationToken | Cancelable): Promise<LockHandle> {
        return new Promise<LockHandle>((resolve, reject) => {
            const _token = getToken(token);
            _token.throwIfCancellationRequested();

            if (this._canTakeReadLock()) {
                resolve(this._takeReadLock());
                return;
            }

            const node = this._readers.push(() => {
                registration.unregister();
                if (_token!.cancellationRequested) {
                    reject(new CancelError());
                }
                else {
                    resolve(this._takeReadLock());
                }
            });

            const registration = _token.register(() => {
                if (node.list) {
                    node.list.deleteNode(node);
                    reject(new CancelError());
                }
            });
        });
    }

    /**
     * Asynchronously waits for and takes a read lock on a resource
     * that can later be upgraded to a write lock.
     *
     * @param token A CancellationToken used to cancel the request.
     */
    public upgradeableRead(token?: CancellationToken | Cancelable): Promise<UpgradeableLockHandle> {
        return new Promise<UpgradeableLockHandle>((resolve, reject) => {
            const _token = getToken(token);
            _token.throwIfCancellationRequested();

            if (this._canTakeUpgradeableReadLock()) {
                resolve(this._takeUpgradeableReadLock());
                return;
            }

            const node = this._upgradeables.push(() => {
                registration.unregister();
                if (_token!.cancellationRequested) {
                    reject(new CancelError());
                }
                else {
                    resolve(this._takeUpgradeableReadLock());
                }
            });

            const registration = _token.register(() => {
                if (node.list) {
                    node.list.deleteNode(node);
                    reject(new CancelError());
                }
            });
        });
    }

    /**
     * Asynchronously waits for and takes a write lock on a resource.
     *
     * @param token A CancellationToken used to cancel the request.
     */
    public write(token?: CancellationToken | Cancelable): Promise<LockHandle> {
        return new Promise<LockHandle>((resolve, reject) => {
            const _token = getToken(token);
            _token.throwIfCancellationRequested();

            if (this._canTakeWriteLock()) {
                resolve(this._takeWriteLock());
                return;
            }

            const node = this._writers.push(() => {
                registration.unregister();
                if (_token!.cancellationRequested) {
                    reject(new CancelError());
                }
                else {
                    resolve(this._takeWriteLock());
                }
            });

            const registration = _token.register(() => {
                if (node.list) {
                    node.list.deleteNode(node);
                    reject(new CancelError());
                }
            });
        });
    }

    private _upgrade(token?: CancellationToken | Cancelable): Promise<LockHandle> {
        return new Promise<LockHandle>((resolve, reject) => {
            const _token = getToken(token);
            _token.throwIfCancellationRequested();

            if (this._canTakeUpgradeLock()) {
                resolve(this._takeUpgradeLock());
                return;
            }

            const node = this._upgrades.push(() => {
                registration.unregister();
                if (_token!.cancellationRequested) {
                    reject(new CancelError());
                }
                else {
                    resolve(this._takeUpgradeLock());
                }
            });

            const registration = _token.register(() => {
                if (node.list) {
                    node.list.deleteNode(node);
                    reject(new CancelError());
                }
            });
        });
    }

    private _processLockRequests(): void {
        if (this._processWriteLockRequest()) return;
        if (this._processUpgradeRequest()) return;
        this._processUpgradeableReadLockRequest();
        this._processReadLockRequests();
    }

    private _canTakeReadLock() {
        return this._count >= 0
            && this._writers.size === 0
            && this._upgrades.size === 0
            && this._writers.size === 0;
    }

    private _processReadLockRequests(): void {
        if (this._canTakeReadLock()) {
            this._readers.forEach(resolve => resolve());
            this._readers.clear();
        }
    }

    private _takeReadLock(): LockHandle {
        let released = false;
        this._count++;
        const release = () => {
            if (released)
                throw new Error("Lock already released.");
            released = true;
            this._releaseReadLock();
        };
        return {
            release,
            [Disposable.dispose]: release,
        };
    }

    private _releaseReadLock(): void {
        this._count--;
        this._processLockRequests();
    }

    private _canTakeUpgradeableReadLock() {
        return this._count >= 0 && !this._upgradeable;
    }

    private _processUpgradeableReadLockRequest(): void {
        if (this._canTakeUpgradeableReadLock()) {
            const resolve = this._upgradeables.shift();
            if (resolve) {
                resolve();
            }
        }
    }

    private _takeUpgradeableReadLock(): UpgradeableLockHandle {
        const upgrade = (token?: CancellationToken | Cancelable) => {
            if (this._upgradeable !== hold)
                throw new Error("Lock already released.");
            return this._upgrade(token);
        };
        const release = () => {
            if (this._upgradeable !== hold)
                throw new Error("Lock already released.");
            this._releaseUpgradeableReadLock();
        };
        const hold: UpgradeableLockHandle = {
            upgrade,
            release,
            [Disposable.dispose]: release,
        };
        this._count++;
        this._upgradeable = hold;
        return hold;
    }

    private _releaseUpgradeableReadLock(): void {
        if (this._count === -1) {
            this._count = 0;
        }
        else {
            this._count--;
        }

        this._upgraded = undefined;
        this._upgradeable = undefined;
        this._processLockRequests();
    }

    private _canTakeUpgradeLock() {
        return this._count === 1
            && this._upgradeable
            && !this._upgraded;
    }

    private _processUpgradeRequest(): boolean {
        if (this._canTakeUpgradeLock()) {
            const resolve = this._upgrades.shift();
            if (resolve) {
                resolve();
                return true;
            }
        }

        return false;
    }

    private _takeUpgradeLock(): LockHandle {
        const release = () => {
            if (this._upgraded !== hold)
                throw new Error("Lock already released.");
            this._releaseUpgradeLock();
        };
        const hold: LockHandle = {
            release,
            [Disposable.dispose]: release
        };

        this._upgraded = hold;
        this._count = -1;
        return hold;
    }

    private _releaseUpgradeLock(): void {
        this._upgraded = undefined;
        this._count = 1;
        this._processLockRequests();
    }

    private _canTakeWriteLock() {
        return this._count === 0;
    }

    private _processWriteLockRequest(): boolean {
        if (this._canTakeWriteLock()) {
            const resolve = this._writers.shift();
            if (resolve) {
                resolve();
                return true;
            }
        }

        return false;
    }

    private _takeWriteLock(): LockHandle {
        let released = false;
        this._count = -1;
        const release = () => {
            if (released)
                throw new Error("Lock already released.");
            released = true;
            this._releaseWriteLock();
        };
        return {
            release,
            [Disposable.dispose]: release,
        };
    }

    private _releaseWriteLock(): void {
        this._count = 0;
        this._processLockRequests();
    }
}

/**
 * An object used to release a held lock.
 */
export interface LockHandle extends Disposable {
    /**
     * Releases the lock.
     */
    release(): void;
}

/**
 * An object used to release a held lock or upgrade to a write lock.
 */
export interface UpgradeableLockHandle extends LockHandle, Disposable {
    /**
     * Upgrades the lock to a write lock.
     *
     * @param token A CancellationToken used to cancel the request.
     */
    upgrade(token?: CancellationToken | Cancelable): Promise<LockHandle>;
}