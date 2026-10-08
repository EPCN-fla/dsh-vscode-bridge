/**
 * Transport layer: a newline-delimited JSON TCP server that scans a port
 * range for a free seat. Framing and socket lifecycle live here; parsing,
 * auth, and dispatch live in the bridge core.
 *
 * @module dsh-vscode-bridge/server
 */

import { createServer, type Server, type Socket } from 'node:net'
import { StringDecoder } from 'node:string_decoder'

/** Longest accepted single line; a peer exceeding it is disconnected. */
export const MAX_LINE_BYTES = 1024 * 1024

/** Minimal logger shape the transport reports through. */
export interface BridgeTransportLogger {
  info(message: string): void
  warn(message: string): void
  error?(message: string): void
}

export interface BridgeTcpServerOptions {
  /** Bind address. Loopback only — the token file is the access boundary. */
  readonly host: string
  /** First port tried (inclusive). */
  readonly portStart: number
  /** Last port tried (inclusive). */
  readonly portEnd: number
  readonly logger: BridgeTransportLogger
  /** Called once per complete inbound line. May be async; ordering is not awaited. */
  readonly onLine: (connectionId: number, line: string) => void
  /** Called when a connection goes away, for subscription cleanup. */
  readonly onConnectionClosed: (connectionId: number) => void
}

interface ConnectionState {
  readonly socket: Socket
  /**
   * Incremental UTF-8 decoder: a TCP chunk boundary may split a multibyte
   * character, and decoding chunks independently would corrupt it into
   * replacement characters (CJK session titles cross this channel).
   */
  readonly decoder: StringDecoder
  buffer: string
  /**
   * Undispatched bytes, counted on arrival. Decoded length undercounts
   * multibyte text, so the line limit is enforced on the wire bytes.
   */
  pendingBytes: number
}

/**
 * One JSON-RPC-over-TCP listener. `start()` occupies the first free port in
 * the configured range so several harness processes (one per editor window)
 * coexist without coordination.
 */
export class BridgeTcpServer {
  private server: Server | undefined
  private readonly connections = new Map<number, ConnectionState>()
  private nextConnectionId = 1
  private activePort: number | undefined
  private readonly options: BridgeTcpServerOptions

  constructor(options: BridgeTcpServerOptions) {
    this.options = options
  }

  /** The occupied port after a successful {@link start}, else `undefined`. */
  get port(): number | undefined {
    return this.activePort
  }

  /** Live connection ids, for subscription-aware sends. */
  get connectionIds(): readonly number[] {
    return [...this.connections.keys()]
  }

  /**
   * Bind the first free port in `[portStart, portEnd]`.
   * @throws when every candidate is occupied or a non-conflict error occurs.
   */
  async start(): Promise<void> {
    if (this.server !== undefined) throw new Error('bridge TCP server already started')
    const failures: string[] = []
    for (let port = this.options.portStart; port <= this.options.portEnd; port += 1) {
      try {
        this.server = await this.listen(port)
        this.activePort = port
        this.options.logger.info(`dsh-vscode-bridge: listening on ${this.options.host}:${port}`)
        return
      } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EADDRINUSE' && code !== 'EACCES') throw error
        failures.push(`${port}: ${code}`)
      }
    }
    throw new Error(
      `dsh-vscode-bridge: no free port in ${this.options.portStart}-${this.options.portEnd} (${failures.join(', ')})`,
    )
  }

  /**
   * Send one framed payload to a live connection.
   * @returns `false` when the connection is gone or the write failed.
   */
  send(connectionId: number, payload: unknown): boolean {
    const connection = this.connections.get(connectionId)
    if (connection === undefined || connection.socket.destroyed) return false
    try {
      connection.socket.write(`${JSON.stringify(payload)}\n`)
      return true
    } catch (error: unknown) {
      this.options.logger.warn(`dsh-vscode-bridge: write to connection ${connectionId} failed: ${String(error)}`)
      return false
    }
  }

  /** Close every connection and release the port. Idempotent. */
  async stop(): Promise<void> {
    for (const connection of this.connections.values()) connection.socket.destroy()
    this.connections.clear()
    const server = this.server
    this.server = undefined
    this.activePort = undefined
    if (server === undefined) return
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      // close() waits for connections; they were destroyed above, so this settles.
    })
  }

  private listen(port: number): Promise<Server> {
    return new Promise<Server>((resolve, reject) => {
      const server = createServer((socket) => this.accept(socket))
      server.unref()
      const onError = (error: Error): void => {
        server.removeAllListeners()
        reject(error)
      }
      server.once('error', onError)
      server.listen({ host: this.options.host, port }, () => {
        server.removeListener('error', onError)
        server.on('error', (error) => {
          this.options.logger.warn(`dsh-vscode-bridge: listener error: ${String(error)}`)
        })
        resolve(server)
      })
    })
  }

  private accept(socket: Socket): void {
    socket.unref()
    const connectionId = this.nextConnectionId
    this.nextConnectionId += 1
    const connection: ConnectionState = { socket, decoder: new StringDecoder('utf8'), buffer: '', pendingBytes: 0 }
    this.connections.set(connectionId, connection)
    socket.setNoDelay(true)
    socket.on('data', (chunk: Buffer) => this.onData(connectionId, connection, chunk))
    const drop = (): void => {
      if (this.connections.delete(connectionId)) {
        this.options.onConnectionClosed(connectionId)
      }
      socket.destroy()
    }
    socket.on('close', drop)
    socket.on('error', () => drop())
  }

  private onData(connectionId: number, connection: ConnectionState, chunk: Buffer): void {
    connection.pendingBytes += chunk.length
    if (connection.pendingBytes > MAX_LINE_BYTES) {
      this.options.logger.warn(`dsh-vscode-bridge: connection ${connectionId} exceeded the line limit; disconnecting`)
      connection.socket.destroy()
      return
    }
    connection.buffer += connection.decoder.write(chunk)
    for (;;) {
      const newline = connection.buffer.indexOf('\n')
      if (newline < 0) return
      const raw = connection.buffer.slice(0, newline)
      connection.buffer = connection.buffer.slice(newline + 1)
      // Valid UTF-8 re-encodes to the same bytes, so this settles the frame's
      // share exactly; a `\r\n` sender's `\r` stays inside `raw` and is
      // accounted for here.
      connection.pendingBytes -= Buffer.byteLength(raw, 'utf8') + 1
      const line = raw.trim()
      if (line.length === 0) continue
      try {
        this.options.onLine(connectionId, line)
      } catch (error: unknown) {
        // Dispatch must be async/throw-safe; this guard keeps one bad line
        // from killing the connection loop.
        this.options.logger.warn(`dsh-vscode-bridge: dispatch threw synchronously: ${String(error)}`)
      }
    }
  }
}
