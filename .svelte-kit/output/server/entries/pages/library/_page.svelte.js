import { h as head, e as escape_html } from "../../../chunks/index.js";
function _page($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    let library = [];
    head("c8k2rg", $$renderer2, ($$renderer3) => {
      $$renderer3.title(($$renderer4) => {
        $$renderer4.push(`<title>Library · Watchhouse</title>`);
      });
    });
    $$renderer2.push(`<section class="library-page"><div class="page-tools"><span class="page-eyebrow">${escape_html(library.length)} saved ${escape_html(library.length === 1 ? "title" : "titles")}</span><a class="btn btn-sm btn-ghost" href="/downloads">Manage downloads</a></div> `);
    {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> `);
    {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> `);
    {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> `);
    {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div class="editorial-loading grid place-items-center py-24"><span class="loading loading-spinner loading-lg"></span><p>Opening your library</p></div>`);
    }
    $$renderer2.push(`<!--]--></section>`);
  });
}
export {
  _page as default
};
