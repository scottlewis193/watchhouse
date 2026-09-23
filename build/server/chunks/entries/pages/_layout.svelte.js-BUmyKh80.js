import { a3 as head, a4 as attr_class, a5 as attr, Z as derived, a6 as ensure_array_like, a7 as escape_html } from '../../chunks/index.js-o4iIjNRP.js';
import '../../chunks/exports.js-BZBK1HC9.js';
import '../../chunks/utils2.js-BQzn9ikS.js';
import '../../chunks/utils.js-DNDl--Fb.js';
import '../../chunks/root.js-DDT8hSpc.js';
import '../../chunks/state.svelte.js-COzWOqE5.js';
import { p as page } from '../../chunks/index2.js-CZS2kioh.js';

function AppNavigation($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    let { offline = false } = $$props;
    let open = false;
    const links = [
      {
        label: "Home",
        href: "/",
        path: "M3 10 12 3l9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z"
      },
      {
        label: "Library",
        href: "/library",
        path: "M4 4h5v16H4zM13 4l5-1 3 16-5 1z"
      },
      {
        label: "Downloads",
        href: "/downloads",
        path: "M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"
      },
      {
        label: "Settings",
        href: "/settings",
        path: "M4 7h16M4 17h16M8 4v6m8 4v6"
      }
    ];
    const active = (href) => href === "/" ? page.url.pathname === "/" : page.url.pathname.startsWith(href);
    function navigation($$renderer3, mobile = false) {
      $$renderer3.push(`<nav aria-label="Main navigation"${attr_class("svelte-1rd1pss", void 0, { "rail-links": !mobile, "drawer-links": mobile })}><!--[-->`);
      const each_array = ensure_array_like(links);
      for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
        let link = each_array[$$index];
        $$renderer3.push(`<a${attr("href", link.href)}${attr("aria-current", active(link.href) ? "page" : void 0)}${attr("aria-label", link.label)}${attr("title", link.label)}${attr_class("svelte-1rd1pss", void 0, { "active": active(link.href) })}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="svelte-1rd1pss"><path${attr("d", link.path)}></path></svg> <span${attr_class("svelte-1rd1pss", void 0, { "rail-tooltip": !mobile })}>${escape_html(link.label)}</span></a>`);
      }
      $$renderer3.push(`<!--]--></nav>`);
    }
    $$renderer2.push(`<aside class="desktop-rail svelte-1rd1pss"><a class="rail-brand svelte-1rd1pss"${attr("href", offline ? "/library?offline=1" : "/")} aria-label="Watchhouse home" title="Watchhouse">WH</a> `);
    navigation($$renderer2);
    $$renderer2.push(`<!----></aside> <button class="mobile-menu-button svelte-1rd1pss" type="button" aria-label="Open navigation" aria-haspopup="dialog"${attr("aria-expanded", open)} aria-controls="mobile-navigation"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" aria-hidden="true" class="svelte-1rd1pss"><path d="M4 6h16M4 12h16M4 18h16"></path></svg></button> <dialog id="mobile-navigation" class="mobile-navigation svelte-1rd1pss" aria-label="Navigation"><div class="drawer-content svelte-1rd1pss"><div class="drawer-heading svelte-1rd1pss"><span>Watchhouse</span><button type="button" aria-label="Close navigation" class="svelte-1rd1pss">✕</button></div> `);
    navigation($$renderer2, true);
    $$renderer2.push(`<!----></div></dialog>`);
  });
}
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
    const isWatchRoute = derived(() => page.url.pathname === "/watch" || page.url.pathname.startsWith("/watch/"));
    head("12qhfyh", $$renderer2, ($$renderer3) => {
      $$renderer3.title(($$renderer4) => {
        $$renderer4.push(`<title>Watchhouse</title>`);
      });
      $$renderer3.push(`<meta name="description" content="A private media discovery interface"/>`);
    });
    IntroAnimation($$renderer2);
    $$renderer2.push(`<!----> <div${attr_class("watchhouse-shell min-h-screen bg-base-200 text-base-content", void 0, {
      "watchhouse-watch": isWatchRoute(),
      "with-navigation": !isWatchRoute()
    })}>`);
    {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> `);
    if (!isWatchRoute()) {
      $$renderer2.push("<!--[0-->");
      AppNavigation($$renderer2, { offline });
      $$renderer2.push(`<!----> <header class="app-toolbar"><div class="app-toolbar-inner mx-auto flex max-w-[90rem] items-center justify-center px-5 sm:px-8 lg:px-12"><form${attr_class("nav-search", void 0, { "opacity-40": offline })} action="/" method="get" role="search"><svg class="size-4 shrink-0" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5"></circle><path d="m13 13 4 4"></path></svg> <input class="min-w-0 flex-1 bg-transparent py-2 text-sm outline-none" name="q" type="search"${attr("value", page.url.searchParams.get("q") || "")}${attr("placeholder", "Search")} aria-label="Search movies and shows"${attr("disabled", offline, true)}/></form></div></header>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> <main${attr_class("app-main mx-auto max-w-[90rem] px-5 py-7 sm:px-8 sm:py-9 lg:px-12 lg:py-10", void 0, { "watch-main": isWatchRoute() })}>`);
    children($$renderer2);
    $$renderer2.push(`<!----></main></div>`);
  });
}

export { _layout as default };
//# sourceMappingURL=_layout.svelte.js-BUmyKh80.js.map
