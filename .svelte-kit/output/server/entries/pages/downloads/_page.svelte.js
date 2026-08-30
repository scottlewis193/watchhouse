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
    $$renderer2.push(`<section class="downloads-page"><div class="page-heading"><div><p class="page-eyebrow">Offline viewing</p><h1>Downloads</h1></div><div class="page-heading-meta"><span>${escape_html(downloads.length)} saved</span>`);
    if (activeCount()) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<span>${escape_html(activeCount())} active</span>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--></div></div> `);
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
