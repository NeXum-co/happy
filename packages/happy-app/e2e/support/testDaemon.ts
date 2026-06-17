// Isolated test daemon lifecycle (Slice B). Starts a happy daemon with its own HAPPY_HOME_DIR
// (never the live ~/.happy), seeded with dummy-account metadata, registered as a FRESH machine on
// the local relay so the E10 account screens get real-but-safe RPC data. Implemented in Slice B.
//
// NOTE: only invoked when a credential is present (globalSetup). Slice A runs credential-free smoke
// (boot.spec.ts) and never reaches here.

export async function startTestDaemon(): Promise<{ machineId: string }> {
    throw new Error('startTestDaemon: not yet implemented (E2E Slice B). Run only credential-free smoke for now.');
}

export async function stopTestDaemon(): Promise<void> {
    // no-op until Slice B
}
