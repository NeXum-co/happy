import { stopTestDaemon } from './testDaemon';

async function globalTeardown() {
    await stopTestDaemon();
}

export default globalTeardown;
