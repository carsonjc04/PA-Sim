import type { Server } from 'node:http'
import type { RequestListener } from 'node:http'
import { createServer } from 'node:http'

const servers: Server[] = []

/**
 * Starts one server for an app, bound to 127.0.0.1. Pass the result to supertest's request().
 *
 * supertest's default (`request(app)`) opens a fresh server on the IPv6 wildcard for every request.
 * On macOS another local process can hold the same port on 127.0.0.1, so an occasional request
 * reaches that process instead (seen as stray 401/404 responses). A listening server is used as-is.
 */
export async function listenLocal(app: RequestListener): Promise<Server> {
  const server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  return server
}

export async function closeLocalServers(): Promise<void> {
  const open = servers.splice(0)
  await Promise.all(open.map((s) => new Promise((resolve) => s.close(resolve))))
}
