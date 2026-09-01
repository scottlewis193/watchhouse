import { h as head, e as escape_html, d as derived } from "../../../chunks/index.js";
function _page($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    let downloads = [];
    let jobs = [];
    let activeCount = derived(() => jobs.filter((job) => !["ready", "error"].includes(job.status)).length);
    head("19lfojq", $$renderer2, ($$renderer3) => {
      $$renderer3.title(($$renderer4) => {
        $$renderer4.push(`<title>Downloads · Watchhouse</title>`);
      });
    });
    $$renderer2.push(`<section class="downloads-page"><div class="page-tools"><span class="page-eyebrow">${escape_html(downloads.length)} saved${escape_html(activeCount() ? ` · ${activeCount()} active` : "")}</span><a class="btn btn-sm btn-ghost" href="/library">Open library</a></div> `);
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
      $$renderer2.push(`<div class="editorial-loading grid place-items-center py-24"><span class="loading loading-spinner loading-lg"></span><p>Opening download manager</p></div>`);
    }
    $$renderer2.push(`<!--]--></section>`);
  });
}
export {
  _page as default
};
