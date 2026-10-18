// A small EBU OGraf v1 renderer: loads graphics from their manifests and plays a cue sheet in sync
// with the replay clock.
//
// - Continuous playback: real-time path. load() then playAction() at cue start, stopAction() and
//   dispose() at cue end (the stop is sent early enough for the out animation to finish in time).
// - Seek, audience or language change: every graphic is disposed and the cues active at the new
//   time are rebuilt. Graphics with supportsNonRealTime get the non-real-time path:
//   setActionsSchedule([play at 0, stop at end]) and goToTime(cue-local ms) on every frame until the
//   cue ends. Others are loaded and played with skipAnimation.
// - Convention: if a manifest declares the custom action "position", the host calls it every frame
//   with {x, y, visible}, the renderer-pixel position of data.player_id (the nameplate uses it).
// - At most MAX_ON_SCREEN graphics at once (docs/CONTRACT.md).

const MAX_ON_SCREEN = 2;

export class OGrafHost {
  /**
   * @param {HTMLElement} layer  overlay element, sized like the renderer resolution
   * @param {{resolution: {width: number, height: number}, frameRate: number,
   *          locate: (playerId: string, now: number) => {x: number, y: number, visible: boolean},
   *          vendorParams: () => object}} opts
   */
  constructor(layer, opts) {
    this.layer = layer;
    this.opts = opts;
    this.graphics = {};    // name -> {manifest, tag}
    this.live = new Map(); // cue_id -> instance
    this.cues = [];
    this.last = null;
  }

  async register(name, manifestUrl) {
    const url = new URL(manifestUrl, document.baseURI);
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    const manifest = await r.json();
    const mod = await import(new URL(manifest.main, url));
    const tag = `ograf-${manifest.id}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    if (!customElements.get(tag)) customElements.define(tag, mod.default);
    const stop = (manifest.actionDurations ?? []).find((d) => d.type === "stopAction");
    this.graphics[name] = { manifest, tag, outS: Math.max(0, stop?.duration ?? 0) / 1000 };
  }

  setCues(cues, now) {
    this.cues = cues.filter((c) => this.graphics[c.graphic]).sort((a, b) => a.ts - b.ts);
    this.sync(now, true);
  }

  /** Call once per animation frame. seeked: the time jumped (not continuous playback). */
  sync(now, seeked = false) {
    if (seeked || this.last === null || now < this.last) this._rebuild(now);
    else this._advance(now);
    this.last = now;
    for (const inst of this.live.values()) {
      if (!inst.ready || inst.gone) continue;
      if (inst.mode === "non-realtime") inst.el.goToTime({ timestamp: (now - inst.cue.ts) * 1000 });
      if (inst.positioned) inst.el.customAction({ id: "position", payload: this.opts.locate(inst.cue.payload.player_id, now) });
    }
  }

  _end(c) { return c.ts + c.duration_s; }

  _advance(now) {
    for (const [id, inst] of this.live) {
      const g = this.graphics[inst.cue.graphic];
      const over = inst.mode === "realtime" ? now >= this._end(inst.cue) - g.outS : now >= this._end(inst.cue);
      if (over) this._remove(id, inst.mode === "realtime");
    }
    for (const c of this.cues) {
      if (c.ts > now) break;
      if (this.live.size >= MAX_ON_SCREEN) break;
      if (!this.live.has(c.cue_id) && now < this._end(c) - this.graphics[c.graphic].outS) this._add(c, now, "realtime", false);
    }
  }

  _rebuild(now) {
    for (const id of [...this.live.keys()]) this._remove(id, false);
    for (const c of this.cues) {
      if (c.ts > now || this.live.size >= MAX_ON_SCREEN) break;
      if (now >= this._end(c)) continue;
      const g = this.graphics[c.graphic];
      if (g.manifest.supportsNonRealTime) this._add(c, now, "non-realtime");
      else if (now < this._end(c) - g.outS) this._add(c, now, "realtime", true);
    }
  }

  _add(cue, now, mode, skipAnimation) {
    const g = this.graphics[cue.graphic];
    const el = document.createElement(g.tag);
    this.layer.append(el);
    const inst = {
      cue, el, mode, ready: false, gone: false,
      positioned: (g.manifest.customActions ?? []).some((a) => a.id === "position"),
    };
    const { width, height } = this.opts.resolution;
    const params = {
      data: structuredClone(cue.payload),
      renderType: mode,
      renderCharacteristics: { resolution: { width, height }, frameRate: this.opts.frameRate },
      ...this.opts.vendorParams(),
    };
    inst.chain = el.load(params).then(() => {
      if (inst.gone) return;
      inst.ready = true;
      if (inst.positioned) el.customAction({ id: "position", payload: this.opts.locate(cue.payload.player_id, now) });
      if (mode === "realtime") return el.playAction({ goto: 0, skipAnimation });
      const end = cue.duration_s * 1000;
      return el.setActionsSchedule({
        schedule: [
          { timestamp: 0, action: { type: "playAction", params: { goto: 0 } } },
          { timestamp: Math.max(0, end - g.outS * 1000), action: { type: "stopAction", params: {} } },
        ],
      }).then(() => el.goToTime({ timestamp: (now - cue.ts) * 1000 }));
    });
    this.live.set(cue.cue_id, inst);
  }

  _remove(id, animate) {
    const inst = this.live.get(id);
    this.live.delete(id);
    inst.gone = true;
    inst.chain = inst.chain
      .then(() => (animate && inst.ready ? inst.el.stopAction({}) : inst.el.stopAction({ skipAnimation: true })))
      .then(() => inst.el.dispose({}))
      .finally(() => inst.el.remove());
  }
}
