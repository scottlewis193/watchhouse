import { h as head, b as attr_class, e as escape_html } from "../../../chunks/index.js";
function _page($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    head("1i19ct2", $$renderer2, ($$renderer3) => {
      $$renderer3.title(($$renderer4) => {
        $$renderer4.push(`<title>Settings · Watchhouse</title>`);
      });
    });
    $$renderer2.push(`<div class="settings-page mx-auto max-w-5xl"><div class="page-heading"><div><p class="page-eyebrow">Private configuration</p><h1>Settings</h1><p class="page-intro mt-4">Personalise Watchhouse and configure catalogue search, indexer access, and playback.</p></div><span${attr_class(`text-xs font-semibold tracking-wide ${"text-warning"}`)}>${escape_html("SETUP REQUIRED")}</span></div> `);
    {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> `);
    {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div class="editorial-loading grid place-items-center p-20"><span class="loading loading-spinner loading-lg"></span><p>Loading private settings</p></div>`);
    }
    $$renderer2.push(`<!--]--></div>`);
  });
}
export {
  _page as default
};
