// ════════════════════════════════════════════════════════════════
// Config Recipes — preset configurations for quick setup
// ════════════════════════════════════════════════════════════════

import { OPENCLAW_CHANNEL_RECIPES } from './config-store-recipes-openclaw-channels.js';
import { OPENCLAW_PROVIDER_RECIPES } from './config-store-recipes-openclaw-providers.js';
import { OPENCLAW_RUNTIME_RECIPES } from './config-store-recipes-openclaw-runtime.js';
import { OPENCLAW_SYSTEM_RECIPES } from './config-store-recipes-openclaw-system.js';

export const OC_CONFIG_RECIPES = [
  ...OPENCLAW_CHANNEL_RECIPES,
  ...OPENCLAW_PROVIDER_RECIPES,
  ...OPENCLAW_RUNTIME_RECIPES,
  ...OPENCLAW_SYSTEM_RECIPES,
];
