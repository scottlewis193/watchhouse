

export const index = 2;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/pages/_page.svelte.js')).default;
export const imports = ["entries/pages/_page.svelte.js","chunks/index.js","chunks/state.svelte.js","chunks/exports.js","chunks/root.js","chunks/utils2.js"];
export const stylesheets = [];
export const fonts = [];
