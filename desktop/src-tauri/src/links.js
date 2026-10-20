// Runs in every page of the app. WebView2 doesn't report links that open a new window
// (target="_blank", window.open) to the app, so they would do nothing: they navigate this
// window instead, and the app's navigation handler sends other sites to the browser.
(() => {
  const go = (url) => {
    window.location.href = new URL(url, window.location.href).href;
  };
  document.addEventListener(
    "click",
    (e) => {
      const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
      if (!a || a.target !== "_blank" || e.defaultPrevented) return;
      e.preventDefault();
      go(a.href);
    },
    true,
  );
  window.open = (url) => {
    if (url) go(String(url));
    return null;
  };
})();
