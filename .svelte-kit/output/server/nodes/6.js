

export const index = 6;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/pages/watch/_type_/_id_/_page.svelte.js')).default;
export const imports = ["entries/pages/watch/_type_/_id_/_page.svelte.js","chunks/index.js","chunks/exports.js","chunks/utils2.js","chunks/root.js","chunks/state.svelte.js","chunks/index2.js","chunks/offline.js"];
export const stylesheets = ["_app/immutable/assets/_page.Cl9Jpcbi.css"];
export const fonts = [];
