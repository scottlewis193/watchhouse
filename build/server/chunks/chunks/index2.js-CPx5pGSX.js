import './state.svelte.js-DFV3kIz4.js';
import './exports.js-BZBK1HC9.js';
import './utils2.js-BQzn9ikS.js';
import './utils.js-DNDl--Fb.js';
import './root.js-C4XJ2ICJ.js';
import { a2 as getContext } from './index.js-BDRgBx0K.js';

function context() {
  return getContext("__request__");
}
const page$1 = {
  get error() {
    return context().page.error;
  },
  get params() {
    return context().page.params;
  },
  get status() {
    return context().page.status;
  },
  get url() {
    return context().page.url;
  }
};
const page = page$1;

export { page as p };
//# sourceMappingURL=index2.js-CPx5pGSX.js.map
