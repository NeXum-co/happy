import { stopTestDaemon } from './testDaemon';
import { stopIsolatedRelay } from './isolatedRelay';

async function globalTeardown() {
    await stopTestDaemon();
    await stopIsolatedRelay();
}

export default globalTeardown;
