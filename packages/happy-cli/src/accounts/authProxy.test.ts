import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import { startAuthProxy, type AuthProxy } from '@/accounts/authProxy'

// Mock-upstream: vangt elke request, echoot wat de proxy injecteerde + een unified-* header,
// en streamt twee chunks (SSE-achtig) zodat we passthrough/streaming kunnen verifiëren.
function startMockUpstream(): Promise<{ port: number; lastReq: () => http.IncomingMessage; stop: () => void }> {
  let last: http.IncomingMessage
  const srv = http.createServer((req, res) => {
    last = req
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'anthropic-ratelimit-unified-5h-utilization': '0.42',
    })
    res.write('data: chunk1\n\n')
    setTimeout(() => { res.write('data: chunk2\n\n'); res.end() }, 10)
  })
  return new Promise(resolve => srv.listen(0, '127.0.0.1', () => {
    const port = (srv.address() as import('node:net').AddressInfo).port
    resolve({ port, lastReq: () => last, stop: () => srv.close() })
  }))
}

async function post(port: number, token: string): Promise<{ status: number; chunks: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/v1/messages', method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'x-api-key': 'LEAK', 'content-type': 'application/json' } }, res => {
      let chunks = 0
      res.on('data', () => { chunks++ })
      res.on('end', () => resolve({ status: res.statusCode!, chunks, headers: res.headers }))
    })
    req.on('error', reject)
    req.end('{"model":"x"}')
  })
}

describe('authProxy', () => {
  let proxy: AuthProxy | undefined
  let up: Awaited<ReturnType<typeof startMockUpstream>> | undefined
  afterEach(() => { proxy?.stop(); up?.stop() })

  it('injecteert echte Bearer + oauth-beta, stript x-api-key, streamt incrementeel (AC-2/D-E10-11)', async () => {
    up = await startMockUpstream()
    proxy = await startAuthProxy({ upstreamHost: '127.0.0.1', upstreamPort: up.port, upstreamProtocol: 'http' })
    proxy.register('rk-1', { account: 'work', realToken: 'sk-ant-oat01-REAL' })

    const r = await post(proxy.port, 'rk-1')
    const seen = up.lastReq()
    expect(seen.headers['authorization']).toBe('Bearer sk-ant-oat01-REAL')
    expect(String(seen.headers['anthropic-beta'])).toContain('oauth-2025-04-20')
    expect(seen.headers['x-api-key']).toBeUndefined()
    expect(r.status).toBe(200)
    expect(r.chunks).toBeGreaterThanOrEqual(2) // niet gebufferd tot één chunk
    expect(r.headers['anthropic-ratelimit-unified-5h-utilization']).toBe('0.42') // S4-naad: header komt door
  })

  it('onbekende routing-key → 401, geen upstream-call (AC-6)', async () => {
    up = await startMockUpstream()
    proxy = await startAuthProxy({ upstreamHost: '127.0.0.1', upstreamPort: up.port, upstreamProtocol: 'http' })
    const r = await post(proxy.port, 'rk-onbekend')
    expect(r.status).toBe(401)
  })

  it('remap wijzigt het echte token voor een lopende key (AC-4-naad)', async () => {
    up = await startMockUpstream()
    proxy = await startAuthProxy({ upstreamHost: '127.0.0.1', upstreamPort: up.port, upstreamProtocol: 'http' })
    proxy.register('rk-1', { account: 'a', realToken: 'sk-ant-oat01-A' })
    proxy.remap('rk-1', { account: 'b', realToken: 'sk-ant-oat01-B' })
    await post(proxy.port, 'rk-1')
    expect(up.lastReq().headers['authorization']).toBe('Bearer sk-ant-oat01-B')
  })

  it('unregister verwijdert de route → de key gedraagt zich als onbekend (401), token niet meer injecteerbaar (QUAL-001)', async () => {
    up = await startMockUpstream()
    proxy = await startAuthProxy({ upstreamHost: '127.0.0.1', upstreamPort: up.port, upstreamProtocol: 'http' })
    proxy.register('rk-1', { account: 'work', realToken: 'sk-ant-oat01-REAL' })
    expect((await post(proxy.port, 'rk-1')).status).toBe(200) // gebonden → forward
    proxy.unregister('rk-1') // wat de daemon nu op sessie-exit doet (run.ts releaseProxyBinding)
    const r = await post(proxy.port, 'rk-1')
    expect(r.status).toBe(401) // de ontsleutelde token is uit de proxy-Map weg, geen upstream-call
  })

  it('onResponse vuurt per response met account + scraped unified-header (S4/AC-5)', async () => {
    up = await startMockUpstream()
    const seen: Array<{ account: string; util: unknown }> = []
    proxy = await startAuthProxy({
      upstreamHost: '127.0.0.1', upstreamPort: up.port, upstreamProtocol: 'http',
      onResponse: (account, headers) => seen.push({ account, util: headers['anthropic-ratelimit-unified-5h-utilization'] }),
    })
    proxy.register('rk-1', { account: 'work', realToken: 'sk-ant-oat01-REAL' })
    await post(proxy.port, 'rk-1')
    expect(seen).toEqual([{ account: 'work', util: '0.42' }])
  })
})
