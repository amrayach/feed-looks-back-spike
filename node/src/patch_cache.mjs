import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

import { ElementSpecSchema, CompositionGroupSchema, PatchSchema } from "./patch_protocol.mjs";

const PersistedPatchCacheSchema = z.object({
  background: z
    .object({
      css_background: z.string(),
      fallback_reason: z.string().nullable().optional(),
      original_css_background: z.string().nullable().optional(),
    })
    .nullable(),
  elements: z.array(ElementSpecSchema),
  groups: z.array(CompositionGroupSchema),
});

function clone(value) {
  return structuredClone(value);
}

export function createPatchCache({ persistPath }) {
  const elements = new Map();
  const groups = new Map();
  let background = null;
  let loaded = false;
  let pendingWrite = Promise.resolve();

  async function persist() {
    if (!persistPath) return;
    await mkdir(dirname(persistPath), { recursive: true });
    const snapshot = {
      background,
      elements: [...elements.values()],
      groups: [...groups.values()],
    };
    await writeFile(persistPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  }

  function queuePersist() {
    pendingWrite = pendingWrite.then(persist);
    return pendingWrite;
  }

  function pruneGroups() {
    const activeElementIds = new Set(elements.keys());
    for (const [groupId, group] of groups) {
      const filtered = group.member_element_ids.filter((id) => activeElementIds.has(id));
      if (filtered.length === 0) {
        groups.delete(groupId);
        continue;
      }
      if (filtered.length !== group.member_element_ids.length) {
        groups.set(groupId, {
          ...group,
          member_element_ids: filtered,
        });
      }
    }
  }

  function applyElementUpdate(elementId, changes) {
    const current = elements.get(elementId);
    if (!current) return;
    const next = { ...current };
    for (const [key, value] of Object.entries(changes)) {
      if (key === "content" && value && typeof value === "object" && !Array.isArray(value)) {
        next.content = { ...(next.content ?? {}), ...value };
      } else {
        next[key] = value;
      }
    }
    elements.set(elementId, next);
  }

  return {
    async load() {
      if (loaded) return;
      loaded = true;
      if (!persistPath) return;
      try {
        const raw = await readFile(persistPath, "utf8");
        const parsed = PersistedPatchCacheSchema.safeParse(JSON.parse(raw));
        if (!parsed.success) return;
        background = parsed.data.background;
        for (const element of parsed.data.elements) {
          elements.set(element.element_id, element);
        }
        for (const group of parsed.data.groups) {
          groups.set(group.group_id, group);
        }
      } catch (err) {
        if (err?.code !== "ENOENT") throw err;
      }
    },

    async apply(patch) {
      const parsed = PatchSchema.parse(patch);
      switch (parsed.type) {
        case "background.set":
          background = {
            css_background: parsed.css_background,
            fallback_reason: parsed.fallback_reason ?? null,
            original_css_background: parsed.original_css_background ?? null,
          };
          break;
        case "element.add":
          elements.set(parsed.element.element_id, clone(parsed.element));
          break;
        case "element.update":
          applyElementUpdate(parsed.element_id, parsed.changes);
          break;
        case "element.fade":
        case "element.remove":
          elements.delete(parsed.element_id);
          pruneGroups();
          break;
        case "composition_group.add":
          groups.set(parsed.group.group_id, clone(parsed.group));
          break;
        case "composition_group.fade":
          groups.delete(parsed.group_id);
          for (const memberId of parsed.member_ids) {
            elements.delete(memberId);
          }
          pruneGroups();
          break;
        case "cycle.begin":
        case "cycle.end":
        case "prompt.replace":
        case "replay.begin":
        case "replay.end":
        case "sketch.background.set":
        case "sketch.add":
        case "sketch.retire":
          break;
      }
      await queuePersist();
    },

    getReplayPatches() {
      const patches = [];
      if (background) {
        patches.push({
          type: "background.set",
          css_background: background.css_background,
          fallback_reason: background.fallback_reason ?? null,
          original_css_background: background.original_css_background ?? null,
        });
      }
      for (const element of [...elements.values()].sort((a, b) => a.element_id.localeCompare(b.element_id))) {
        patches.push({ type: "element.add", element: clone(element) });
      }
      for (const group of [...groups.values()].sort((a, b) => a.group_id.localeCompare(b.group_id))) {
        patches.push({ type: "composition_group.add", group: clone(group) });
      }
      return patches;
    },

    size() {
      return (background ? 1 : 0) + elements.size + groups.size;
    },
  };
}

const isDirectNodeExecution =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  import.meta.url === `file://${process.argv[1]}`;

if (isDirectNodeExecution) {
  const assert = (await import("node:assert/strict")).default;
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  let pass = 0;
  let fail = 0;
  async function t(desc, fn) {
    try {
      await fn();
      pass += 1;
      process.stdout.write(`  ok  ${desc}\n`);
    } catch (err) {
      fail += 1;
      process.stdout.write(`  FAIL ${desc}\n    ${err.message}\n`);
    }
  }

  function freshPath(prefix) {
    const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
    return join(root, "patch_cache.json");
  }

  await t("load tolerates missing files", async () => {
    const cache = createPatchCache({ persistPath: freshPath("flb-patch-cache-missing") });
    await cache.load();
    assert.equal(cache.size(), 0);
  });

  await t("apply persists and replay rehydrates current state", async () => {
    const persistPath = freshPath("flb-patch-cache-roundtrip");
    const cache = createPatchCache({ persistPath });
    await cache.load();
    await cache.apply({
      type: "background.set",
      css_background: "linear-gradient(180deg, #111, #000)",
    });
    await cache.apply({
      type: "element.add",
      element: {
        element_id: "elem_0002",
        type: "text",
        content: { content: "after", position: "lower-left", style: "serif, large" },
        lifetime_s: null,
        composition_group_id: null,
      },
    });
    await cache.apply({
      type: "composition_group.add",
      group: {
        group_id: "group_0001",
        group_label: "threshold arrival",
        member_element_ids: ["elem_0002"],
        lifetime_s: null,
      },
    });

    const reloaded = createPatchCache({ persistPath });
    await reloaded.load();
    const replay = reloaded.getReplayPatches();
    assert.equal(replay[0].type, "background.set");
    assert.equal(replay[1].type, "element.add");
    assert.equal(replay[2].type, "composition_group.add");
  });

  await t("fade and remove are omitted from replay output", async () => {
    const cache = createPatchCache({ persistPath: freshPath("flb-patch-cache-fade") });
    await cache.load();
    await cache.apply({
      type: "element.add",
      element: {
        element_id: "elem_0001",
        type: "svg",
        content: { svg_markup: "<svg/>", position: "center", semantic_label: "x" },
        lifetime_s: 35,
        composition_group_id: null,
      },
    });
    await cache.apply({ type: "element.fade", element_id: "elem_0001", duration_ms: 300 });
    assert.deepEqual(cache.getReplayPatches(), []);
  });

  await t("element.update merges content shallowly", async () => {
    const cache = createPatchCache({ persistPath: freshPath("flb-patch-cache-update") });
    await cache.load();
    await cache.apply({
      type: "element.add",
      element: {
        element_id: "elem_0003",
        type: "image",
        content: { query: "threshold light", position: "background", browser_url: null },
        lifetime_s: null,
        composition_group_id: null,
      },
    });
    await cache.apply({
      type: "element.update",
      element_id: "elem_0003",
      changes: { content: { browser_url: "/image_cache/abc.jpg" } },
    });
    const replay = cache.getReplayPatches();
    assert.equal(replay[0].element.content.browser_url, "/image_cache/abc.jpg");
    assert.equal(replay[0].element.content.query, "threshold light");
  });

  process.stdout.write(`\n${pass}/${pass + fail} passed\n`);
  if (fail > 0) process.exitCode = 1;
}
