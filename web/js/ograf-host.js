// A small EBU OGraf v1 renderer: loads graphics from their manifests and plays a cue sheet in sync
// with the replay clock.
//
// - Continuous playback: real-time path. load() then playAction() at cue start, stopAction() and
//   dispose() at cue end. The stop is sent early enough, in wall time scaled by the playback speed,
//   for the out animation to end with the cue; it interrupts a running in animation. When an
//   animation would not fit in the cue at the current speed it is skipped, so a graphic always
//   leaves when its cue ends.
// - Seek, audience or language change: every graphic is disposed and the cues active at the new
//   time are rebuilt, except a cue whose graphic threw (_fail), which stays off until the page
//   reloads or its payload changes. Graphics with supportsNonRealTime get the non-real-time path:
//   setActionsSchedule([play at 0, stop at end]) and goToTime(cue-local ms) on every frame until the
//   cue ends. Others are loaded and played with skipAnimation.
// - A new cue sheet that leaves every graphic on screen as it was (the desk reached or approved a
//   story) is not a seek: the graphics stay, and the new cues come and go as in playback.
// - Convention: if a manifest declares the custom action "position", the host calls it every frame
//   with {x, y, visible}, the renderer-pixel position of data.player_id (the nameplate uses it).
// - At most MAX_ON_SCREEN graphics at once (docs/CONTRACT.md), counting those animating out.
// - Small frames (opts.compact() returns {deck, magnify}): with a deck element (a frame too small for
//   the graphics), graphics without "position" leave the pitch for it, one under the other, each scaled
//   so its box (the first element in its .stage, a Studio Desk graphic convention) fills the deck width
//   (a box narrower than DECK_BOX is scaled as if it were that wide).
//   Positioned graphics stay on the pitch, drawn `magnify` times larger around the same point.

const MAX_ON_SCREEN = 2;
const DECK_BOX = 720; // the compact box width (the graphics' .compact rules)
const failKey = (c) => `${c.cue_id}\n${JSON.stringify(c.payload)}`;

export class OGrafHost {
  /**
   * @param {HTMLElement} layer  overlay element, sized like the renderer resolution
   * @param {{resolution: {width: number, height: number}, frameRate: number,
   *          locate: (playerId: string, now: number) => {x: number, y: number, visible: boolean},
   *          vendorParams: () => object, compact?: () => ({deck: HTMLElement | null, magnify: number} | null),
   *          onError?: (graphic: string, err: Error) => void}} opts
   */
  constructor(layer, opts) {
    this.layer = layer;
    this.opts = opts;
    this.graphics = {};    // name -> {manifest, tag}
    this.live = new Map(); // cue_id -> instance
    this.leaving = new Set(); // instances still animating out
    this.taken = new Set(); // cue ids already taken off since the last rebuild: a speed change must not bring one back
    this.failed = new Set(); // cue id and payload of each cue whose graphic threw (_fail): never tried again, not even after a rebuild
    this.cues = [];
    this.last = null;
    this.speed = 1;
  }

  async register(name, manifestUrl) {
    const url = new URL(manifestUrl, document.baseURI);
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    const manifest = await r.json();
    const mod = await import(new URL(manifest.main, url));
    const tag = `ograf-${manifest.id}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    if (!customElements.get(tag)) customElements.define(tag, mod.default);
    const dur = (type) => Math.max(0, (manifest.actionDurations ?? []).find((d) => d.type === type)?.duration ?? 0) / 1000;
    this.graphics[name] = { manifest, tag, inS: dur("playAction"), outS: dur("stopAction") };
  }

  setCues(cues, now) {
    this.cues = cues.filter((c) => this.graphics[c.graphic]).sort((a, b) => a.ts - b.ts);
    const next = new Map(this.cues.map((c) => [c.cue_id, c]));
    const same = (a, b) => b && a.ts === b.ts && a.duration_s === b.duration_s && JSON.stringify(a.payload) === JSON.stringify(b.payload);
    const kept = this.last !== null && [...this.live.values()].every((inst) => same(inst.cue, next.get(inst.cue.cue_id)));
    this.sync(now, !kept, this.speed);
  }

  /** Call once per animation frame. seeked: the time jumped (not continuous playback); speed: match
   *  seconds per wall second. */
  sync(now, seeked = false, speed = 1) {
    this.speed = speed;
    this.step = this.last === null || seeked ? 0 : Math.max(0, now - this.last); // match seconds per frame
    if (seeked || this.last === null || now < this.last) this._rebuild(now);
    else this._advance(now);
    this.last = now;
    for (const inst of this.live.values()) {
      if (!inst.ready || inst.gone) continue;
      const fail = (e) => this._fail(inst, e);
      if (inst.mode === "non-realtime") Promise.resolve(inst.el.goToTime({ timestamp: (now - inst.cue.ts) * 1000 })).catch(fail);
      if (inst.positioned) Promise.resolve(inst.el.customAction({ id: "position", payload: this.opts.locate(inst.cue.payload.player_id, now) })).catch(fail);
    }
  }

  _end(c) { return c.ts + c.duration_s; }
  _visible() { return this.live.size + this.leaving.size; }
  // the out animation in match seconds at the current speed (plus one frame, as it starts on the
  // next one), or 0 when it does not fit in the cue
  _lead(c) { const lead = this.graphics[c.graphic].outS * this.speed + this.step; return lead < c.duration_s ? lead : 0; }

  _advance(now) {
    for (const [id, inst] of this.live) {
      const c = inst.cue, end = this._end(c), lead = this._lead(c);
      if (inst.mode === "realtime" && now >= end - lead) this._remove(id, lead > 0 && end - now >= 0.75 * lead);
      else if (now >= end) this._remove(id, false);
    }
    // hard deadline: an out animation running late (frames come late) is cut at the cue end
    for (const inst of this.leaving) {
      if (now >= this._end(inst.cue)) { inst.node.remove(); this.leaving.delete(inst); }
    }
    for (const c of this.cues) {
      if (c.ts > now || this._visible() >= MAX_ON_SCREEN) break;
      if (this.live.has(c.cue_id) || this.taken.has(c.cue_id) || now >= this._end(c) || this._failed(c)) continue;
      // a frame that lands inside the cue but past its stop time still shows it, without animation,
      // until the next frame: with slow frames at 16x the window between start and stop can fall between two
      const g = this.graphics[c.graphic], late = now >= this._end(c) - this._lead(c);
      this._add(c, now, "realtime", late || (g.inS + g.outS) * this.speed > c.duration_s);
    }
  }

  _rebuild(now) {
    for (const id of [...this.live.keys()]) this._remove(id, false);
    for (const inst of this.leaving) inst.node.remove();
    this.leaving.clear();
    this.taken.clear();
    for (const c of this.cues) {
      if (c.ts > now || this._visible() >= MAX_ON_SCREEN) break;
      if (now >= this._end(c) || this._failed(c)) continue;
      const g = this.graphics[c.graphic];
      if (g.manifest.supportsNonRealTime) this._add(c, now, "non-realtime");
      else if (now < this._end(c) - g.outS) this._add(c, now, "realtime", true);
    }
  }

  _add(cue, now, mode, skipAnimation) {
    const g = this.graphics[cue.graphic];
    const el = document.createElement(g.tag);
    const positioned = (g.manifest.customActions ?? []).some((a) => a.id === "position");
    const compact = this.opts.compact?.();
    let node = el, inner = null;
    if (compact?.deck && !positioned) {
      // deck item: a clip box, and inside it a full-size stage moved and scaled once the box is known
      node = document.createElement("div");
      node.className = "deck-item";
      node.style.visibility = "hidden";
      inner = node.appendChild(document.createElement("div"));
      inner.append(el);
      compact.deck.append(node);
    } else {
      if (positioned && compact?.magnify > 1) {
        Object.assign(el.style, { inset: "auto", left: "0", top: "0",
          width: `${this.opts.resolution.width * compact.magnify}px`, height: `${this.opts.resolution.height * compact.magnify}px` });
      }
      this.layer.append(el);
    }
    const inst = { cue, el, node, mode, ready: false, gone: false, positioned };
    const { width, height } = this.opts.resolution;
    const params = {
      data: structuredClone(cue.payload),
      renderType: mode,
      renderCharacteristics: { resolution: { width, height }, frameRate: this.opts.frameRate },
      ...this.opts.vendorParams(),
    };
    inst.loaded = el.load(params);
    // chain: settles once the graphic is on screen (played, or scheduled and at its time)
    inst.chain = inst.loaded.then(() => {
      if (inst.gone) return;
      inst.ready = true;
      if (inner) {
        const box = el.shadowRoot.querySelector(".stage")?.firstElementChild;
        // never past the scale a compact-width box would get: a narrow box (an early momentum card) would grow tall
        const k = node.clientWidth / Math.max(box?.offsetWidth || this.opts.resolution.width, DECK_BOX);
        inner.style.transform = `scale(${k}) translate(${-(box?.offsetLeft ?? 0)}px, ${-(box?.offsetTop ?? 0)}px)`;
        node.style.height = `${Math.ceil((box?.offsetHeight ?? this.opts.resolution.height) * k)}px`;
        node.style.visibility = "";
      }
      if (inst.positioned) Promise.resolve(el.customAction({ id: "position", payload: this.opts.locate(cue.payload.player_id, now) })).catch((e) => this._fail(inst, e));
      if (mode === "realtime") return el.playAction({ goto: 0, skipAnimation });
      const end = cue.duration_s * 1000;
      return el.setActionsSchedule({
        schedule: [
          { timestamp: 0, action: { type: "playAction", params: { goto: 0 } } },
          { timestamp: Math.max(0, end - g.outS * 1000), action: { type: "stopAction", params: {} } },
        ],
      }).then(() => inst.gone || el.goToTime({ timestamp: (now - cue.ts) * 1000 }));
    }).catch((e) => this._fail(inst, e));
    this.live.set(cue.cue_id, inst);
  }

  // A graphic that throws (load, render, play) is logged, named to the page once (opts.onError) and taken
  // off, so its slot frees; that cue is not tried again until the page reloads or its payload changes (an
  // edited card). An instance no longer on screen (a seek or its cue end came first) counts too, unless the
  // cue's payload changed since: then the failure is only logged.
  _fail(inst, err) {
    if (inst.failed) return;
    inst.failed = true;
    const id = inst.cue.cue_id, key = failKey(inst.cue);
    // reported once per payload: seeks while it loaded may have made several instances of it
    if (!this.failed.has(key)) {
      console.error(`OGraf graphic ${inst.cue.graphic} failed on cue ${id}:`, err);
      const cur = this.cues.find((c) => c.cue_id === id);
      if (!cur || failKey(cur) === key) {
        this.failed.add(key);
        this.opts.onError?.(inst.cue.graphic, err);
      }
    }
    if (this.live.get(id) !== inst) return;
    this._remove(id, false);
    this.taken.delete(id); // failed, not taken: the same cue with a new payload may come on at once
  }

  _failed(c) { return this.failed.size > 0 && this.failed.has(failKey(c)); }

  // The stop follows the load, not the in animation, so it can cut a running in animation short.
  // Without animation the element leaves the screen at once and is disposed when its load settles.
  _remove(id, animate) {
    const inst = this.live.get(id);
    this.live.delete(id);
    this.taken.add(id);
    inst.gone = true;
    if (animate) this.leaving.add(inst);
    else inst.node.remove();
    // a load that failed is reported by _add; a stop or dispose that fails (or throws) is only logged, the cue aired
    inst.loaded
      .then(async () => {
        try {
          await inst.el.stopAction(animate && inst.ready ? {} : { skipAnimation: true });
          await inst.el.dispose({});
        } catch (e) { console.error(`OGraf graphic ${inst.cue.graphic} failed to leave on cue ${inst.cue.cue_id}:`, e); }
      }, () => {})
      .finally(() => { inst.node.remove(); this.leaving.delete(inst); });
  }
}
