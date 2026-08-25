import { h as head, c as attr_class, e as escape_html } from "../../../chunks/index.js";
function _page($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    head("1i19ct2", $$renderer2, ($$renderer3) => {
      $$renderer3.title(($$renderer4) => {
        $$renderer4.push(`<title>Connection settings · Watchhouse</title>`);
      });
    });
    $$renderer2.push(`<div class="mx-auto max-w-4xl"><div class="mb-8 flex flex-wrap items-start justify-between gap-4 border-b border-base-300 pb-6"><div><p class="mb-3 text-xs font-semibold tracking-[0.18em] text-base-content/50">PRIVATE CONFIGURATION</p><h1 class="text-4xl font-semibold tracking-tight">Connection settings</h1><p class="mt-3 max-w-2xl text-base-content/65">Configure catalogue search, indexer access, and playback. Passwords and API keys stay on this local server.</p></div><span${attr_class(`text-xs font-semibold tracking-wide ${"text-warning"}`)}>${escape_html("SETUP REQUIRED")}</span></div> `);
    {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> `);
    {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div class="flex justify-center p-16"><span class="loading loading-spinner loading-lg"></span></div>`);
    }
    $$renderer2.push(`<!--]--></div>`);
  });
}
export {
  _page as default
};
