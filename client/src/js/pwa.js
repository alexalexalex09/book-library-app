(function initPwa() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch((error) => {
        console.warn("Service worker registration failed:", error);
      });
    });
  }

  let deferredInstallPrompt = null;
  let installBtn = null;

  function ensureInstallButton() {
    if (installBtn) return installBtn;
    const navUser = document.querySelector(".nav-user");
    if (!navUser) return null;
    installBtn = document.createElement("button");
    installBtn.id = "pwaInstallBtn";
    installBtn.type = "button";
    installBtn.className = "logout-btn pwa-install-btn";
    installBtn.textContent = "Install";
    installBtn.hidden = true;
    installBtn.addEventListener("click", async () => {
      if (!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      try {
        await deferredInstallPrompt.userChoice;
      } catch (_) {
        // no-op
      }
      deferredInstallPrompt = null;
      installBtn.hidden = true;
    });
    navUser.prepend(installBtn);
    return installBtn;
  }

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    const button = ensureInstallButton();
    if (button) button.hidden = false;
  });

  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    const button = ensureInstallButton();
    if (button) button.hidden = true;
  });

  const isStandalone = window.matchMedia("(display-mode: standalone)").matches;
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const seenHint = window.localStorage?.getItem("hilibrary-ios-install-hint") === "1";
  if (!isStandalone && isIos && !seenHint) {
    window.addEventListener("load", () => {
      const hint = document.createElement("div");
      hint.className = "pwa-ios-hint";
      hint.innerHTML =
        "<span>Install HiLibrary: tap Share, then Add to Home Screen.</span><button type='button' class='pwa-ios-hint-close' aria-label='Dismiss install hint'>Dismiss</button>";
      hint
        .querySelector(".pwa-ios-hint-close")
        ?.addEventListener("click", () => {
          window.localStorage?.setItem("hilibrary-ios-install-hint", "1");
          hint.remove();
        });
      document.body.appendChild(hint);
    });
  }
})();
