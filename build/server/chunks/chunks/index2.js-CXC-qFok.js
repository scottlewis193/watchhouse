import './state.svelte.js-syOl7ztk.js';
import './exports.js-BZBK1HC9.js';
import './utils2.js-BQzn9ikS.js';
import './utils.js-DNDl--Fb.js';
import './root.js-BNc2O1GQ.js';
import { a2 as getContext } from './index.js-CjwkDa6e.js';

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
//# sourceMappingURL=index2.js-CXC-qFok.js.map
