import { a3 as head, a4 as attr_class, a6 as escape_html } from '../../../chunks/index.js-BDRgBx0K.js';
import '../../../chunks/utils.js-DNDl--Fb.js';
import '../../../chunks/utils2.js-BQzn9ikS.js';

function _page($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    head("1i19ct2", $$renderer2, ($$renderer3) => {
      $$renderer3.title(($$renderer4) => {
        $$renderer4.push(`<title>Settings · Watchhouse</title>`);
      });
    });
    $$renderer2.push(`<div class="settings-page mx-auto max-w-5xl"><div class="page-tools"><span class="page-eyebrow">Private configuration</span><span${attr_class(`text-xs font-semibold tracking-wide ${"text-warning"}`)}>${escape_html("SETUP REQUIRED")}</span></div> `);
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

export { _page as default };
//# sourceMappingURL=_page.svelte.js-JA7bayKN.js.map
