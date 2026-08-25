import { h as head, b as ensure_array_like } from "../../chunks/index.js";
import "../../chunks/state.svelte.js";
import "@sveltejs/kit/internal";
import "../../chunks/exports.js";
import "../../chunks/utils2.js";
import "@sveltejs/kit/internal/server";
import "../../chunks/root.js";
function _page($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    head("1uha8ag", $$renderer2, ($$renderer3) => {
      $$renderer3.title(($$renderer4) => {
        $$renderer4.push(`<title>Discover · Watchhouse</title>`);
      });
    });
    {
      $$renderer2.push("<!--[-1-->");
      $$renderer2.push(`<section aria-label="Browse films and series" class="space-y-11 pt-2">`);
      {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]--> `);
      {
        $$renderer2.push("<!--[0-->");
        $$renderer2.push(`<!--[-->`);
        const each_array_1 = ensure_array_like(Array(3));
        for (let $$index_2 = 0, $$length = each_array_1.length; $$index_2 < $$length; $$index_2++) {
          each_array_1[$$index_2];
          $$renderer2.push(`<div><div class="mb-4 h-6 w-40 animate-pulse rounded bg-base-300"></div><div class="grid auto-cols-[8.75rem] grid-flow-col gap-4 overflow-hidden sm:auto-cols-[10.5rem]"><!--[-->`);
          const each_array_2 = ensure_array_like(Array(6));
          for (let $$index_1 = 0, $$length2 = each_array_2.length; $$index_1 < $$length2; $$index_1++) {
            each_array_2[$$index_1];
            $$renderer2.push(`<div><div class="aspect-[2/3] animate-pulse bg-base-300"></div><div class="mt-3 h-4 w-3/4 animate-pulse rounded bg-base-300"></div></div>`);
          }
          $$renderer2.push(`<!--]--></div></div>`);
        }
        $$renderer2.push(`<!--]-->`);
      }
      $$renderer2.push(`<!--]--></section>`);
    }
    $$renderer2.push(`<!--]-->`);
  });
}
export {
  _page as default
};
