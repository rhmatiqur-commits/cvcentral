/* ==========================================================================
   CV CENTRAL — LANDING
   Scroll choreography, product demos, navigation.
   No dependencies. Everything degrades to a readable static page.

   01  Environment
   02  Reveal observer
   03  Masthead + scroll progress
   04  Mobile drawer
   05  Counters & meters
   06  Problem funnel
   07  AI analysis metrics
   08  ATS sequence
   09  Job match
   10  Cover letter typewriter
   11  Journey (pinned horizontal on desktop)
   12  Hero parallax
   13  Scroll loop
   ========================================================================== */

(function () {
  'use strict';

  /* ── 01  Environment ──────────────────────────────────────────────── */

  var root = document.documentElement;
  var motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  var REDUCED = motionQuery.matches;

  if (REDUCED) root.classList.add('motion-off');
  // If the user changes the OS setting mid-session, reload state cheaply.
  if (motionQuery.addEventListener) {
    motionQuery.addEventListener('change', function (e) {
      REDUCED = e.matches;
      root.classList.toggle('motion-off', REDUCED);
      // The journey section carries a JS-set height while pinned. Turning
      // reduced motion on unpins it, so that height has to go with it or the
      // section is left as a tall empty gap.
      measureJourney();
      schedule();
    });
  }

  var clamp = function (n, lo, hi) { return n < lo ? lo : n > hi ? hi : n; };
  var easeOut = function (t) { return 1 - Math.pow(1 - t, 3); };
  var vh = function () { return window.innerHeight; };

  /* Cheap "is this worth measuring" guard for the per-frame updaters.
     Deliberately a live rect check rather than a cached IntersectionObserver
     flag: a stale flag silently freezes a section mid-animation, and one
     getBoundingClientRect is far cheaper than that bug. */
  function nearViewport(el, slackRatio) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    var slack = vh() * (slackRatio || 0.2);
    return r.bottom > -slack && r.top < vh() + slack;
  }

  /* ── 02  Reveal observer ──────────────────────────────────────────── */

  var revealTargets = document.querySelectorAll('[data-reveal], .reveal-line, .metric, .match');

  if (revealTargets.length) {
    var revealObserver = new IntersectionObserver(function (entries, obs) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-in');
        obs.unobserve(entry.target);
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });

    revealTargets.forEach(function (el) { revealObserver.observe(el); });
  }

  /* Headings whose child .reveal-line spans animate together */
  document.querySelectorAll('h1, h2').forEach(function (h) {
    if (!h.querySelector('.reveal-line')) return;
    new IntersectionObserver(function (entries, obs) {
      if (!entries[0].isIntersecting) return;
      h.classList.add('is-in');
      obs.disconnect();
    }, { threshold: 0.25 }).observe(h);
  });

  /* ── 03  Masthead + scroll progress ───────────────────────────────── */

  var masthead = document.getElementById('masthead');
  var progress = document.getElementById('progress');
  var paperBands = Array.prototype.slice.call(document.querySelectorAll('.band--paper'));

  function updateChrome() {
    var y = window.scrollY || window.pageYOffset;
    var max = document.documentElement.scrollHeight - vh();

    if (progress) progress.style.setProperty('--scroll', max > 0 ? clamp(y / max, 0, 1) : 0);
    if (!masthead) return;

    masthead.classList.toggle('is-stuck', y > 24);

    // Flip the masthead to ink when it sits over a paper band
    var probe = masthead.offsetHeight * 0.55;
    var overPaper = false;
    for (var i = 0; i < paperBands.length; i++) {
      var r = paperBands[i].getBoundingClientRect();
      if (r.top <= probe && r.bottom >= probe) { overPaper = true; break; }
    }
    masthead.classList.toggle('is-inverted', overPaper);
  }

  /* ── 04  Mobile drawer ────────────────────────────────────────────── */

  (function drawerSetup() {
    var burger = document.getElementById('burger');
    var drawer = document.getElementById('drawer');
    if (!burger || !drawer) return;

    var links = drawer.querySelectorAll('a');
    var closeTimer;

    function open() {
      clearTimeout(closeTimer);
      drawer.hidden = false;
      document.body.classList.add('is-locked');
      burger.setAttribute('aria-expanded', 'true');
      burger.setAttribute('aria-label', 'Close menu');
      // Flush layout synchronously so the clip-path transition has a start
      // value. rAF would work too, but it is throttled in background tabs —
      // and a menu that never opens is worse than one that opens un-animated.
      void drawer.offsetHeight;
      drawer.classList.add('is-open');
      var firstLink = drawer.querySelector('a[href]');
      if (firstLink) firstLink.focus({ preventScroll: true });
    }

    function close(refocus) {
      drawer.classList.remove('is-open');
      document.body.classList.remove('is-locked');
      burger.setAttribute('aria-expanded', 'false');
      burger.setAttribute('aria-label', 'Open menu');
      if (refocus) burger.focus();
      closeTimer = setTimeout(function () {
        if (!drawer.classList.contains('is-open')) drawer.hidden = true;
      }, 700);
    }

    burger.addEventListener('click', function () {
      if (drawer.classList.contains('is-open')) close(false); else open();
    });

    links.forEach(function (a) { a.addEventListener('click', function () { close(false); }); });

    document.addEventListener('keydown', function (e) {
      if (!drawer.classList.contains('is-open')) return;

      if (e.key === 'Escape') { close(true); return; }

      if (e.key !== 'Tab') return;
      // Keep focus inside the drawer while it is open
      var focusable = Array.prototype.filter.call(
        drawer.querySelectorAll('a[href], button:not([disabled])'),
        function (el) { return el.offsetParent !== null; }
      );
      if (!focusable.length) return;
      var first = focusable[0];
      var last = focusable[focusable.length - 1];

      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });

    // Close if the viewport grows past the mobile breakpoint
    window.matchMedia('(min-width: 1025px)').addEventListener('change', function (e) {
      if (e.matches && drawer.classList.contains('is-open')) close(false);
    });
  })();

  /* ── 05  Counters & meters ────────────────────────────────────────── */

  function countTo(el, done) {
    var target = parseFloat(el.dataset.count);
    var from = parseFloat(el.dataset.from || '0');
    if (isNaN(target)) return;

    if (REDUCED) { el.textContent = String(Math.round(target)); if (done) done(1); return; }

    var start = null;
    var duration = 1500;

    (function step(now) {
      if (start === null) start = now;
      var t = clamp((now - start) / duration, 0, 1);
      var e = easeOut(t);
      el.textContent = String(Math.round(from + (target - from) * e));
      if (done) done(e);
      if (t < 1) requestAnimationFrame(step);
    })(performance.now());
  }

  function onceInView(el, cb, threshold) {
    if (!el) return;
    new IntersectionObserver(function (entries, obs) {
      if (!entries[0].isIntersecting) return;
      obs.disconnect();
      cb();
    }, { threshold: threshold || 0.35 }).observe(el);
  }

  /* Hero: score ring + counter */
  (function heroScore() {
    var panel = document.getElementById('heroPanel');
    var ring = document.getElementById('heroRing');
    var num = panel && panel.querySelector('[data-count]');
    if (!panel || !num) return;

    onceInView(panel, function () {
      countTo(num);
      if (ring) {
        var circumference = 138.2;
        ring.style.strokeDashoffset = String(circumference * (1 - 0.94));
      }
    }, 0.3);
  })();

  /* Fill any bar that declares a target width once it scrolls in */
  document.querySelectorAll('.ui-fill[data-w]').forEach(function (fill) {
    onceInView(fill.closest('.metric') || fill, function () {
      fill.style.width = fill.dataset.w + '%';
    }, 0.2);
  });

  /* ── 06  Problem funnel ───────────────────────────────────────────── */

  var funnelState = -1;
  var dotEls = [];
  var survivorRank = [];
  var funnelEl = document.querySelector('.funnel');
  var stageEls = Array.prototype.slice.call(document.querySelectorAll('#stages .stage'));

  (function buildDots() {
    var host = document.getElementById('funnelDots');
    if (!host) return;

    var frag = document.createDocumentFragment();
    for (var i = 0; i < 100; i++) {
      var dot = document.createElement('i');
      dot.style.setProperty('--i', String(i));
      frag.appendChild(dot);
      dotEls.push(dot);
    }
    host.appendChild(frag);

    // Which cells survive each stage. Shuffled so the remainder is scattered
    // through the field — filtering in index order reads as a header row,
    // not as "a handful out of a hundred". Seeded, so the pattern is stable.
    var order = dotEls.map(function (_, i) { return i; });
    var seed = 0x9E3779B9;
    function rnd() {
      seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    for (var j = order.length - 1; j > 0; j--) {
      var k = Math.floor(rnd() * (j + 1));
      var tmp = order[j]; order[j] = order[k]; order[k] = tmp;
    }
    order.forEach(function (dotIndex, rank) { survivorRank[dotIndex] = rank; });
  })();

  // How many applications remain "in play" at each stage of the illustration
  var REMAINING = [100, 26, 7, 2];

  function paintFunnel(stage) {
    if (stage === funnelState || !dotEls.length) return;
    funnelState = stage;
    var remaining = REMAINING[clamp(stage, 0, 3)];
    var isFinal = stage >= 3;

    for (var i = 0; i < dotEls.length; i++) {
      var dot = dotEls[i];
      var alive = survivorRank[i] < remaining;
      dot.classList.toggle('is-cut', !alive);
      dot.classList.toggle('is-live', alive && isFinal);
    }

    stageEls.forEach(function (el, i) { el.classList.toggle('is-active', i === stage); });
  }

  function updateFunnel() {
    if (!stageEls.length || !nearViewport(funnelEl)) return;
    var mid = vh() * 0.55;
    var best = 0;
    var bestDist = Infinity;

    stageEls.forEach(function (el, i) {
      var r = el.getBoundingClientRect();
      var d = Math.abs(r.top + r.height / 2 - mid);
      if (d < bestDist) { bestDist = d; best = i; }
    });

    paintFunnel(best);
  }

  /* ── 07  AI analysis metrics ──────────────────────────────────────── */

  (function analysisMetrics() {
    var metrics = document.getElementById('metrics');
    if (!metrics) return;
    onceInView(metrics, function () {
      metrics.querySelectorAll('.metric').forEach(function (m) { m.classList.add('is-in'); });
      var counter = metrics.querySelector('[data-count]');
      if (counter) countTo(counter);
    }, 0.25);
  })();

  /* ── 08  ATS sequence ─────────────────────────────────────────────── */

  var atsRail = document.getElementById('atsRail');
  var atsSteps = atsRail ? Array.prototype.slice.call(atsRail.children) : [];
  var atsDelta = document.querySelector('.ats__delta [data-count]');
  var atsLit = -1;

  function updateAts() {
    if (!atsSteps.length || !nearViewport(atsRail, 0.5)) return;
    var r = atsRail.getBoundingClientRect();
    // 0 when the rail's top edge reaches the bottom of the viewport,
    // 1 once it has travelled to roughly a third of the way up.
    var travel = vh() * 0.62;
    var p = clamp((vh() - r.top - vh() * 0.28) / travel, 0, 1);
    var lit = Math.round(p * atsSteps.length);

    if (lit !== atsLit) {
      atsLit = lit;
      atsSteps.forEach(function (s, i) { s.classList.toggle('is-on', i < lit); });
    }

    if (atsDelta && !REDUCED) {
      var from = parseFloat(atsDelta.dataset.from || '0');
      var to = parseFloat(atsDelta.dataset.count);
      atsDelta.textContent = String(Math.round(from + (to - from) * p));
    }
  }

  if (REDUCED && atsDelta) atsDelta.textContent = atsDelta.dataset.count;

  /* ── 09  Job match ────────────────────────────────────────────────── */
  /* (.match gets .is-in from the reveal observer, which drives the
      staggered keyword highlights and output rows in CSS.) */

  /* ── 10  Cover letter typewriter ──────────────────────────────────── */

  (function coverLetter() {
    var out = document.getElementById('typeOut');
    var caret = document.getElementById('caret');
    var sig = document.getElementById('letterSig');
    if (!out) return;

    // Authored in the markup — read it back rather than duplicating the copy.
    var TEXT = out.textContent.replace(/\n[ \t]+/g, '\n').trim();

    function finish() {
      out.textContent = TEXT;
      if (caret) caret.classList.add('is-done');
      if (sig) sig.style.opacity = '1';
    }

    if (REDUCED) { finish(); return; }

    out.textContent = '';
    if (sig) { sig.style.opacity = '0'; sig.style.transition = 'opacity .6s ease'; }

    onceInView(out.closest('.letter__page'), function () {
      var start = null;
      var duration = 5200;

      (function step(now) {
        if (start === null) start = now;
        var t = clamp((now - start) / duration, 0, 1);
        var chars = Math.floor(TEXT.length * t);
        out.textContent = TEXT.slice(0, chars);
        if (t < 1) {
          requestAnimationFrame(step);
        } else {
          finish();
        }
      })(performance.now());
    }, 0.4);
  })();

  /* ── 11  Journey ──────────────────────────────────────────────────── */

  var journey = document.getElementById('journey');
  var journeyTrack = document.getElementById('journeyTrack');
  var journeyBar = document.getElementById('journeyBar');
  var jcards = journeyTrack ? Array.prototype.slice.call(journeyTrack.children) : [];
  var journeyOverflow = 0;
  var journeyPinned = false;
  var jcardLit = -1;

  function measureJourney() {
    if (!journey || !journeyTrack || !jcards.length) return;

    journeyPinned = window.innerWidth > 1024 && !REDUCED;

    if (!journeyPinned) {
      // Same list, swipeable. Every stage reads as active — there is no
      // scroll position driving a "current" one.
      journey.style.height = '';
      journeyTrack.style.setProperty('--x', '0px');
      journeyTrack.classList.add('is-rail');
      journeyTrack.setAttribute('tabindex', '0');
      jcards.forEach(function (c) { c.classList.add('is-on'); });
      jcardLit = -1;
      return;
    }

    journeyTrack.classList.remove('is-rail');
    journeyTrack.removeAttribute('tabindex');

    // Measure at rest — the track may already be translated from a prior frame.
    journeyTrack.style.setProperty('--x', '0px');

    // scrollWidth omits a flex container's trailing padding in several engines,
    // so derive the travel from the last card's right edge instead.
    var trackLeft = journeyTrack.getBoundingClientRect().left;
    var lastRight = jcards[jcards.length - 1].getBoundingClientRect().right;
    var endGutter = parseFloat(getComputedStyle(journeyTrack).paddingRight) || 0;
    var contentWidth = (lastRight - trackLeft) + endGutter;

    journeyOverflow = Math.max(0, contentWidth - journeyTrack.clientWidth);
    journey.style.height = (window.innerHeight + journeyOverflow) + 'px';
    jcardLit = -1;
  }

  function updateJourney() {
    if (!journeyPinned || !journey || !journeyTrack) return;

    var r = journey.getBoundingClientRect();
    if (r.bottom < 0 || r.top > vh()) return;

    var scrollable = journey.offsetHeight - vh();
    var p = scrollable > 0 ? clamp(-r.top / scrollable, 0, 1) : 0;

    journeyTrack.style.setProperty('--x', (-journeyOverflow * p) + 'px');
    if (journeyBar) journeyBar.style.setProperty('--jp', String(p));

    var lit = clamp(Math.round(p * (jcards.length - 1)), 0, jcards.length - 1);
    if (lit !== jcardLit) {
      jcardLit = lit;
      jcards.forEach(function (c, i) { c.classList.toggle('is-on', i <= lit); });
    }
  }

  /* ── 12  Hero parallax ────────────────────────────────────────────── */

  (function heroParallax() {
    var hero = document.getElementById('hero');
    var panel = document.getElementById('heroPanel');
    if (!hero || !panel) return;
    if (REDUCED || !window.matchMedia('(pointer: fine)').matches) return;
    if (window.innerWidth <= 1024) return;

    hero.addEventListener('pointermove', function (e) {
      var rx = (e.clientX / window.innerWidth - 0.5) * 2;
      var ry = (e.clientY / window.innerHeight - 0.5) * 2;
      panel.style.setProperty('--mx', (rx * -12).toFixed(1) + 'px');
      panel.style.setProperty('--my', (ry * -12).toFixed(1) + 'px');
    }, { passive: true });

    hero.addEventListener('pointerleave', function () {
      panel.style.setProperty('--mx', '0px');
      panel.style.setProperty('--my', '0px');
    });
  })();

  /* ── 13  Scroll loop ──────────────────────────────────────────────── */

  var ticking = false;

  function frame() {
    ticking = false;
    updateChrome();
    updateFunnel();
    updateAts();
    updateJourney();
  }

  function schedule() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(frame);
  }

  window.addEventListener('scroll', schedule, { passive: true });

  var resizeTimer;
  function remeasure() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      measureJourney();
      schedule();
    }, 140);
  }

  window.addEventListener('resize', remeasure, { passive: true });
  window.addEventListener('orientationchange', remeasure, { passive: true });

  // The journey section carries a JS-set height while pinned. If that height
  // ever outlives the layout that justified it the section becomes a hole of
  // dead space, so watch the element itself rather than trusting resize alone.
  if (window.ResizeObserver) {
    var lastWidth = document.documentElement.clientWidth;
    new ResizeObserver(function () {
      var w = document.documentElement.clientWidth;
      if (w === lastWidth) return;
      lastWidth = w;
      remeasure();
    }).observe(document.documentElement);
  }

  // Web fonts change the track width — remeasure once they land
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () { measureJourney(); schedule(); });
  }

  measureJourney();
  schedule();
})();
