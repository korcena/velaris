/**
 * Unit tests for the fixed decorative map labels
 * (src/components/map/map-labels.ts) and the pure keep-out maths behind them.
 *
 * These labels are cosmetic, but the D2 defect was decorative words half-cut at
 * the viewport edge and sitting on top of house labels. The anchors are fixed,
 * so we can exhaustively verify them against the real generated layouts for the
 * whole separated house range.
 */

import { describe, it, expect } from "vitest";
import {
  coastEnvelope,
  SEPARATED_HOUSE_LIMIT,
  computeIslandLayout,
  type Island,
} from "@/components/map/island-layout";
import {
  MAP_LABELS,
  VISIBLE_LABEL_BAND,
  clipLabel,
  houseRoleLabel,
  HOUSE_NAME_MAX,
  HOUSE_ROLE_MAX,
  HOUSE_NAME_FONT_SIZE,
  HOUSE_ROLE_FONT_SIZE,
  isLabelInsideView,
  labelBox,
  labelHalfExtents,
  labelOverlapsIsland,
  labelOverlapsPlot,
  type MapLabel,
} from "@/components/map/map-labels";
import { DEFAULT_HOUSES } from "@/shared/constants";

function houses(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `house-${String(i).padStart(3, "0")}`,
    createdAt: `2024-01-01T00:00:${String(i % 60).padStart(2, "0")}.${String(i).padStart(3, "0")}Z`,
    kind: i === 0 ? "high_lord" : "agent",
  }));
}

describe("MAP_LABELS catalogue", () => {
  it("is non-empty, uniquely identified, and mixes region + sea labels", () => {
    expect(MAP_LABELS.length).toBeGreaterThan(0);
    expect(new Set(MAP_LABELS.map((l) => l.id)).size).toBe(MAP_LABELS.length);
    expect(MAP_LABELS.some((l) => l.kind === "region")).toBe(true);
    expect(MAP_LABELS.some((l) => l.kind === "sea")).toBe(true);
  });

  it("is frozen against reordering/edits so snapshots stay meaningful", () => {
    // Anchors are curated constants; assert the ids so refactors are explicit.
    expect(MAP_LABELS.map((l) => l.id)).toEqual([
      "aurethil",
      "lanterns",
      "cinder",
      "sablewind",
      "holm",
      "starfall",
      "mistveil",
      "quiet",
    ]);
  });
});

describe("label geometry helpers", () => {
  it("computes a symmetric box around the anchor", () => {
    const label: MapLabel = { id: "x", text: "Hello", x: 100, y: 200, size: 20, kind: "region" };
    const { hw, hh } = labelHalfExtents(label);
    const box = labelBox(label);
    expect(box.x0).toBeCloseTo(100 - hw, 6);
    expect(box.x1).toBeCloseTo(100 + hw, 6);
    expect(box.y0).toBeCloseTo(200 - hh, 6);
    expect(box.y1).toBeCloseTo(200 + hh, 6);
  });

  it("treats near-vertical rotated labels as height-dominant", () => {
    const horizontal: MapLabel = { id: "h", text: "Long Sea Name", x: 0, y: 0, size: 14, kind: "sea" };
    const vertical: MapLabel = { ...horizontal, rotate: -90 };
    const a = labelHalfExtents(horizontal);
    const b = labelHalfExtents(vertical);
    expect(a.hw).toBeGreaterThan(a.hh);
    expect(b.hh).toBeGreaterThan(b.hw);
  });

  it("reports a label overlapping an island's envelope", () => {
    const island: Island = {
      id: "i", slot: 1, houseId: "h", cx: 0, cy: 0, rx: 100, ry: 60,
      seed: 1, rough: 0.2, harmonics: [],
    };
    const onIsland: MapLabel = { id: "on", text: "X", x: 0, y: 0, size: 20, kind: "region" };
    const offshore: MapLabel = { id: "off", text: "X", x: 1000, y: 1000, size: 20, kind: "region" };
    expect(labelOverlapsIsland(onIsland, island)).toBe(true);
    expect(labelOverlapsIsland(offshore, island)).toBe(false);
    expect(coastEnvelope(island)).toBe(1);
  });

  it("reports a label overlapping a house's glyph or label band", () => {
    const plot = { houseId: "h", slot: 1, islandId: "island-1", x: 500, y: 500, sizeVariance: 1 };
    const onGlyph: MapLabel = { id: "g", text: "House", x: 500, y: 500, size: 15, kind: "region" };
    const onBand: MapLabel = { id: "b", text: "House", x: 500, y: 550, size: 15, kind: "region" };
    const clear: MapLabel = { id: "c", text: "House", x: 500, y: 800, size: 15, kind: "region" };
    expect(labelOverlapsPlot(onGlyph, plot)).toBe(true);
    expect(labelOverlapsPlot(onBand, plot)).toBe(true);
    expect(labelOverlapsPlot(clear, plot)).toBe(false);
  });
});

describe("MAP_LABELS do not clip at the default view (D2)", () => {
  it("keeps every label wholly inside the visible band", () => {
    for (const label of MAP_LABELS) {
      expect(isLabelInsideView(label), label.id).toBe(true);
    }
  });

  it("keeps every label clear of every other label", () => {
    for (let i = 0; i < MAP_LABELS.length; i++) {
      for (let j = i + 1; j < MAP_LABELS.length; j++) {
        const a = labelBox(MAP_LABELS[i]);
        const b = labelBox(MAP_LABELS[j]);
        const overlap = a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
        expect(overlap, `${MAP_LABELS[i].id} overlaps ${MAP_LABELS[j].id}`).toBe(false);
      }
    }
  });

  it("uses the whole world (inset 16px) because the default camera contains it", () => {
    // The D4 camera fits the whole 1600×1000 world at every common viewport, so
    // the visible band is the world inset by 16px on each edge — no fixed crop.
    expect(VISIBLE_LABEL_BAND.x0).toBe(16);
    expect(VISIBLE_LABEL_BAND.y0).toBe(16);
    expect(VISIBLE_LABEL_BAND.x1).toBe(1600 - 16);
    expect(VISIBLE_LABEL_BAND.y1).toBe(1000 - 16);
  });
});

describe("MAP_LABELS avoid islands and house labels for 0..limit houses (D2)", () => {
  it("never overlaps a satellite island envelope or any house glyph/label band", () => {
    for (let n = 0; n <= SEPARATED_HOUSE_LIMIT; n++) {
      const layout = computeIslandLayout(houses(n));
      for (const label of MAP_LABELS) {
        for (const island of [...layout.islands, ...layout.islets]) {
          // The heart is a large, mostly-empty landmass: labels may sit on its
          // open interior (that is intentional map lettering). Every satellite
          // island and islet must sit on open ocean instead, and the heart's
          // own house glyph/label is protected by the plot check below.
          if (island.id === "heart") continue;
          expect(
            labelOverlapsIsland(label, island),
            `${label.id} overlaps ${island.id} at N=${n}`,
          ).toBe(false);
        }
        for (const plot of layout.plots) {
          expect(
            labelOverlapsPlot(label, plot),
            `${label.id} overlaps house ${plot.houseId} at N=${n}`,
          ).toBe(false);
        }
      }
    }
  });

  it("keeps every label clear of the heart house's own glyph/label band", () => {
    for (let n = 1; n <= SEPARATED_HOUSE_LIMIT; n++) {
      const layout = computeIslandLayout(houses(n));
      const heart = layout.plots[0]; // slot 0 is the heart
      for (const label of MAP_LABELS) {
        expect(labelOverlapsPlot(label, heart), `${label.id} vs heart at N=${n}`).toBe(false);
      }
    }
  });
});

describe("clipLabel (bounded house labels, word boundaries only — D5)", () => {
  it("leaves short text untouched", () => {
    expect(clipLabel("Day Court", 18)).toBe("Day Court");
  });

  it("truncates long text with an ellipsis and never exceeds the max", () => {
    const long = "A Very Long House Name That Would Sprawl";
    const clipped = clipLabel(long, 18);
    expect(clipped.length).toBeLessThanOrEqual(18);
    expect(clipped.endsWith("…")).toBe(true);
    // The cut lands on a word boundary, never mid-word.
    expect(clipped).toBe("A Very Long…");
  });

  it("never cuts inside a word when a space is available", () => {
    const original = "Shadowsinger of the Night Court";
    const clipped = clipLabel(original, 16);
    expect(clipped.endsWith("…")).toBe(true);
    // The cut point in the original must be a word boundary (not mid-letter).
    const cut = clipped.slice(0, -1).length;
    expect(original[cut] === undefined || original[cut] === " ").toBe(true);
    expect(clipped).toBe("Shadowsinger…");
  });

  it("falls back to a hard cut when there is no space within the budget", () => {
    const clipped = clipLabel("Supercalifragilistic", 10);
    expect(clipped.length).toBeLessThanOrEqual(10);
    expect(clipped.endsWith("…")).toBe(true);
  });

  it("trims trailing whitespace before the ellipsis", () => {
    expect(clipLabel("House of Many Things", 10)).toBe("House of…");
  });
});

describe("houseRoleLabel shows the function, not a mid-word cut (D5)", () => {
  it("drops the description after the middle dot and keeps the function", () => {
    expect(houseRoleLabel("Spell-cleaver · software developer")).toBe("Spell-cleaver");
    expect(houseRoleLabel("Shadowsinger · software tester")).toBe("Shadowsinger");
  });

  it("handles a role that is only a function", () => {
    expect(houseRoleLabel("Orchestrator")).toBe("Orchestrator");
    expect(houseRoleLabel("  Emissary  ")).toBe("Emissary");
  });

  it("word-boundary-clips an over-long function instead of cutting mid-word", () => {
    const label = houseRoleLabel("High Priestess of the Library · technical writer");
    expect(label.length).toBeLessThanOrEqual(HOUSE_ROLE_MAX);
    expect(label.endsWith("…")).toBe(true);
    expect(label).toBe("High Priestess of…");
  });

  it("renders every real default-role function without cutting mid-word", () => {
    for (const def of DEFAULT_HOUSES) {
      const fn = def.agent.role.split("·")[0].trim();
      const label = houseRoleLabel(def.agent.role);
      expect(label.length, def.house.name).toBeLessThanOrEqual(HOUSE_ROLE_MAX);
      expect(label.length, def.house.name).toBeGreaterThan(0);
      // If the function was clipped, the cut must fall on a word boundary in
      // the source (a partial word like "softw…" would be a regression).
      if (label.endsWith("…")) {
        const cut = label.slice(0, -1).length;
        expect(fn[cut] === undefined || fn[cut] === " ", def.house.name).toBe(true);
      }
    }
    // The specific roles the D5 defect reported no longer truncate badly.
    const byName = Object.fromEntries(DEFAULT_HOUSES.map((h) => [h.house.name, h.agent.role]));
    expect(houseRoleLabel(byName["Day Court"])).toBe("Spell-cleaver");
    expect(houseRoleLabel(byName["House of Shadow"])).toBe("Shadowsinger");
    expect(houseRoleLabel(byName["Windhaven"])).toBe("Valkyrie archivist");
    expect(houseRoleLabel(byName["The Library"])).toBe("High Priestess of…");
  });
});

describe("house labels do not collide within the separated range (D2/D5)", () => {
  it("keeps painted name/role labels apart for 0..SEPARATED_HOUSE_LIMIT", () => {
    // Worst-case painted widths from the CSS font sizes and the clip caps.
    const nameHalf = (HOUSE_NAME_MAX * HOUSE_NAME_FONT_SIZE * 0.62) / 2;
    const roleHalf = (HOUSE_ROLE_MAX * HOUSE_ROLE_FONT_SIZE * 0.58) / 2;
    const halfWidth = Math.max(nameHalf, roleHalf);
    for (let n = 0; n <= SEPARATED_HOUSE_LIMIT; n++) {
      const layout = computeIslandLayout(houses(n));
      for (let i = 0; i < layout.plots.length; i++) {
        for (let j = i + 1; j < layout.plots.length; j++) {
          const a = layout.plots[i];
          const b = layout.plots[j];
          const collide =
            Math.abs(a.x - b.x) < halfWidth * 2 &&
            a.y + 72 > b.y + 30 &&
            b.y + 72 > a.y + 30;
          expect(collide, `${a.houseId} vs ${b.houseId} at N=${n}`).toBe(false);
        }
      }
    }
  });
});
