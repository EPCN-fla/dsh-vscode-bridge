/** Transport tests: port scanning, framing, and lifecycle over real TCP. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, createConnection, type Server } from 'node:net'
import { BridgeTcpServer } from '../src/server.ts'

const silent = { info() {}, warn() {}, error() {} }

/** Occupy one loopback port for the duration of the test. */
async function occupyPort(port: number): Promise<Server> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port }, () => resolve())
  })
  return server
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

test('start scans past occupied ports and stop releases the seat', async () => {
  const blocker = await occupyPort(47410)
  try {
    const server = new BridgeTcpServer({
      host: '127.0.0.1',
      portStart: 47410,
      portEnd: 47412,
      logger: silent,
      onLine() {},
      onConnectionClosed() {},
    })
    await server.start()
    assert.equal(server.port, 47411)
    await server.stop()
    // The seat is free again: a second server can bind the same port.
    const again = new BridgeTcpServer({
      host: '127.0.0.1', portStart: 47411, portEnd: 47411,
      logger: silent, onLine() {}, onConnectionClosed() {},
    })
    await again.start()
    assert.equal(again.port, 47411)
    await again.stop()
  } finally {
    await closeServer(blocker)
  }
})

test('start throws when the whole range is occupied', async () => {
  const blockers = await Promise.all([occupyPort(47420), occupyPort(47421)])
  try {
    const server = new BridgeTcpServer({
      host: '127.0.0.1', portStart: 47420, portEnd: 47421,
      logger: silent, onLine() {}, onConnectionClosed() {},
    })
    await assert.rejects(server.start(), /no free port/)
  } finally {
    for (const blocker of blockers) await closeServer(blocker)
  }
})

test('lines are framed, dispatched, and answered; close notifies', async () => {
  const received: string[] = []
  const closed: number[] = []
  const server = new BridgeTcpServer({
    host: '127.0.0.1', portStart: 47430, portEnd: 47439,
    logger: silent,
    onLine: (id, line) => {
      received.push(`${id}:${line}`)
      server.send(id, { echo: JSON.parse(line) })
    },
    onConnectionClosed: (id) => closed.push(id),
  })
  await server.start()
  const socket = createConnection({ host: '127.0.0.1', port: server.port as number })
  const lines: unknown[] = []
  let buffer = ''
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline < 0) break
      lines.push(JSON.parse(buffer.slice(0, newline)))
      buffer = buffer.slice(newline + 1)
    }
  })
  // Two frames in one write; an empty line in between is skipped.
  socket.write('{"a":1}\n\n{"b":2}\n')
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.deepEqual(received, ['1:{"a":1}', '1:{"b":2}'])
  assert.deepEqual(lines, [{ echo: { a: 1 } }, { echo: { b: 2 } }])
  socket.destroy()
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.deepEqual(closed, [1])
  await server.stop()
})

test('an over-long line disconnects the peer', async () => {
  const closed: number[] = []
  const server = new BridgeTcpServer({
    host: '127.0.0.1', portStart: 47440, portEnd: 47449,
    logger: silent, onLine() {}, onConnectionClosed: (id) => closed.push(id),
  })
  await server.start()
  const socket = createConnection({ host: '127.0.0.1', port: server.port as number })
  socket.write('x'.repeat(1024 * 1024 + 1))
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(socket.destroyed, true)
  await server.stop()
})
