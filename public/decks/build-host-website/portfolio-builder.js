/* AI Portfolio Builder — deck-side overlay.
 *
 * A launch pill on the Hands-on slide's "Build" card opens a chat overlay that
 * talks to POST /api/portfolio (same-origin) and turns the assistant's fenced
 * ```html … ``` reply into a downloadable / previewable portfolio file.
 *
 * Self-contained vanilla JS, no dependencies. Written in the deck's own
 * hand-authored idiom (see bridge.js): IIFE, var, double quotes, cssText,
 * textContent. All message text is rendered via textContent — never innerHTML —
 * so neither AI nor user content can inject markup into the deck.
 *
 * Per-viewer local state only: nothing syncs across the presenter/projector.
 */
(function () {
  "use strict";

  // ── Palette (matches the deck) ────────────────────────────────────────────
  var INK = "#242129";
  var MUTED = "#A0998A";
  var ACCENT = "#BFE048";
  var FONT = "'Outfit',system-ui,sans-serif";
  var MONO = "ui-monospace,'JetBrains Mono',Menlo,monospace";
  var REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

  var GREETING =
    "Hi! I'm going to build your personal portfolio website — a real file " +
    "you'll download and publish today. First up: what's your name?";

  // ── Conversation state ────────────────────────────────────────────────────
  var messages = []; // full transcript {role, content}, oldest-first (incl. greeting)
  var styleSeed = ""; // pinned from the first response, resent every turn
  var inFlight = false; // one request at a time
  var built = false; // overlay DOM constructed?
  var els = {}; // cached element refs
  var pendingUserBubble = null; // the just-sent user bubble (removed on error)
  var typingBubble = null;
  var delegated = false; // document-level launch listener registered?
  var uid = ""; // stable per-browser id sent as `name` (rate-limit bucket)

  // What a generated ```html … ``` file is swapped for in the OUTBOUND transcript
  // ONLY — the real file stays in the UI. Keeps the payload tiny so the server's
  // total-chars budget never trips and the 40-message window never drops the
  // early interview answers; the model regenerates the full file each turn from
  // the retained facts + pinned styleSeed + accumulated tweak instructions.
  var HTML_MARKER = "\n[Generated the portfolio HTML file for the user.]\n";

  // ── Small helpers ─────────────────────────────────────────────────────────
  function userMsgCount() {
    var n = 0;
    for (var i = 0; i < messages.length; i++) if (messages[i].role === "user") n++;
    return n;
  }
  function currentName() {
    for (var i = 0; i < messages.length; i++) {
      if (messages[i].role === "user") return messages[i].content.trim().slice(0, 60);
    }
    return "";
  }
  function slugName() {
    var n = currentName().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return n || "my"; // fallback → "my-portfolio.html"
  }
  function scrollLog() {
    if (els.log) els.log.scrollTop = els.log.scrollHeight;
  }
  function focusInput() {
    if (els.input) els.input.focus();
  }
  function genId() {
    if (window.crypto && crypto.randomUUID) {
      try {
        return crypto.randomUUID();
      } catch (e) {}
    }
    return "pb-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }
  // A stable per-browser id, persisted so a room full of people who all answer
  // "skip" (or share a first name) each get their OWN identity rate-limit bucket
  // instead of colliding. Falls back to an in-memory id when localStorage is
  // unavailable (private mode, etc.).
  function stableId() {
    if (uid) return uid;
    try {
      uid = localStorage.getItem("pb_uid") || "";
      if (!uid) {
        uid = genId();
        localStorage.setItem("pb_uid", uid);
      }
    } catch (e) {
      uid = uid || genId();
    }
    return uid;
  }

  // ── One-time stylesheet (typing dots + entrance) ──────────────────────────
  function injectStyle() {
    if (document.getElementById("pb-style")) return;
    var s = document.createElement("style");
    s.id = "pb-style";
    s.textContent =
      "@keyframes pbBlink{0%,80%,100%{opacity:0.25}40%{opacity:1}}" +
      "@keyframes pbIn{from{opacity:0;transform:translateY(10px) scale(0.985)}to{opacity:1;transform:none}}" +
      ".pb-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:" +
      MUTED + ";margin:0 2px;animation:pbBlink 1.1s infinite}" +
      ".pb-dot:nth-child(2){animation-delay:0.18s}" +
      ".pb-dot:nth-child(3){animation-delay:0.36s}" +
      "@media (prefers-reduced-motion: reduce){.pb-dot,.pb-anim{animation:none!important;opacity:1!important}}";
    document.head.appendChild(s);
  }

  // ── Overlay construction (lazy, built once) ───────────────────────────────
  function buildOverlay() {
    if (built) return;
    injectStyle();

    // Backdrop — mounted at TOP LEVEL (body / fullscreen element), NOT inside the
    // deck's 1920px design canvas, so it isn't scaled to illegibility on a phone
    // and survives the presenter changing slides. Fixed + real viewport units.
    var overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;" +
      "justify-content:center;padding:16px;font-family:" + FONT + ";" +
      "background:rgba(236,234,227,0.96);backdrop-filter:blur(10px);" +
      "-webkit-backdrop-filter:blur(10px);";

    // Panel — sized in real viewport units so it's legible everywhere down to
    // 360px wide. The chat log (flex:1;min-height:0;overflow-y:auto) scrolls
    // internally; the composer stays pinned at the bottom.
    var panel = document.createElement("div");
    panel.style.cssText =
      "width:min(920px,94vw);height:min(88vh,900px);max-height:88vh;" +
      "flex:0 0 auto;box-sizing:border-box;background:#fff;border-radius:20px;" +
      "box-shadow:0 40px 90px -30px rgba(60,55,45,0.5);display:flex;" +
      "flex-direction:column;overflow:hidden;";
    if (!REDUCED) {
      panel.className = "pb-anim";
      panel.style.animation = "pbIn 0.28s cubic-bezier(0.22,1,0.36,1)";
    }

    // Header
    var header = document.createElement("div");
    header.style.cssText =
      "display:flex;align-items:flex-start;gap:16px;padding:24px 28px 18px;" +
      "border-bottom:1px solid rgba(38,36,42,0.08);flex:0 0 auto;";
    var htext = document.createElement("div");
    htext.style.cssText = "flex:1;min-width:0;";
    var title = document.createElement("div");
    title.textContent = "Portfolio Builder";
    title.style.cssText = "font-size:30px;font-weight:400;color:" + INK + ";line-height:1.1;";
    var sub = document.createElement("div");
    sub.textContent =
      "Answer a few questions — get a ready-to-publish portfolio site. " +
      "Reply ‘skip’ to skip any question, or ‘just build it’ any time.";
    sub.style.cssText =
      "font-size:16px;font-weight:300;color:#6E6A62;line-height:1.4;margin-top:6px;";
    htext.appendChild(title);
    htext.appendChild(sub);
    var close = document.createElement("button");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.textContent = "✕";
    close.style.cssText =
      "flex:0 0 auto;width:40px;height:40px;border-radius:12px;border:none;" +
      "cursor:pointer;background:rgba(38,36,42,0.06);color:" + INK + ";" +
      "font-size:20px;font-family:" + FONT + ";line-height:1;";
    close.addEventListener("click", closeOverlay);
    header.appendChild(htext);
    header.appendChild(close);

    // Chat log
    var log = document.createElement("div");
    log.style.cssText =
      "flex:1;min-height:0;overflow-y:auto;padding:22px 28px;display:flex;" +
      "flex-direction:column;gap:14px;";

    // Composer
    var composer = document.createElement("div");
    composer.style.cssText =
      "flex:0 0 auto;display:flex;gap:12px;align-items:center;padding:18px 24px 22px;" +
      "border-top:1px solid rgba(38,36,42,0.08);";
    var input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Type your answer…";
    input.style.cssText =
      "flex:1;min-width:0;font-family:" + FONT + ";font-size:18px;padding:13px 18px;" +
      "border-radius:999px;border:1px solid rgba(38,36,42,0.16);outline:none;" +
      "background:#FBFAF6;color:" + INK + ";";
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        send();
      }
    });
    var sendBtn = document.createElement("button");
    sendBtn.type = "button";
    sendBtn.textContent = "Send";
    sendBtn.style.cssText =
      "flex:0 0 auto;font-family:" + FONT + ";font-size:18px;font-weight:500;color:" +
      INK + ";background:" + ACCENT + ";border:none;border-radius:999px;" +
      "padding:13px 26px;cursor:pointer;";
    sendBtn.addEventListener("click", send);
    composer.appendChild(input);
    composer.appendChild(sendBtn);

    panel.appendChild(header);
    panel.appendChild(log);
    panel.appendChild(composer);
    overlay.appendChild(panel);

    // ── Event isolation: keep the deck from reacting while the builder is open.
    //   deck-stage binds keydown on window (nav keys) and click on the
    //   <deck-stage> element (touch tap-to-advance); neither is an <input>, so
    //   its own input-guard doesn't cover our buttons / scroll areas. Stop the
    //   events at the overlay before they bubble to those handlers. wheel/touch
    //   use stopPropagation only (no preventDefault) so inner scrolling works.
    overlay.addEventListener("keydown", function (e) {
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        closeOverlay();
      }
    });
    overlay.addEventListener("keyup", stop);
    overlay.addEventListener("keypress", stop);
    overlay.addEventListener("wheel", stop, { passive: true });
    overlay.addEventListener("touchstart", stop, { passive: true });
    overlay.addEventListener("touchmove", stop, { passive: true });
    overlay.addEventListener("click", stop);

    overlayHost().appendChild(overlay);
    els.overlay = overlay;
    els.log = log;
    els.input = input;
    els.sendBtn = sendBtn;
    built = true;

    // Seed the greeting: shown to the user AND kept in the transcript so the
    // model has the opening context (per the contract, we send the whole log).
    messages.push({ role: "assistant", content: GREETING });
    addBubble("assistant", GREETING);
  }

  function stop(e) {
    e.stopPropagation();
  }

  function overlayHost() {
    // Prefer the fullscreen element so the builder still shows while the deck is
    // presented in fullscreen; otherwise the document body.
    return document.fullscreenElement || document.body;
  }

  function isOpen() {
    return built && !!els.overlay && els.overlay.style.display !== "none";
  }

  function openOverlay() {
    // Single instance: build once (preserving conversation state across
    // reopens), otherwise just reveal the existing overlay.
    buildOverlay();
    if (!els.overlay) return;
    // Re-home under the current fullscreen target (or body) so it stays visible
    // if the deck entered/left fullscreen since it was built. Moving preserves
    // all DOM state and listeners.
    var host = overlayHost();
    if (els.overlay.parentNode !== host) host.appendChild(els.overlay);
    els.overlay.style.display = "flex";
    var focus = function () {
      focusInput();
    };
    if (REDUCED) focus();
    else requestAnimationFrame(focus);
  }

  function closeOverlay() {
    // Preserve all state — just hide. Conversation survives a reopen.
    if (els.overlay) els.overlay.style.display = "none";
  }

  // ── Safe minimal markdown → DOM (no innerHTML, ever) ──────────────────────
  // Inline pass over one line/paragraph: **bold** → <strong>, `code` → <code>.
  // A single regex walk emits text NODES for the gaps and element nodes (whose
  // .textContent is the captured text) for the matches, so no markup from the
  // model is ever parsed as HTML.
  function appendInline(target, text) {
    var re = /(\*\*([^*]+)\*\*|`([^`]+)`)/g;
    var last = 0;
    var m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) {
        target.appendChild(document.createTextNode(text.slice(last, m.index)));
      }
      if (m[2] != null) {
        var strong = document.createElement("strong");
        strong.style.cssText = "font-weight:600;";
        strong.textContent = m[2];
        target.appendChild(strong);
      } else {
        var code = document.createElement("code");
        code.style.cssText =
          "font-family:" + MONO + ";font-size:0.92em;background:rgba(38,36,42,0.07);" +
          "color:" + INK + ";padding:1px 5px;border-radius:5px;";
        code.textContent = m[3];
        target.appendChild(code);
      }
      last = re.lastIndex;
    }
    if (last < text.length) target.appendChild(document.createTextNode(text.slice(last)));
  }

  // Block pass: blank lines are SKIPPED (this collapses stray blank runs so the
  // bubble has no big vertical void); consecutive "- "/"* " lines become one
  // <ul> of <li>; everything else groups into paragraph <div>s. Successive
  // blocks get a small top margin so spacing reads as intentional.
  function renderMarkdownInto(el, text) {
    var lines = String(text).split(/\r?\n/);
    var i = 0;
    var firstBlock = true;
    while (i < lines.length) {
      if (!lines[i].trim()) {
        i++; // skip blank line
        continue;
      }
      if (/^\s*[-*]\s+/.test(lines[i])) {
        var ul = document.createElement("ul");
        ul.style.cssText =
          "margin:" + (firstBlock ? "0" : "8px") + " 0 0;padding-left:20px;" +
          "display:flex;flex-direction:column;gap:6px;";
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
          var li = document.createElement("li");
          appendInline(li, lines[i].replace(/^\s*[-*]\s+/, ""));
          ul.appendChild(li);
          i++;
        }
        el.appendChild(ul);
      } else if (/^\s{0,3}(#{1,6})\s+(.*\S)\s*#*\s*$/.test(lines[i])) {
        // A markdown heading (e.g. "### Next steps:"): render as a compact bold
        // BLOCK, never literal "###" text. The heading text runs through the same
        // inline pass (so **bold**/`code` inside a heading still render) and still
        // reaches the DOM via textContent/createTextNode — never innerHTML. Strip
        // the leading #'s (group 1) and any trailing #'s. Consumes just this line.
        var hMatch = lines[i].match(/^\s{0,3}(#{1,6})\s+(.*\S)\s*#*\s*$/);
        var hDiv = document.createElement("div");
        hDiv.style.cssText =
          "font-weight:600;font-size:1.05em;margin:" + (firstBlock ? "0" : "12px") + " 0 2px;";
        appendInline(hDiv, hMatch[2].replace(/\s*#+\s*$/, ""));
        el.appendChild(hDiv);
        i++; // a heading is a one-line block
      } else {
        var para = [];
        while (i < lines.length && lines[i].trim() && !/^\s*[-*]\s+/.test(lines[i])) {
          para.push(lines[i]);
          i++;
        }
        var div = document.createElement("div");
        if (!firstBlock) div.style.cssText = "margin-top:8px;";
        appendInline(div, para.join("\n"));
        el.appendChild(div);
      }
      firstBlock = false;
    }
    // Fallback: an all-blank string still gets its literal text.
    if (!el.firstChild) el.textContent = String(text);
  }

  // ── Bubbles ───────────────────────────────────────────────────────────────
  function addBubble(role, text) {
    var b = document.createElement("div");
    var base =
      "max-width:78%;padding:13px 17px;font-size:18px;line-height:1.5;" +
      "white-space:pre-wrap;overflow-wrap:anywhere;";
    if (role === "user") {
      b.style.cssText =
        base + "align-self:flex-end;background:rgba(191,224,72,0.28);color:" +
        INK + ";border-radius:16px 16px 4px 16px;";
      b.textContent = text; // literal — never innerHTML
    } else if (role === "error") {
      b.style.cssText =
        base + "align-self:flex-start;background:rgba(196,64,52,0.10);" +
        "color:#93392F;border:1px solid rgba(196,64,52,0.28);" +
        "border-radius:16px 16px 16px 4px;";
      b.textContent = text; // literal — never innerHTML
    } else {
      // Assistant: block structure controls layout, so drop the pre-wrap
      // reliance (keep overflow-wrap:anywhere for long tokens) and render the
      // safe markdown subset — still all textContent / createTextNode inside.
      b.style.cssText =
        "max-width:78%;padding:13px 17px;font-size:18px;line-height:1.5;" +
        "overflow-wrap:anywhere;align-self:flex-start;background:#F4F2EC;color:" +
        INK + ";border-radius:16px 16px 16px 4px;";
      renderMarkdownInto(b, text);
    }
    els.log.appendChild(b);
    scrollLog();
    return b;
  }

  function showTyping(label) {
    typingBubble = document.createElement("div");
    typingBubble.style.cssText =
      "align-self:flex-start;background:#F4F2EC;color:" + MUTED +
      ";border-radius:16px 16px 16px 4px;padding:13px 17px;font-size:17px;" +
      "line-height:1.5;display:flex;align-items:center;gap:8px;";
    var txt = document.createElement("span");
    txt.textContent = label;
    var dots = document.createElement("span");
    var d1 = document.createElement("span");
    d1.className = "pb-dot";
    var d2 = document.createElement("span");
    d2.className = "pb-dot";
    var d3 = document.createElement("span");
    d3.className = "pb-dot";
    dots.appendChild(d1);
    dots.appendChild(d2);
    dots.appendChild(d3);
    typingBubble.appendChild(txt);
    typingBubble.appendChild(dots);
    els.log.appendChild(typingBubble);
    scrollLog();
  }
  function hideTyping() {
    if (typingBubble && typingBubble.parentNode) typingBubble.parentNode.removeChild(typingBubble);
    typingBubble = null;
  }

  // ── Composer enable/disable ───────────────────────────────────────────────
  function setComposerEnabled(on) {
    if (!els.input) return;
    els.input.disabled = !on;
    els.sendBtn.disabled = !on;
    els.sendBtn.style.opacity = on ? "1" : "0.5";
    els.sendBtn.style.cursor = on ? "pointer" : "default";
  }

  // ── Send / request cycle ──────────────────────────────────────────────────
  function send() {
    if (inFlight) return;
    var text = els.input.value.trim();
    if (!text) return;
    els.input.value = "";
    messages.push({ role: "user", content: text });
    pendingUserBubble = addBubble("user", text);
    runTurn(text);
  }

  // Replace every generated ```html … ``` file (plus bare-fenced or unterminated
  // full-doc variants) in an ASSISTANT message with a short marker, so the
  // multi-KB file body is NEVER resent. Surrounding prose is kept. Applied ONLY
  // to the outbound copy — `messages` (and the action card's real code) stay
  // intact for Download / Copy / Preview.
  function stripGeneratedHtml(content) {
    var s = String(content);
    // Complete ```html … ``` blocks.
    s = s.replace(/```html[^\S\r\n]*\r?\n[\s\S]*?```/gi, HTML_MARKER);
    // Complete bare ``` … ``` blocks whose body is a full HTML document.
    s = s.replace(/```[^\S\r\n]*\r?\n([\s\S]*?)```/g, function (whole, inner) {
      return /^\s*(?:<!doctype\s+html|<html[\s>])/i.test(inner) ? HTML_MARKER : whole;
    });
    // A leftover unterminated fence that begins a (partial) HTML file.
    s = s.replace(/```(?:html)?[^\S\r\n]*\r?\n[\s\S]*$/i, function (tail) {
      return /<(?:!doctype\s+html|html[\s>])/i.test(tail) ? HTML_MARKER : tail;
    });
    return s;
  }

  function buildPayloadMessages() {
    var arr = [];
    for (var i = 0; i < messages.length; i++) {
      var m = messages[i];
      var content = m.role === "assistant" ? stripGeneratedHtml(m.content) : m.content;
      arr.push({ role: m.role, content: String(content).slice(0, 6000) });
    }
    if (arr.length > 40) arr = arr.slice(arr.length - 40); // keep the most recent 40
    return arr;
  }

  function callApi(signal) {
    var payload = { messages: buildPayloadMessages() };
    payload.name = stableId(); // stable per-browser id → its own rate-limit bucket
    if (styleSeed) payload.styleSeed = styleSeed; // pinned after the first reply
    return fetch("/api/portfolio", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: signal
    });
  }

  function runTurn(lastUserText) {
    inFlight = true;
    setComposerEnabled(false);
    var building = userMsgCount() >= 4 || /\bbuild\b/i.test(lastUserText);
    showTyping(building ? "Building your site — this can take a minute…" : "Thinking…");

    // Generation can take ~90s; never abort sooner than 120s.
    var ctrl = new AbortController();
    var timer = setTimeout(function () {
      ctrl.abort();
    }, 120000);

    callApi(ctrl.signal)
      .then(function (res) {
        return res.text().then(function (raw) {
          var body = null;
          try {
            body = JSON.parse(raw);
          } catch (e) {}
          return { res: res, body: body };
        });
      })
      .then(function (r) {
        clearTimeout(timer);
        hideTyping();
        if (r.res.ok && r.body && typeof r.body.reply === "string") {
          if (!styleSeed && r.body.styleSeed) styleSeed = r.body.styleSeed;
          pendingUserBubble = null;
          // renderReply decides whether to STORE the reply (a complete file or a
          // normal question) or treat it as a cut-off generation to retry.
          renderReply(r.body.reply, r.body.truncated === true, lastUserText);
          inFlight = false;
          setComposerEnabled(true);
          focusInput();
        } else if (r.res.status === 401 && r.body && r.body.error === "password_required") {
          // The room's AI is locked — offer an inline unlock and retry, keeping
          // the user's message in the transcript so the retry re-sends it.
          promptForPassword(lastUserText);
        } else {
          failTurn(messageForError(r.res.status, r.body), lastUserText);
        }
      })
      .catch(function () {
        clearTimeout(timer);
        hideTyping();
        failTurn("That didn't go through — try Send again.", lastUserText);
      });
  }

  // On failure: pop the failed user message back into the input and drop it
  // from the transcript (and from the log) so the next Send is a clean retry.
  function failTurn(msg, lastUserText) {
    for (var i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        messages.splice(i, 1);
        break;
      }
    }
    if (pendingUserBubble && pendingUserBubble.parentNode) {
      pendingUserBubble.parentNode.removeChild(pendingUserBubble);
    }
    pendingUserBubble = null;
    els.input.value = lastUserText;
    addBubble("error", msg);
    inFlight = false;
    setComposerEnabled(true);
    focusInput();
  }

  // Inline AI-access unlock (mirrors LiveChat's /api/ai-access POST). Shown when
  // the server returns 401 password_required; on {ok:true} we retry the same
  // turn — the user's message is still the last entry in `messages`.
  function promptForPassword(lastUserText) {
    inFlight = false;
    pendingUserBubble = null;
    setComposerEnabled(true);

    var card = document.createElement("div");
    card.style.cssText =
      "align-self:flex-start;max-width:88%;background:#F4F2EC;color:" + INK +
      ";border-radius:16px 16px 16px 4px;border:1px solid rgba(38,36,42,0.08);" +
      "padding:14px 17px;display:flex;flex-direction:column;gap:10px;";

    var t = document.createElement("div");
    t.textContent = "This room's AI is locked — enter the class password to keep going.";
    t.style.cssText = "font-size:18px;line-height:1.5;";
    card.appendChild(t);

    var row = document.createElement("div");
    row.style.cssText = "display:flex;gap:9px;flex-wrap:wrap;align-items:center;";
    var pw = document.createElement("input");
    pw.type = "password";
    pw.placeholder = "Class password";
    pw.autocomplete = "current-password";
    pw.style.cssText =
      "flex:1;min-width:140px;font-family:" + FONT + ";font-size:17px;padding:11px 15px;" +
      "border-radius:999px;border:1px solid rgba(38,36,42,0.16);outline:none;" +
      "background:#FBFAF6;color:" + INK + ";";
    var go = mkBtn("Unlock", true);
    row.appendChild(pw);
    row.appendChild(go);
    card.appendChild(row);

    var err = document.createElement("div");
    err.style.cssText = "font-size:15px;color:#93392F;display:none;";
    card.appendChild(err);

    els.log.appendChild(card);
    scrollLog();
    if (REDUCED) pw.focus();
    else requestAnimationFrame(function () { pw.focus(); });

    var busy = false;
    function fail(text) {
      err.textContent = text;
      err.style.display = "block";
      go.disabled = false;
      go.style.opacity = "1";
      go.style.cursor = "pointer";
      pw.disabled = false;
      busy = false;
      scrollLog();
    }
    function submit() {
      if (busy) return;
      var value = pw.value.trim();
      if (!value) return;
      busy = true;
      err.style.display = "none";
      go.disabled = true;
      go.style.opacity = "0.5";
      go.style.cursor = "default";
      pw.disabled = true;
      fetch("/api/ai-access", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: value })
      })
        .then(function (res) {
          return res.json().then(
            function (b) { return { ok: res.ok, body: b }; },
            function () { return { ok: res.ok, body: null }; }
          );
        })
        .then(function (r) {
          if (r.ok && r.body && r.body.ok) {
            if (card.parentNode) card.parentNode.removeChild(card);
            runTurn(lastUserText); // cookie is set now — resend the same turn
          } else if (r.body && r.body.error === "rate_limited") {
            fail("Too many attempts — wait a few minutes, then try again.");
          } else {
            fail("That password didn't work.");
          }
        })
        .catch(function () {
          fail("Couldn't check the password — try again.");
        });
    }
    go.addEventListener("click", submit);
    pw.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    });
  }

  function messageForError(status, body) {
    var err = body && body.error;
    if (err === "rate_limited") {
      var ra = body && body.retryAfter;
      return "The room's AI is a bit busy — try again in " + (ra != null ? ra : "a few") + "s.";
    }
    if (err === "ai_budget_exceeded") return "Today's AI budget is used up — ask the presenter.";
    if (err === "ai_not_configured") return "The AI isn't configured on this server.";
    if (err === "forbidden") return "The AI builder isn't available for you right now.";
    if (err === "bad_request") return "That didn't go through — try rephrasing and Send again.";
    if (err === "upstream_error" || err === "timeout" || err === "request_failed") {
      return "That didn't go through — try Send again.";
    }
    // Status fallbacks when the body has no recognised error field.
    if (status === 429) return "The room's AI is a bit busy — try again in a moment.";
    if (status === 503) return "The AI isn't configured on this server.";
    if (status === 403) return "The AI builder isn't available for you right now.";
    if (status === 401) return "Ask the presenter to unlock AI for the room, then Send again.";
    return "That didn't go through — try Send again.";
  }

  // ── Reply rendering + file detection ──────────────────────────────────────
  // Extract the LAST fenced ```html … ``` block. Returns { code, prose } where
  // prose is the reply with that block removed, or null if there's no block.
  function extractLastHtmlBlock(text) {
    var re = /```html[^\S\r\n]*\r?\n([\s\S]*?)```/gi;
    var m;
    var last = null;
    while ((m = re.exec(text)) !== null) last = m;
    if (!last) return null;
    var code = last[1].replace(/\s+$/, "");
    // Trim each side of the removed fence and drop empties before joining, so
    // the interior blank run around the fence can't survive as a gap.
    var prose = [text.slice(0, last.index), text.slice(last.index + last[0].length)]
      .map(function (s) { return s.trim(); })
      .filter(Boolean)
      .join("\n\n");
    return { code: code, prose: prose };
  }

  // Does the reply look like it starts a full HTML document?
  function looksLikeHtmlStart(s) {
    return /^\s*(?:<!doctype\s+html|<html[\s>])/i.test(String(s));
  }

  // A complete bare ``` … ``` fence (no / mislabeled language) that wraps a full
  // HTML doc — a fallback so a mislabeled fence still yields a download.
  function extractBareHtmlDoc(text) {
    var re = /```[^\S\r\n]*\r?\n([\s\S]*?)```/g;
    var m;
    var last = null;
    while ((m = re.exec(text)) !== null) {
      if (looksLikeHtmlStart(m[1])) last = m;
    }
    if (!last) return null;
    return {
      code: last[1].replace(/\s+$/, ""),
      prose: (text.slice(0, last.index) + text.slice(last.index + last[0].length)).trim()
    };
  }

  // Classify a reply: a complete file (render + action card), a cut-off
  // generation (never render raw code — offer a retry), or plain text.
  function analyzeReply(text, serverTruncated) {
    if (serverTruncated) return { kind: "truncated" }; // server said it was cut off
    var block = extractLastHtmlBlock(text); // complete ```html … ```
    if (block) return { kind: "file", code: block.code, prose: block.prose };

    var fences = (String(text).match(/```/g) || []).length;
    var unterminated = fences % 2 === 1; // an opener with no matching closer

    var bare = extractBareHtmlDoc(text);
    if (bare) return { kind: "file", code: bare.code, prose: bare.prose };

    // An unfenced but COMPLETE document (model dropped the fence entirely).
    if (!unterminated && looksLikeHtmlStart(text) && /<\/html\s*>/i.test(text)) {
      return { kind: "file", code: String(text).trim(), prose: "" };
    }

    // Cut off: an opening fence never closed, or raw HTML that starts a doc but
    // never finished it.
    if (unterminated || looksLikeHtmlStart(text)) return { kind: "truncated" };
    return { kind: "text" };
  }

  function renderReply(reply, serverTruncated, lastUserText) {
    var result = analyzeReply(reply, serverTruncated === true);
    if (result.kind === "file") {
      messages.push({ role: "assistant", content: reply }); // full file kept in UI state
      if (result.prose) addBubble("assistant", result.prose);
      addActionCard(result.code);
    } else if (result.kind === "truncated") {
      // Do NOT store the partial file, and never render raw code — offer a retry.
      addTruncatedNotice(lastUserText);
    } else {
      messages.push({ role: "assistant", content: reply });
      addBubble("assistant", reply);
    }
    scrollLog();
  }

  // Friendly "it got cut off" card with a one-tap Retry that re-sends the same
  // transcript (the last user turn is still in `messages`).
  function addTruncatedNotice(lastUserText) {
    var card = document.createElement("div");
    card.style.cssText =
      "align-self:flex-start;max-width:82%;background:#F4F2EC;color:" + INK +
      ";border-radius:16px 16px 16px 4px;border:1px solid rgba(38,36,42,0.08);" +
      "padding:14px 17px;display:flex;flex-direction:column;gap:10px;";
    var t = document.createElement("div");
    t.textContent =
      "That site got cut off before it finished — tap Retry, or type ‘just build it’ to try again.";
    t.style.cssText =
      "font-size:18px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere;";
    card.appendChild(t);
    var retry = mkBtn("↻ Retry", true);
    retry.style.alignSelf = "flex-start";
    retry.addEventListener("click", function () {
      if (inFlight || lastUserText == null) return;
      retry.disabled = true;
      retry.style.opacity = "0.5";
      retry.style.cursor = "default";
      runTurn(lastUserText);
    });
    card.appendChild(retry);
    els.log.appendChild(card);
    scrollLog();
  }

  // ── Action card: download / copy / preview + collapsible source ───────────
  function addActionCard(code) {
    var card = document.createElement("div");
    card.style.cssText =
      "align-self:flex-start;max-width:82%;background:#F4F2EC;color:" + INK +
      ";border-radius:16px;border:1px solid rgba(38,36,42,0.08);padding:16px 18px;" +
      "display:flex;flex-direction:column;gap:12px;";

    var head = document.createElement("div");
    head.textContent = "Your site is ready 🎉";
    head.style.cssText = "font-size:19px;font-weight:500;";
    card.appendChild(head);

    var btns = document.createElement("div");
    btns.style.cssText = "display:flex;flex-wrap:wrap;gap:9px;";

    var dl = mkBtn("⬇ Download portfolio.html", true);
    dl.addEventListener("click", function () {
      downloadCode(code);
    });
    var cp = mkBtn("Copy code", false);
    cp.addEventListener("click", function () {
      copyCode(code, cp);
    });
    var pv = mkBtn("Open preview", false);
    pv.addEventListener("click", function () {
      openPreview(code);
    });
    btns.appendChild(dl);
    btns.appendChild(cp);
    btns.appendChild(pv);
    card.appendChild(btns);

    var details = document.createElement("details");
    details.style.cssText = "margin-top:2px;";
    var summary = document.createElement("summary");
    summary.textContent = "View code";
    summary.style.cssText =
      "cursor:pointer;font-size:15px;color:#6E6A62;user-select:none;";
    var pre = document.createElement("pre");
    pre.textContent = code; // textContent — no markup injection
    pre.style.cssText =
      "margin:10px 0 0;font-family:" + MONO + ";font-size:12px;line-height:1.5;" +
      "max-height:200px;overflow:auto;background:#FBFAF6;color:#2A2730;" +
      "border:1px solid rgba(38,36,42,0.1);border-radius:10px;padding:12px 14px;" +
      "white-space:pre;";
    details.appendChild(summary);
    details.appendChild(pre);
    card.appendChild(details);

    els.log.appendChild(card);
    scrollLog();
  }

  function mkBtn(label, primary) {
    var b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.style.cssText =
      "font-family:" + FONT + ";font-size:15px;font-weight:500;cursor:pointer;" +
      "border-radius:999px;padding:11px 18px;min-height:40px;" +
      (primary
        ? "background:" + ACCENT + ";color:" + INK + ";border:none;"
        : "background:transparent;color:" + INK + ";border:1px solid rgba(38,36,42,0.2);");
    return b;
  }

  function downloadCode(code) {
    var blob = new Blob([code], { type: "text/html" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = slugName() + "-portfolio.html";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      if (a.parentNode) a.parentNode.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1000);
  }

  // Copy via the async Clipboard API with a textarea+execCommand fallback —
  // this runs inside a same-origin iframe where clipboard access can vary.
  function copyCode(code, btn) {
    var original = btn.textContent;
    var flash = function () {
      btn.textContent = "✓ Copied";
      setTimeout(function () {
        btn.textContent = original;
      }, 1400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(flash, function () {
        fallbackCopy(code, flash);
      });
    } else {
      fallbackCopy(code, flash);
    }
  }
  function fallbackCopy(code, ok) {
    var ta = document.createElement("textarea");
    ta.value = code;
    ta.style.cssText = "position:fixed;top:-9999px;left:-9999px;opacity:0;";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      if (document.execCommand("copy")) ok();
    } catch (e) {}
    if (ta.parentNode) ta.parentNode.removeChild(ta);
  }

  function openPreview(code) {
    var blob = new Blob([code], { type: "text/html" });
    var url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener");
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 60000);
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  // The launch button (#pb-launch) lives inside the Hands-on <section>, which
  // the deck runtime injects/activates AFTER DOMContentLoaded — and may later
  // re-clone or move nodes as slides mount. Binding straight to the element at
  // init would miss it (it isn't in the DOM yet), which left the button dead on
  // a fresh load. Instead register ONE delegated click listener on document
  // that finds the button whenever/wherever it mounts. Bubble phase (not
  // capture) so the per-element stopPropagation below still takes effect. init()
  // registers only — it must succeed even before the slide exists, so it never
  // early-returns on a missing button.
  function init() {
    if (delegated) return; // one-time registration
    delegated = true;
    document.addEventListener("click", function (e) {
      var t = e.target && e.target.closest && e.target.closest("#pb-launch");
      if (!t) return;
      // Don't let the launch tap advance the deck (touch tap-to-advance) or
      // reach the deck's other click handlers.
      e.preventDefault();
      e.stopPropagation();
      openOverlay();
    });
    // Keyboard, delegated on document: (1) Enter/Space on the focused launch pill
    // opens the builder and never leaks to the deck's window keydown (which would
    // otherwise advance the slide); (2) Escape closes the builder whenever it's
    // open, regardless of where focus is (the deck's own Escape stays intact when
    // it's closed because we only stop the event while open).
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && isOpen()) {
        e.preventDefault();
        e.stopPropagation();
        closeOverlay();
        return;
      }
      if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
        var t = e.target && e.target.closest && e.target.closest("#pb-launch");
        if (!t) return;
        e.preventDefault();
        e.stopPropagation();
        openOverlay();
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
