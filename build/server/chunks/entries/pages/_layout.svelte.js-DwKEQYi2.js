import { a3 as head, a4 as attr } from '../../chunks/index.js-CrzwTI5S.js';
import { p as page } from '../../chunks/index2.js-BhPhn_AS.js';
import '../../chunks/utils.js-DNDl--Fb.js';
import '../../chunks/utils2.js-BQzn9ikS.js';
import '../../chunks/state.svelte.js-DcS1UI08.js';
import '../../chunks/exports.js-BZBK1HC9.js';
import '../../chunks/root.js-C0pHJz1r.js';

function _layout($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    let { children } = $$props;
    head("12qhfyh", $$renderer2, ($$renderer3) => {
      $$renderer3.title(($$renderer4) => {
        $$renderer4.push(`<title>Watchhouse</title>`);
      });
      $$renderer3.push(`<meta name="description" content="A private media discovery interface"/>`);
    });
    $$renderer2.push(`<div class="min-h-screen bg-base-200 text-base-content"><header class="app-header border-b border-base-300"><div class="mx-auto grid min-h-18 max-w-6xl grid-cols-[auto_1fr_auto] items-center gap-3 px-4 py-3 sm:gap-6 sm:px-6"><a class="brand-link flex items-center gap-3 font-semibold tracking-tight" href="/"><span class="brand-mark grid size-7 place-items-center border border-base-content text-[10px] font-bold"><span class="brand-initials">WH</span></span> Watchhouse</a> <form class="nav-search order-3 col-span-3 mx-auto flex w-full max-w-xl items-center border-b border-base-content/30 sm:order-none sm:col-span-1" action="/" method="get" role="search"><input class="input input-ghost min-w-0 flex-1 px-0 text-sm focus:outline-none" name="q" type="search"${attr("value", page.url.searchParams.get("q") || "")} placeholder="Search films and series…" aria-label="Search movies and shows"/></form> <nav class="flex items-center justify-end gap-3 text-sm text-base-content/70 sm:gap-5" aria-label="Main navigation"><a class="nav-link" href="/library">Library</a><a class="nav-link" href="/settings">Settings</a></nav></div></header> <main class="app-main mx-auto max-w-6xl px-4 py-12 sm:px-6">`);
    children($$renderer2);
    $$renderer2.push(`<!----></main> <footer class="app-footer border-t border-base-300 py-7 text-center text-xs text-base-content/50"><p class="tracking-wide">WATCHHOUSE · PRIVATE MEDIA LIBRARY</p> <a class="mx-auto mt-4 flex w-fit items-center justify-center gap-3 hover:text-base-content/75" href="https://www.themoviedb.org" target="_blank" rel="noreferrer"><img class="h-7 w-7" src="https://www.themoviedb.org/assets/2/v4/logos/v2/blue_square_1-5bdc75aaebeb75dc7ae79426ddd9be3b2be1e342510f8202baf6bffa71d7f5c4.svg" alt="TMDB"/> <span class="max-w-md text-left leading-relaxed">This product uses the TMDB API but is not endorsed or certified by TMDB.</span></a></footer></div>`);
  });
}

export { _layout as default };
//# sourceMappingURL=_layout.svelte.js-DwKEQYi2.js.map
