import { describe, expect, it } from 'vitest';
import { classifyRestoreError } from './classifyRestoreError';

describe('classifyRestoreError', () => {
    it('maps the key-authentication failure to connect.invalidSecretKey', () => {
        const error = new Error('Failed to authenticate with provided key');
        expect(classifyRestoreError(error)).toBe('connect.invalidSecretKey');
    });

    it('maps a genuine network/axios error to server.failedToConnectToServer', () => {
        const error = Object.assign(new Error('Network Error'), { isAxiosError: true });
        expect(classifyRestoreError(error)).toBe('server.failedToConnectToServer');
    });

    it('maps any other failure to the generic errors.operationFailed', () => {
        expect(classifyRestoreError(new Error('Failed to save credentials'))).toBe('errors.operationFailed');
    });
});
