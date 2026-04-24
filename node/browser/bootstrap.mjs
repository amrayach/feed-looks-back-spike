export function parseBootstrapSearch(search) {
  const params = new URLSearchParams(search ?? "");
  const run_id = params.get("run_id");
  const mode = params.get("mode");
  if (!run_id) {
    return { ok: false, error: "missing required query parameter: run_id" };
  }
  if (!/^[A-Za-z0-9_-]+$/.test(run_id)) {
    return { ok: false, error: "run_id contains invalid characters" };
  }
  if (mode !== "precompute" && mode !== "live") {
    return { ok: false, error: "mode must be 'precompute' or 'live'" };
  }
  return {
    ok: true,
    value: Object.freeze({
      run_id,
      mode,
      audio: params.get("audio") === "1",
    }),
  };
}

export function renderBootstrapError(documentLike, message) {
  const body = documentLike?.body ?? documentLike;
  if (!body) return;
  body.innerHTML = "";
  const wrapper = documentLike.createElement ? documentLike.createElement("div") : { style: {}, textContent: "" };
  wrapper.style = wrapper.style ?? {};
  wrapper.style.cssText = [
    "min-height: 100vh",
    "display: flex",
    "align-items: center",
    "justify-content: center",
    "background: #120f0d",
    "color: #f4d9bf",
    "font-family: Georgia, serif",
    "padding: 2rem",
  ].join("; ");
  wrapper.textContent = `Stage bootstrap error: ${message}`;
  body.appendChild(wrapper);
}

export function loadBootstrap({ locationLike = globalThis.location, documentLike = globalThis.document } = {}) {
  const parsed = parseBootstrapSearch(locationLike?.search ?? "");
  if (!parsed.ok) {
    if (documentLike) renderBootstrapError(documentLike, parsed.error);
    throw new Error(parsed.error);
  }
  return parsed.value;
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

  t("parseBootstrapSearch accepts a valid run_id and mode", () => {
    const parsed = parseBootstrapSearch("?run_id=20260423_220000&mode=precompute");
    assert.equal(parsed.ok, true);
    assert.equal(parsed.value.mode, "precompute");
  });

  t("parseBootstrapSearch accepts optional live stage audio flag", () => {
    const parsed = parseBootstrapSearch("?run_id=20260423_220000&mode=live&audio=1");
    assert.equal(parsed.ok, true);
    assert.equal(parsed.value.audio, true);
  });

  t("parseBootstrapSearch rejects missing params", () => {
    const parsed = parseBootstrapSearch("?mode=precompute");
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /run_id/);
  });

  t("loadBootstrap renders a loud error page on failure", () => {
    const documentLike = {
      body: {
        innerHTML: "",
        children: [],
        appendChild(node) {
          this.children.push(node);
        },
      },
      createElement() {
        return { style: {}, textContent: "" };
      },
    };
    assert.throws(
      () => loadBootstrap({ locationLike: { search: "" }, documentLike }),
      /run_id/,
    );
    assert.equal(documentLike.body.children.length, 1);
  });

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exitCode = 1;
}
