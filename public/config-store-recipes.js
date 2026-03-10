// ════════════════════════════════════════════════════════════════
// Config Recipes — preset configurations for quick setup
// ════════════════════════════════════════════════════════════════

import { CODEX_CONFIG_RECIPES } from './config-store-recipes-codex.js';
import { OC_CONFIG_RECIPES } from './config-store-recipes-openclaw.js';

export { CODEX_CONFIG_RECIPES, OC_CONFIG_RECIPES };

export function getConfigStoreRecipesByTool(tool = 'codex') {
  return tool === 'openclaw' ? OC_CONFIG_RECIPES : CODEX_CONFIG_RECIPES;
}

export function getAllConfigStoreRecipes() {
  return [...CODEX_CONFIG_RECIPES, ...OC_CONFIG_RECIPES];
}
