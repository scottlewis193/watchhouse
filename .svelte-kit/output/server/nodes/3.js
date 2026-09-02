

export const index = 3;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/pages/downloads/_page.svelte.js')).default;
export const imports = ["entries/pages/downloads/_page.svelte.js","chunks/index.js"];
export const stylesheets = ["_app/immutable/assets/_page.uminNjQs.css"];
export const fonts = [];
