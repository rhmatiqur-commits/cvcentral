/**
 * CV Central — PWA bootstrap
 * Registers the service worker and shows a lightweight install prompt.
 * Android/desktop Chrome: native "Install app" prompt via beforeinstallprompt.
 * iOS Safari: doesn't support beforeinstallprompt, so we show a one-time
 * "Add to Home Screen" hint with instructions instead.
 */
(function () {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function (err) {
        console.warn('[pwa] service worker registration failed', err);
      });
    });
  }

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true;
  }
  if (isStandalone()) return; // already installed, no need to nudge

  function isIOS() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent);
  }

  function makeBanner(message, actionLabel, onAction) {
    if (localStorage.getItem('cvcentral_install_dismissed')) return;
    var bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:300;background:#1A1A2E;color:#fff;padding:0.85rem 1.1rem;display:flex;align-items:center;gap:0.85rem;font-family:Inter,system-ui,sans-serif;font-size:0.85rem;box-shadow:0 -6px 20px rgba(0,0,0,0.18);';
    bar.innerHTML =
      '<span style="flex:1;line-height:1.4;">' + message + '</span>'
      + '<button id="pwaInstallGo" style="background:#AAFF00;color:#1A1A2E;border:none;border-radius:999px;padding:0.5rem 1rem;font-weight:700;font-size:0.8rem;cursor:pointer;white-space:nowrap;">' + actionLabel + '</button>'
      + '<button id="pwaInstallClose" aria-label="Dismiss" style="background:transparent;border:none;color:rgba(255,255,255,0.6);font-size:1.1rem;cursor:pointer;padding:0.2rem 0.4rem;">&#215;</button>';
    document.body.appendChild(bar);
    document.getElementById('pwaInstallClose').addEventListener('click', function () {
      localStorage.setItem('cvcentral_install_dismissed', '1');
      bar.remove();
    });
    document.getElementById('pwaInstallGo').addEventListener('click', function () {
      onAction();
      bar.remove();
    });
  }

  // Android / desktop Chrome — native install prompt
  var deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    makeBanner('Install CV Central for quicker access and offline support.', 'Install', function () {
      deferredPrompt.prompt();
      deferredPrompt.userChoice.finally(function () { deferredPrompt = null; });
    });
  });

  // iOS Safari — manual instructions, shown once after a short delay
  if (isIOS() && /safari/i.test(navigator.userAgent) && !/crios|fxios/i.test(navigator.userAgent)) {
    setTimeout(function () {
      makeBanner('Add CV Central to your Home Screen: tap Share, then "Add to Home Screen".', 'Got it', function () {
        localStorage.setItem('cvcentral_install_dismissed', '1');
      });
    }, 4000);
  }
})();
