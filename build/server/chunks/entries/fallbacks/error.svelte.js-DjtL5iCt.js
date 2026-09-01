import { a6 as escape_html } from '../../chunks/index.js-BDRgBx0K.js';
import { p as page } from '../../chunks/index2.js-CPx5pGSX.js';
import '../../chunks/utils.js-DNDl--Fb.js';
import '../../chunks/utils2.js-BQzn9ikS.js';
import '../../chunks/state.svelte.js-DFV3kIz4.js';
import '../../chunks/exports.js-BZBK1HC9.js';
import '../../chunks/root.js-C4XJ2ICJ.js';

function Error($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    $$renderer2.push(`<h1>${escape_html(page.status)}</h1> <p>${escape_html(page.error?.message)}</p>`);
  });
}

export { Error as default };
//# sourceMappingURL=error.svelte.js-DjtL5iCt.js.map
