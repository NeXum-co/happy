/**
 * Async FIFO semaphore for concurrency control.
 * Capacity 1 serializes callers; capacity N allows N concurrent holders.
 * acquire() resolves with a release function; calling release() frees the permit
 * and hands it to the next waiter in the queue, if any.
 */

export class Semaphore {
    private _available: number
    private readonly _capacity: number
    private readonly _waiters: Array<() => void> = []

    constructor(capacity: number) {
        this._capacity = capacity
        this._available = capacity
    }

    /**
     * Acquire one permit. Resolves with a release function when the permit is granted.
     * Callers are served in FIFO order.
     */
    acquire(): Promise<() => void> {
        if (this._available > 0) {
            this._available--
            return Promise.resolve(() => this._release())
        }

        return new Promise<() => void>((resolve) => {
            this._waiters.push(() => {
                // Permit is handed directly — do not decrement available here;
                // it was already decremented when we decided to hand to a waiter.
                resolve(() => this._release())
            })
        })
    }

    /** Remaining permits (never negative). */
    get available(): number {
        return this._available
    }

    private _release(): void {
        const next = this._waiters.shift()
        if (next) {
            // Hand the permit to the next waiter without changing _available
            next()
        } else {
            this._available = Math.min(this._available + 1, this._capacity)
        }
    }
}
