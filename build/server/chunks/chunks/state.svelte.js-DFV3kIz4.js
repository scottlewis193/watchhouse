import { Q as noop } from './index.js-BDRgBx0K.js';
import './exports.js-BZBK1HC9.js';
import './utils.js-DNDl--Fb.js';
import './root.js-C4XJ2ICJ.js';

const is_legacy = noop.toString().includes("$$") || /function \w+\(\) \{\}/.test(noop.toString());
const placeholder_url = "a:";
if (is_legacy) {
  ({
    url: new URL(placeholder_url)
  });
}
//# sourceMappingURL=state.svelte.js-DFV3kIz4.js.map
