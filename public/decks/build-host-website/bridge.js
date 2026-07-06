/* Live-session bridge — injected into the workshop deck so the parent app can
 * observe and control the design's own <deck-stage> engine without altering it.
 *
 *   • reports every slide change to the parent (index, total, label, next, notes)
 *   • accepts { deck:goto } to follow the presenter (reason 'api' — never clamped)
 *   • for viewers, caps user-initiated nav at `max` by wrapping _go (all keyboard
 *     and tap nav routes through _go with reason 'keyboard'/'click'; presenter-
 *     driven goTo uses 'api', so auto-follow is never blocked)
 *
 * Opened standalone (no parent), it's inert: role stays 'viewer' with an
 * unbounded max, so the deck navigates exactly as designed.
 */
(function () {
  var role = "viewer";
  var maxAllowed = 1e9;
  var locked = false; // viewer + auto-follow: pinned to the presenter's slide
  // Reason of the latest nav, forwarded to the parent so it can tell a user's
  // own navigation ('keyboard'/'click') from a followed/programmatic move
  // ('api') or the initial state ('init'/'sync') — the key to loop-free sync.
  var lastReason = "init";
  var ds = null;
  var patched = false;

  function post(msg) {
    try {
      msg.source = "deck";
      parent.postMessage(msg, "*");
    } catch (e) {}
  }

  function section(i) {
    try {
      return ds && ds._slides ? ds._slides[i] : null;
    } catch (e) {
      return null;
    }
  }
  function attr(i, name) {
    var s = section(i);
    return s ? s.getAttribute(name) || "" : "";
  }

  function report() {
    if (!ds) return;
    var i = ds._index || 0;
    var total = ds._slides ? ds._slides.length : 0;
    post({
      type: "slidechange",
      index: i,
      total: total,
      label: attr(i, "data-label"),
      nextLabel: i + 1 < total ? attr(i + 1, "data-label") : "",
      notes: attr(i, "data-speaker-notes"),
      reason: lastReason,
    });
  }

  // ── Live pinboard: take over the showcase input + pinboard rendering so
  //    submissions go to the server (tagged with the viewer's name) and every
  //    device sees the same wall. ───────────────────────────────────────────
  function wireShowcase() {
    var input = document.querySelector("[data-shareinput]");
    var btn = document.querySelector("[data-sharesend]");
    if (!input || !btn || btn.__pbWired) return;
    // Clone to strip the prototype's own local-only handlers, then take over.
    var input2 = input.cloneNode(true);
    input.parentNode.replaceChild(input2, input);
    var btn2 = btn.cloneNode(true);
    btn.parentNode.replaceChild(btn2, btn);
    input2.__pbWired = btn2.__pbWired = true;
    function submit() {
      var url = (input2.value || "").trim();
      if (!url) return;
      post({ type: "pinboard:submit", url: url });
      input2.value = "";
      var list = document.querySelector("[data-sharelist]");
      if (list) {
        list.innerHTML = "";
        var chip = document.createElement("div");
        chip.textContent = "Shared to the pinboard ✓";
        chip.style.cssText =
          "font-size:16px;color:#2E8B5B;padding:8px 16px;background:rgba(46,139,91,0.12);border-radius:999px;font-family:'Outfit',sans-serif;";
        list.appendChild(chip);
      }
    }
    btn2.addEventListener("click", submit);
    input2.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    });
  }

  function renderPins(pins) {
    var board = document.querySelector("[data-pinboard]");
    if (!board) return;
    board.innerHTML = "";
    (pins || []).forEach(function (p, i) {
      if (!p || !p.url) return;
      var a = document.createElement("a");
      a.href = p.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.style.cssText =
        "display:block;width:212px;text-decoration:none;background:#FBFAF6;border-radius:10px;padding:16px 18px 15px;box-shadow:0 14px 26px -8px rgba(40,25,10,0.55);position:relative;transform:rotate(" +
        (i % 2 ? 1.6 : -1.6) +
        "deg);border:1px solid rgba(0,0,0,0.05);font-family:'Outfit',sans-serif;";
      var pin = document.createElement("span");
      pin.style.cssText =
        "position:absolute;top:-7px;left:50%;transform:translateX(-50%);width:15px;height:15px;border-radius:50%;background:#D24B3E;box-shadow:0 2px 5px rgba(0,0,0,0.35);";
      var nm = document.createElement("div");
      nm.textContent = p.name || "Someone";
      nm.style.cssText = "font-size:16px;font-weight:600;color:#2A2730;margin-bottom:6px;";
      var host = document.createElement("div");
      try {
        host.textContent = new URL(p.url).hostname.replace(/^www\./, "");
      } catch (e) {
        host.textContent = p.url;
      }
      host.style.cssText = "font-size:14px;font-weight:400;color:#2A6FDB;word-break:break-all;";
      a.appendChild(pin);
      a.appendChild(nm);
      a.appendChild(host);
      board.appendChild(a);
    });
  }

  function snapBackIfNeeded() {
    if (role === "viewer" && ds && ds._index > maxAllowed && typeof ds.goTo === "function") {
      ds.goTo(maxAllowed); // reason 'api' — allowed
    }
  }

  function patch() {
    if (patched || !ds || typeof ds._go !== "function") return;
    var origGo = ds._go.bind(ds);
    ds._go = function (i, reason) {
      if (role === "viewer" && reason !== "api" && reason !== "init") {
        if (locked) i = ds._index; // auto-follow: pinned to the presenter's slide
        else if (i > maxAllowed) i = maxAllowed; // free-roam up to the unlocked max
      }
      var r = origGo(i, reason);
      lastReason = reason || "api";
      report();
      return r;
    };
    patched = true;
    // Hide deck-stage's thumbnail rail everywhere (viewer + presenter). Its
    // shadow CSS `:host([no-rail]) .rail{display:none}` hides it even after the
    // rail was built, and reclaims the space for the slide.
    try {
      ds.setAttribute("no-rail", "");
    } catch (e) {}
    wireShowcase();
    lastReason = "init";
    report();
  }

  function boot() {
    ds = document.querySelector("deck-stage");
    if (ds && typeof ds._go === "function" && ds._slides && ds._slides.length) {
      patch();
      post({ type: "ready" });
      return;
    }
    setTimeout(boot, 60);
  }

  window.addEventListener("message", function (e) {
    var d = e.data;
    if (!d || d.source === "deck") return;
    if (d.type === "deck:role") {
      if (typeof d.role === "string") role = d.role;
      if (typeof d.max === "number") maxAllowed = d.max;
      if (typeof d.locked === "boolean") locked = d.locked;
      snapBackIfNeeded();
    } else if (d.type === "deck:max") {
      if (typeof d.max === "number") maxAllowed = d.max;
      snapBackIfNeeded();
    } else if (d.type === "deck:goto") {
      if (ds && typeof d.index === "number" && typeof ds.goTo === "function") ds.goTo(d.index);
    } else if (d.type === "deck:advance") {
      // Console Prev/Next — count as user navigation (reason 'click') so the
      // parent drives the session, unlike a followed 'api' move.
      if (ds && typeof ds._go === "function") {
        var cur = ds._index || 0;
        var target = cur + (d.dir > 0 ? 1 : -1);
        var tot = ds._slides ? ds._slides.length : 0;
        if (target >= 0 && target < tot) ds._go(target, "click");
      }
    } else if (d.type === "deck:report") {
      // Parent asking for the current state (covers the boot race where our
      // initial report fired before the parent's listener attached).
      if (ds && ds._slides && ds._slides.length) {
        lastReason = "sync";
        report();
      }
    } else if (d.type === "deck:pins") {
      wireShowcase(); // ensure the input is ours before pins start flowing
      renderPins(d.pins);
    }
  });

  // Forward user activity to the parent so it can auto-hide/reveal its overlay
  // controls even while the mouse is over this iframe.
  var lastAct = 0;
  function activity() {
    var now = Date.now();
    if (now - lastAct < 400) return;
    lastAct = now;
    post({ type: "activity" });
  }
  document.addEventListener("mousemove", activity, true);
  document.addEventListener("pointerdown", activity, true);
  document.addEventListener("keydown", activity, true);

  boot();
})();
