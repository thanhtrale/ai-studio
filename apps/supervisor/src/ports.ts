import net from 'node:net';

function probe(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen({ host, port: 0, exclusive: true }, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('could not determine an allocated port')));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Hands out loopback ports for resident arms. Ports stay reserved for the
 * lifetime of the process that was given one so a restart cannot hand the same
 * port to two arms while the first is still binding.
 */
export class PortAllocator {
  readonly #reserved = new Set<number>();
  readonly #host: string;

  constructor(host: string) {
    this.#host = host;
  }

  async allocate(): Promise<number> {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const port = await probe(this.#host);
      if (!this.#reserved.has(port)) {
        this.#reserved.add(port);
        return port;
      }
    }
    throw new Error('could not allocate an unused loopback port');
  }

  release(port: number): void {
    this.#reserved.delete(port);
  }

  /** Marks a port as taken without probing, used when adopting a live process. */
  reserve(port: number): void {
    this.#reserved.add(port);
  }

  get reserved(): ReadonlySet<number> {
    return this.#reserved;
  }
}
