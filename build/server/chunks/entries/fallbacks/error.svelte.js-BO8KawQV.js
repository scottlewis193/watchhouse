import { a7 as escape_html } from '../../chunks/index.js-o4iIjNRP.js';
import { p as page } from '../../chunks/index2.js-CZS2kioh.js';
import '../../chunks/utils.js-DNDl--Fb.js';
import '../../chunks/utils2.js-BQzn9ikS.js';
import '../../chunks/state.svelte.js-COzWOqE5.js';
import '../../chunks/exports.js-BZBK1HC9.js';
import '../../chunks/root.js-DDT8hSpc.js';

function Error($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    $$renderer2.push(`<h1>${escape_html(page.status)}</h1> <p>${escape_html(page.error?.message)}</p>`);
  });
}

export { Error as default };
//# sourceMappingURL=error.svelte.js-BO8KawQV.js.map
