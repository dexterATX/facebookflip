// Server-Sent Events: pushes new listings and status to every open dashboard.

export class Hub {
  constructor() {
    this.clients = new Set();
    this.heartbeat = setInterval(() => {
      for (const res of this.clients) res.write(': ping\n\n');
    }, 25000);
    this.heartbeat.unref?.();
  }

  add(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    this.clients.add(res);
    req.on('close', () => this.clients.delete(res));
  }

  send(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) res.write(payload);
  }

  close() {
    clearInterval(this.heartbeat);
    for (const res of this.clients) res.end();
    this.clients.clear();
  }
}
