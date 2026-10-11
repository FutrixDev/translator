// The DOM harness page is an ordinary page, and an ordinary page's `chrome` has
// no storage. Every content-script world has it, and content/content-local-pref.js
// registers its onChanged listener at load without asking, as the extension
// lets it. This stands in for that much: nothing is stored, no change ever
// arrives, and the page keeps whatever else its `chrome` already carries.
window.chrome = Object.assign(window.chrome || {}, {
  storage: {
    local: { get() {}, set: async () => {} },
    onChanged: { addListener() {} },
  },
});
