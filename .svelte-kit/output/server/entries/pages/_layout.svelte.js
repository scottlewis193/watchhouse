import { h as head, a as attr_class, b as attr } from "../../chunks/index.js";
import "@sveltejs/kit/internal";
import "../../chunks/exports.js";
import "../../chunks/utils2.js";
import "@sveltejs/kit/internal/server";
import "../../chunks/root.js";
import "../../chunks/state.svelte.js";
import { p as page } from "../../chunks/index2.js";
import "clsx";
function IntroAnimation($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]-->`);
  });
}
function _layout($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    let { children } = $$props;
    let offline = false;
    head("12qhfyh", $$renderer2, ($$renderer3) => {
      $$renderer3.title(($$renderer4) => {
        $$renderer4.push(`<title>Watchhouse</title>`);
      });
      $$renderer3.push(`<meta name="description" content="A private media discovery interface"/>`);
    });
    IntroAnimation($$renderer2);
    $$renderer2.push(`<!----> <div${attr_class("watchhouse-shell min-h-screen bg-base-200 text-base-content", void 0, { "watchhouse-watch": page.url.pathname.startsWith("/watch/") })}>`);
    {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> <header class="app-header"><div class="app-header-inner mx-auto grid max-w-[90rem] items-center gap-x-8 gap-y-4 px-5 sm:px-8 lg:px-12"><a class="brand-link"${attr("href", "/")}>Watchhouse</a> <nav class="main-nav" aria-label="Main navigation"><a${attr_class("nav-link", void 0, { "nav-link-active": page.url.pathname === "/" })} href="/">Home</a> <a${attr_class("nav-link", void 0, { "nav-link-active": page.url.pathname.startsWith("/library") })} href="/library">Library</a> <a${attr_class("nav-link", void 0, {
      "nav-link-active": page.url.pathname.startsWith("/downloads")
    })} href="/downloads">Downloads</a> <a${attr_class("nav-link", void 0, { "nav-link-active": page.url.pathname.startsWith("/settings") })} href="/settings">Settings</a></nav> <form${attr_class("nav-search", void 0, { "opacity-40": offline })} action="/" method="get" role="search"><svg class="size-4 shrink-0" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5"></circle><path d="m13 13 4 4"></path></svg> <input class="min-w-0 flex-1 bg-transparent py-2 text-sm outline-none" name="q" type="search"${attr("value", page.url.searchParams.get("q") || "")}${attr("placeholder", "Search")} aria-label="Search movies and shows"${attr("disabled", offline, true)}/></form></div></header> <main${attr_class("app-main mx-auto max-w-[90rem] px-5 py-7 sm:px-8 sm:py-9 lg:px-12 lg:py-10", void 0, { "watch-main": page.url.pathname.startsWith("/watch/") })}>`);
    children($$renderer2);
    $$renderer2.push(`<!----></main> <footer class="app-footer mx-auto flex max-w-[90rem] flex-col gap-4 border-t border-base-300 px-5 py-8 text-xs text-base-content/45 sm:px-8 md:flex-row md:items-center md:justify-between lg:px-12"><p class="tracking-[0.18em]">WATCHHOUSE · PRIVATE SCREENING ROOM</p> <a class="flex items-center gap-3 hover:text-base-content/75" href="https://www.themoviedb.org" target="_blank" rel="noreferrer"><img class="h-7 w-7" src="https://www.themoviedb.org/assets/2/v4/logos/v2/blue_square_1-5bdc75aaebeb75dc7ae79426ddd9be3b2be1e342510f8202baf6bffa71d7f5c4.svg" alt="TMDB"/> <span class="max-w-sm leading-relaxed">Uses the TMDB API. Not endorsed or certified by TMDB.</span></a></footer></div>`);
  });
}
export {
  _layout as default
};
