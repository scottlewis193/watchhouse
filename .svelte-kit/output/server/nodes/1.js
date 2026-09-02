

export const index = 1;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/fallbacks/error.svelte.js')).default;
export const imports = ["entries/fallbacks/error.svelte.js","chunks/index.js","chunks/index2.js","chunks/state.svelte.js","chunks/exports.js","chunks/root.js","chunks/utils2.js"];
export const stylesheets = [];
export const fonts = [];
