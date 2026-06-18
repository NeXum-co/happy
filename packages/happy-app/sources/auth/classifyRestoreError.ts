type RestoreErrorKey = 'connect.invalidSecretKey' | 'server.failedToConnectToServer' | 'errors.operationFailed';

// Restore failures land in one catch block but mean very different things. Map
// the error to an honest i18n key so a local crypto/save failure isn't reported
// as "failed to connect to server".
export function classifyRestoreError(error: unknown): RestoreErrorKey {
    const message = error instanceof Error ? error.message : String(error);

    // The token exchange explicitly throws this when the key can't authenticate.
    if (message.includes('authenticate with provided key')) {
        return 'connect.invalidSecretKey';
    }

    // A genuine transport failure (axios marks its errors with isAxiosError).
    if (typeof error === 'object' && error !== null && (error as { isAxiosError?: unknown }).isAxiosError === true) {
        return 'server.failedToConnectToServer';
    }

    // Anything else (credential storage, crypto, unexpected) is a generic failure.
    return 'errors.operationFailed';
}
