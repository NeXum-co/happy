/**
 * authProxy — localhost-only forward-proxy die per cloud-sessie het echte
 * account-OAuth-token injecteert. Een routing-key (binnenkomende Bearer) mapt
 * naar { account, realToken }; de proxy swapt de Bearer, garandeert de
 * oauth-beta-flag (D-E10-11: zonder → 429), stript x-api-key en forward+streamt
 * naar upstream (default api.anthropic.com). De echte tokens verlaten de daemon
 * nooit via de sessie-env (AC-7). Usage-scraping van unified-* headers volgt in S4.
 */
import http from 'node:http'
import https from 'node:https'
import type { AddressInfo } from 'node:net'

export interface AccountRoute { account: string; realToken: string }

export interface AuthProxy {
  readonly port: number
  register(routingKey: string, route: AccountRoute): void
  remap(routingKey: string, route: AccountRoute): void
  unregister(routingKey: string): void
  stop(): void
}

export interface AuthProxyOptions {
  upstreamHost?: string
  upstreamPort?: number
  upstreamProtocol?: 'http' | 'https'
  /** S4: per response het account + de upstream-headers melden (usage-scrape). De proxy
   * blijft dom — de daemon bedraadt dit naar usageStore.record (D-E10-14). */
  onResponse?: (account: string, headers: http.IncomingHttpHeaders) => void
}

const OAUTH_BETA = 'oauth-2025-04-20'

export function startAuthProxy(opts: AuthProxyOptions = {}): Promise<AuthProxy> {
  const upstreamHost = opts.upstreamHost ?? 'api.anthropic.com'
  const upstreamPort = opts.upstreamPort ?? 443
  const transport = (opts.upstreamProtocol ?? 'https') === 'http' ? http : https
  const routes = new Map<string, AccountRoute>()

  const server = http.createServer((req, res) => {
    const routingKey = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '')
    const route = routes.get(routingKey)
    if (!route) {
      res.writeHead(401, { 'content-type': 'text/plain' })
      res.end('unknown routing key')
      return
    }

    const headers: http.IncomingHttpHeaders = { ...req.headers, host: upstreamHost, authorization: `Bearer ${route.realToken}` }
    delete headers['x-api-key']
    const existing = headers['anthropic-beta']
    headers['anthropic-beta'] = existing
      ? (String(existing).includes('oauth-') ? existing : `${existing},${OAUTH_BETA}`)
      : OAUTH_BETA
    delete headers['content-length'] // laat de transport hercoderen

    const up = transport.request(
      { hostname: upstreamHost, port: upstreamPort, path: req.url, method: req.method, headers },
      upRes => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers)
        opts.onResponse?.(route.account, upRes.headers) // S4: usage-scrape, proxy blijft dom
        upRes.pipe(res) // streaming, geen buffering
      },
    )
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('upstream error') })
    req.pipe(up) // streaming request-body door
  })

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({
        port,
        register: (k, r) => { routes.set(k, r) },
        remap: (k, r) => { routes.set(k, r) },
        unregister: k => { routes.delete(k) },
        stop: () => { server.close() },
      })
    })
  })
}
