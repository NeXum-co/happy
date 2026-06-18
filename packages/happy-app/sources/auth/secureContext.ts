import { Platform } from 'react-native';

// WebCrypto only exists in secure contexts (https/localhost); restore login fails deep inside sync without it.
export function isWebInsecureContext(): boolean {
    return Platform.OS === 'web' && !globalThis.crypto?.subtle;
}
