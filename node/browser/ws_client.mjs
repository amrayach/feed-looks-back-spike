const { WsMessageSchema } = await import(
  import.meta.url.startsWith("file:")
    ? "../src/patch_protocol.mjs"
    : "/shared/patch_protocol.mjs"
);

export function buildWebSocketUrl(locationLike = globalThis.location) {
  const protocol = locationLike.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${locationLike.host}/ws`;
}

export function createWsClient({
  WebSocketImpl = globalThis.WebSocket,
  locationLike = globalThis.location,
  run_id,
  mode,
  onPatch = () => {},
  onFeature = () => {},
  onStatus = () => {},
  reconnect = true,
  reconnectDelayMs = 500,
  setTimeoutImpl = globalThis.setTimeout,
} = {}) {
  let reconnectAttempt = 0;
  let closed = false;
  let socket = null;

  function connect() {
    if (closed) return;
    socket = new WebSocketImpl(buildWebSocketUrl(locationLike));
    socket.addEventListener("open", () => {
      reconnectAttempt = 0;
      onStatus({ type: "open" });
      socket.send(JSON.stringify({ type: "hello", run_id, mode }));
    });
    socket.addEventListener("message", (event) => {
      let parsed;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        onStatus({ type: "error", message: "invalid json" });
        return;
      }
      if (parsed?.type === "error") {
        onStatus({ type: "error", message: parsed.message ?? "server error" });
        return;
      }
      const validated = WsMessageSchema.safeParse(parsed);
      if (!validated.success) {
        onStatus({ type: "error", message: "invalid ws payload" });
        return;
      }
      if (validated.data.channel === "patch") onPatch(validated.data.patch);
      if (validated.data.channel === "feature") onFeature(validated.data.feature, validated.data.value);
    });
    socket.addEventListener("close", () => {
      onStatus({ type: "close" });
      if (!closed && reconnect && typeof setTimeoutImpl === "function") {
        const delay = reconnectDelayMs * Math.max(1, reconnectAttempt + 1);
        reconnectAttempt += 1;
        setTimeoutImpl(connect, delay);
      }
    });
  }

  connect();

  return {
    close() {
      closed = true;
      if (socket) socket.close();
    },
  };
}

const isDirectNodeExecution =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  import.meta.url === `file://${process.argv[1]}`;

if (isDirectNodeExecution) {
  const assert = (await import("node:assert/strict")).default;

  let pass = 0;
  let fail = 0;
  function t(desc, fn) {
    try {
      fn();
      pass += 1;
      process.stdout.write(`  ok  ${desc}\n`);
    } catch (err) {
      fail += 1;
      process.stdout.write(`  FAIL ${desc}\n    ${err.message}\n`);
    }
  }

  const instances = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      this.sent = [];
      instances.push(this);
      queueMicrotask(() => this.emit("open"));
    }
    addEventListener(type, handler) {
      const list = this.listeners.get(type) ?? [];
      list.push(handler);
      this.listeners.set(type, list);
    }
    emit(type, payload = {}) {
      for (const handler of this.listeners.get(type) ?? []) handler(payload);
    }
    send(message) {
      this.sent.push(JSON.parse(message));
    }
    close() {
      this.emit("close");
    }
  }

  t("buildWebSocketUrl converts http to ws", () => {
    assert.equal(buildWebSocketUrl({ protocol: "http:", host: "127.0.0.1:3000" }), "ws://127.0.0.1:3000/ws");
  });

  await (async () => {
    try {
      const statuses = [];
      const patches = [];
      const features = [];
      const client = createWsClient({
        WebSocketImpl: FakeWebSocket,
        locationLike: { protocol: "http:", host: "127.0.0.1:3000" },
        run_id: "123",
        mode: "precompute",
        reconnect: false,
        onPatch: (patch) => patches.push(patch),
        onFeature: (feature, value) => features.push([feature, value]),
        onStatus: (event) => statuses.push(event.type),
        setTimeoutImpl: () => {},
      });
      await new Promise((resolvePromise) => queueMicrotask(resolvePromise));
      assert.equal(instances[0].sent[0].type, "hello");
      instances[0].emit("message", {
        data: JSON.stringify({ channel: "patch", patch: { type: "cycle.end" } }),
      });
      instances[0].emit("message", {
        data: JSON.stringify({ channel: "feature", feature: "amplitude", value: 0.4 }),
      });
      assert.equal(statuses[0], "open");
      assert.equal(patches[0].type, "cycle.end");
      assert.deepEqual(features[0], ["amplitude", 0.4]);
      client.close();
      pass += 1;
      process.stdout.write("  ok  createWsClient sends hello and dispatches validated messages\n");
    } catch (err) {
      fail += 1;
      process.stdout.write(`  FAIL createWsClient sends hello and dispatches validated messages\n    ${err.message}\n`);
    }
  })();

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exitCode = 1;
}
