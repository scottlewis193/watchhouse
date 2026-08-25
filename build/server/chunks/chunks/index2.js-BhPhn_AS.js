import './state.svelte.js-DcS1UI08.js';
import './exports.js-BZBK1HC9.js';
import './utils2.js-BQzn9ikS.js';
import './utils.js-DNDl--Fb.js';
import './root.js-C0pHJz1r.js';
import { a2 as getContext } from './index.js-CrzwTI5S.js';

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
//# sourceMappingURL=index2.js-BhPhn_AS.js.map
