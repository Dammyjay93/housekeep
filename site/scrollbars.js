// Scrollbars show while something scrolls, and hide again 800ms after it stops.
const hideAfter = new WeakMap();
document.addEventListener("scroll", (e) => {
  const box = e.target === document ? document.documentElement : e.target;
  if (!(box instanceof Element)) return;
  box.classList.add("scrolling");
  clearTimeout(hideAfter.get(box));
  hideAfter.set(box, setTimeout(() => box.classList.remove("scrolling"), 800));
}, { capture: true, passive: true });
