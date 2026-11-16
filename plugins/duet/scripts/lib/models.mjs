// Model catalog for duet-workbench: the live list from Codex first, models.json as the dated fallback.
// Nothing here is a whitelist; unknown models and efforts are passed through to Codex.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { listCodexModels } from "./codex.mjs";

const CATALOG_PATH = fileURLToPath(new URL("../../models.json", import.meta.url));

export function readFallbackCatalog(catalogPath = CATALOG_PATH) {
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  return {
    source: "fallback",
    checked: catalog.checked ?? null,
    aliases: catalog.aliases ?? {},
    models: (catalog.models ?? []).map((model) => ({
      id: model.id,
      displayName: model.displayName ?? model.id,
      description: model.description ?? null,
      isDefault: Boolean(model.isDefault),
      efforts: model.efforts ?? [],
      defaultEffort: model.defaultEffort ?? null
    }))
  };
}

export function resolveModelAlias(name, catalogPath = CATALOG_PATH) {
  const aliases = readFallbackCatalog(catalogPath).aliases;
  return aliases[String(name).toLowerCase()] ?? name;
}

export async function loadModelCatalog(cwd, { list = listCodexModels, catalogPath = CATALOG_PATH } = {}) {
  const fallback = readFallbackCatalog(catalogPath);
  try {
    const live = (await list(cwd)).filter((model) => !model.hidden);
    if (live.length === 0) {
      return fallback;
    }
    return {
      source: "codex",
      checked: new Date().toISOString().slice(0, 10),
      aliases: fallback.aliases,
      models: live.map((model) => ({
        id: model.id,
        displayName: model.displayName ?? model.id,
        description: model.description ?? null,
        isDefault: Boolean(model.isDefault),
        efforts: (model.supportedReasoningEfforts ?? []).map((entry) => entry.reasoningEffort),
        defaultEffort: model.defaultReasoningEffort ?? null
      }))
    };
  } catch {
    return fallback;
  }
}

// One line appended to a failed run that named a model or effort.
export function describeValidChoices(model, catalogPath = CATALOG_PATH) {
  const catalog = readFallbackCatalog(catalogPath);
  const known = catalog.models.find((entry) => entry.id === model) ?? catalog.models.find((entry) => entry.isDefault);
  const parts = [
    `Known models (${catalog.checked}): ${catalog.models.map((entry) => entry.id).join(", ")}; aliases: ${Object.keys(catalog.aliases).join(", ")}.`
  ];
  if (known?.efforts.length) {
    parts.push(`Efforts for ${known.id}: ${known.efforts.join(", ")}.`);
  }
  return parts.join(" ");
}

export function renderModelCatalog(catalog) {
  const lines = [`Models (source: ${catalog.source}, checked ${catalog.checked}):`];
  for (const model of catalog.models) {
    lines.push(`- ${model.id}${model.isDefault ? " (default)" : ""}: ${model.efforts.join(", ") || "efforts unknown"}`);
  }
  const aliases = Object.entries(catalog.aliases).map(([alias, id]) => `${alias} → ${id}`);
  if (aliases.length) {
    lines.push(`Aliases: ${aliases.join(", ")}`);
  }
  return `${lines.join("\n")}\n`;
}
