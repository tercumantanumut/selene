import * as http from "node:http";
import * as http2 from "node:http2";
import { debugLog, debugError } from "./debug-logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface H2ProxyOptions {
  cert: string;
  key: string;
  listenPort: number;
  targetPort: number;
}

// ---------------------------------------------------------------------------
// HTTP/2 pseudo-headers that must not be forwarded to HTTP/1.1 upstream
// ---------------------------------------------------------------------------

const H2_PSEUDO_HEADERS = new Set([":method", ":path", ":authority", ":scheme", ":status"]);

// HTTP/1.1 hop-by-hop headers that are illegal in HTTP/2 (RFC 9113 §8.2.2).
// These come from the upstream Next.js server and must be stripped before
// forwarding to an HTTP/2 client, or Node throws ERR_HTTP2_INVALID_CONNECTION_HEADERS.
const H1_HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "http2-settings",
]);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let server: http2.Http2SecureServer | null = null;
const activeSessions = new Set<http2.ServerHttp2Session>();

// ---------------------------------------------------------------------------
// Proxy implementation
// ---------------------------------------------------------------------------

/**
 * Start an HTTP/2 reverse proxy that forwards all requests to the
 * upstream Next.js server running on targetPort.
 *
 * Chromium negotiates HTTP/2 via ALPN, multiplexing ~100 streams
 * over a single TCP connection — eliminating the 6-connection limit.
 */
export function startH2Proxy(opts: H2ProxyOptions): http2.Http2SecureServer {
  const { cert, key, listenPort, targetPort } = opts;

  if (server) {
    debugLog("[H2Proxy] Proxy already running, stopping previous instance");
    stopH2Proxy();
  }

  server = http2.createSecureServer({
    cert,
    key,
    allowHTTP1: true,
    // Increase max concurrent streams — Chromium defaults to 100, match that.
    settings: { maxConcurrentStreams: 128 },
    // Disable HTTP/2 session idle timeout — SSE and chat streams can run for hours.
    peerMaxConcurrentStreams: 128,
  });

  // Disable all server-level timeouts to support long-lived SSE/streaming
  // connections (agent SDK sub-agents can run 1-3 hours).
  server.setTimeout(0);
  // @ts-expect-error — requestTimeout exists on Http2Server in Node 18+
  if (typeof server.requestTimeout === "number") server.requestTimeout = 0;

  server.on("request", (req: http2.Http2ServerRequest, res: http2.Http2ServerResponse) => {
    debugLog(`[H2Proxy] → ${req.method} ${req.url} (HTTP/${req.httpVersion})`);

    // Build upstream headers: strip HTTP/2 pseudo-headers, override host.
    const upstreamHeaders: http.OutgoingHttpHeaders = {};

    for (const [name, value] of Object.entries(req.headers)) {
      if (H2_PSEUDO_HEADERS.has(name)) continue;
      upstreamHeaders[name] = value;
    }

    upstreamHeaders["host"] = `localhost:${targetPort}`;

    const proxyReq = http.request(
      {
        hostname: "127.0.0.1",
        port: targetPort,
        method: req.method,
        path: req.url,
        headers: upstreamHeaders,
        // Disable socket timeout — SSE/streaming connections can run for hours.
        timeout: 0,
      },
      (proxyRes: http.IncomingMessage) => {
        const statusCode = proxyRes.statusCode ?? 502;
        const responseHeaders: http.OutgoingHttpHeaders = {};
        const isH2 = req.httpVersion === "2.0" || req.httpVersion === "2";

        for (const [name, value] of Object.entries(proxyRes.headers)) {
          const lower = name.toLowerCase();
          if (!isH2) {
            responseHeaders[name] = value;
            continue;
          }
          // Strip hop-by-hop headers illegal in HTTP/2
          if (H1_HOP_BY_HOP_HEADERS.has(lower)) continue;
          // RFC 9113 §8.2.2: `te` is only allowed with value "trailers"
          if (lower === "te" && value !== "trailers") continue;
          responseHeaders[name] = value;
        }

        res.writeHead(statusCode, responseHeaders);
        proxyRes.pipe(res);

        // Handle upstream reset mid-stream (e.g., Next.js crashes while
        // sending a response). Without this handler the error is uncaught
        // and could crash the Electron main process.
        // Note: clientDisconnected is set before we destroy proxyReq/proxyRes,
        // so errors triggered by our own teardown are silently swallowed here.
        proxyRes.on("error", (err) => {
          if (res.destroyed || clientDisconnected) return;
          debugError("[H2Proxy] Upstream response stream error:", err.message);
          res.end();
        });

        // Track the active upstream response so the close handler can tear it down.
        activeProxyRes = proxyRes;
      },
    );

    // Handle upstream connection errors (server down, refused, etc.)
    proxyReq.on("error", (err: NodeJS.ErrnoException) => {
      if (res.destroyed || clientDisconnected) return;
      debugError("[H2Proxy] Upstream request error:", err.message);
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain" });
      }
      res.end();
    });

    // If the client disconnects early, cleanly tear down the upstream pipeline.
    // Do not use req "close" for this: on HTTP/2 GET/SSE requests the request
    // side can close as soon as headers/body are consumed while the response
    // stream is still meant to stay open.
    let clientDisconnected = false;
    let activeProxyRes: http.IncomingMessage | null = null;
    const teardownUpstream = () => {
      clientDisconnected = true;
      if (!proxyReq.destroyed) {
        proxyReq.destroy();
      }
      if (activeProxyRes && !activeProxyRes.destroyed) {
        activeProxyRes.destroy();
      }
    };
    req.on("aborted", teardownUpstream);

    // Pipe client request body → upstream without buffering.
    req.pipe(proxyReq);
  });

  // -------------------------------------------------------------------------
  // WebSocket upgrade — proxies HMR, live-reload, and any WS connections.
  // -------------------------------------------------------------------------
  server.on("upgrade", (req, socket, head) => {
    // Strip HTTP/2 pseudo-headers (same as the request handler) — they are
    // illegal in HTTP/1.1 and would produce a malformed upstream request.
    const upstreamHeaders: Record<string, string | string[] | undefined> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (H2_PSEUDO_HEADERS.has(name)) continue;
      upstreamHeaders[name] = value as string | string[] | undefined;
    }
    upstreamHeaders["host"] = `localhost:${targetPort}`;

    const proxyReq = http.request({
      hostname: "127.0.0.1",
      port: targetPort,
      path: req.url,
      method: req.method,
      headers: upstreamHeaders,
    });

    proxyReq.on("upgrade", (_proxyRes, proxySocket, proxyHead) => {
      // Forward the 101 Switching Protocols response
      const headerLines = Object.entries(_proxyRes.headers)
        .map(([k, v]) => `${k}: ${String(v).replace(/[\r\n]/g, "")}`)
        .join("\r\n");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headerLines}\r\n\r\n`);

      // Flush any buffered data from both sides before piping
      if (proxyHead.length) socket.write(proxyHead);
      if (head.length) proxySocket.write(head);

      proxySocket.pipe(socket);
      socket.pipe(proxySocket);

      // Ensure both sockets are destroyed when either side closes/errors
      proxySocket.on("error", () => socket.destroy());
      proxySocket.on("close", () => socket.destroy());
      socket.on("close", () => proxySocket.destroy());
    });

    proxyReq.on("error", (err) => {
      debugError("[H2Proxy] WebSocket upstream error:", err.message);
      socket.destroy();
    });

    socket.on("error", () => proxyReq.destroy());

    proxyReq.end();
  });

  // Log session-level errors (e.g., framing errors, GOAWAY).
  server.on("sessionError", (err: Error) => {
    debugError("[H2Proxy] Session error:", err.message);
  });

  server.on("session", (session) => {
    activeSessions.add(session);
    // Disable session-level timeout — long-lived SSE streams must survive.
    session.setTimeout(0);
    // Send HTTP/2 PING frames every 60s to keep the session alive and detect
    // dead connections. Without this, macOS can silently close idle TCP sockets.
    const pingTimer = setInterval(() => {
      if (session.closed || session.destroyed) {
        clearInterval(pingTimer);
        return;
      }
      try {
        session.ping(Buffer.alloc(8), (err) => {
          if (err) {
            debugError("[H2Proxy] Session ping failed:", err.message);
            clearInterval(pingTimer);
          }
        });
      } catch {
        clearInterval(pingTimer);
      }
    }, 60_000);
    session.once("close", () => {
      clearInterval(pingTimer);
      activeSessions.delete(session);
    });
  });

  server.on("error", (err: Error) => {
    debugError("[H2Proxy] Server error:", err.message);
  });

  // Bind to IPv4 loopback only. All consumers (renderer, IPC handlers,
  // internal API calls) connect via 127.0.0.1 explicitly — no IPv6 needed.
  server.listen(listenPort, "127.0.0.1", () => {
    debugLog(`[H2Proxy] HTTP/2 reverse proxy listening on https://127.0.0.1:${listenPort} → http://localhost:${targetPort}`);
  });

  return server;
}

/**
 * Stop the HTTP/2 proxy server and force-close existing connections.
 */
export function stopH2Proxy(): void {
  if (!server) return;

  debugLog("[H2Proxy] Stopping HTTP/2 proxy server");
  // Some Electron/Node builds expose closeAllConnections, some don't.
  // Use it when available, otherwise force-close tracked HTTP/2 sessions.
  const maybeServer = server as unknown as { closeAllConnections?: () => void };
  if (typeof maybeServer.closeAllConnections === "function") {
    maybeServer.closeAllConnections();
  } else {
    for (const session of activeSessions) {
      try {
        session.destroy();
      } catch {
        // ignore
      }
    }
    activeSessions.clear();
  }
  server.close();
  server = null;
}
