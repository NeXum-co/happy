import { afterEach, describe, expect, it, vi } from 'vitest';
import { isWebInsecureContext } from './secureContext';

const platformMock = vi.hoisted(() => ({ OS: 'web' as string }));

vi.mock('react-native', () => ({
    Platform: platformMock,
}));

describe('isWebInsecureContext', () => {
    const originalCrypto = globalThis.crypto;

    afterEach(() => {
        platformMock.OS = 'web';
        Object.defineProperty(globalThis, 'crypto', { value: originalCrypto, configurable: true });
    });

    it('returns true on web without WebCrypto subtle', () => {
        platformMock.OS = 'web';
        Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true });
        expect(isWebInsecureContext()).toBe(true);
    });

    it('returns false on web when WebCrypto subtle is present', () => {
        platformMock.OS = 'web';
        Object.defineProperty(globalThis, 'crypto', { value: { subtle: {} }, configurable: true });
        expect(isWebInsecureContext()).toBe(false);
    });

    it('returns false on native regardless of crypto', () => {
        platformMock.OS = 'ios';
        Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true });
        expect(isWebInsecureContext()).toBe(false);
    });
});
