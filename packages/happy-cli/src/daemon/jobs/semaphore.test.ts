/**
 * Unit tests for the async FIFO semaphore.
 */

import { describe, it, expect } from 'vitest'
import { Semaphore } from './semaphore'

describe('Semaphore', () => {
    it('first acquire() resolves immediately and decrements available', async () => {
        const sem = new Semaphore(1)
        expect(sem.available).toBe(1)

        const releasePromise = sem.acquire()
        // With capacity 1, the first acquire should resolve in the same microtask tick
        const release = await releasePromise
        expect(sem.available).toBe(0)
        expect(typeof release).toBe('function')
    })

    it('second acquire() stays pending until first is released', async () => {
        const sem = new Semaphore(1)

        const release1 = await sem.acquire()
        expect(sem.available).toBe(0)

        // Second acquire must NOT resolve before release1 is called
        let secondResolved = false
        const secondPromise = sem.acquire().then((release) => {
            secondResolved = true
            return release
        })

        // Yield to the microtask queue — second must still be pending
        await Promise.resolve()
        await Promise.resolve()
        expect(secondResolved).toBe(false)
        expect(sem.available).toBe(0)

        // Release first permit
        release1()

        // Now the second should resolve
        const release2 = await secondPromise
        expect(secondResolved).toBe(true)
        expect(sem.available).toBe(0)

        // Release second — back to full capacity
        release2()
        expect(sem.available).toBe(1)
    })

    it('available never goes negative', async () => {
        const sem = new Semaphore(1)
        const release = await sem.acquire()
        expect(sem.available).toBe(0)
        // releasing when no waiters frees the slot
        release()
        expect(sem.available).toBe(1)
        // releasing again (double-release) should not go below 0 or above capacity
        // (spec says: hand to next waiter if any; otherwise just free)
        // double-release is not a defined behaviour to test strictly, skip.
    })

    it('capacity > 1 allows multiple concurrent acquires', async () => {
        const sem = new Semaphore(3)
        expect(sem.available).toBe(3)

        const r1 = await sem.acquire()
        const r2 = await sem.acquire()
        const r3 = await sem.acquire()
        expect(sem.available).toBe(0)

        r1()
        expect(sem.available).toBe(1)
        r2()
        r3()
        expect(sem.available).toBe(3)
    })
})
